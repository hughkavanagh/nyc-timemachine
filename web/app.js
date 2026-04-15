// 1940s Lens — compass-aware "point to view".
//
// Flow:
//   1. Load photos.json (packed, ~18MB gzipped for the 4-borough export).
//   2. Show a centered "Enable location" button. On tap, request geolocation
//      + device-orientation permissions (iOS 13+ requires a user gesture).
//   3. Subscribe to GPS updates and compass heading. On desktop (no compass),
//      fall back to a 0–360 slider so the logic can be tested without a phone.
//   4. Each heading change: update the compass SVG + map bearing immediately
//      (cheap — just a transform). Schedule a candidate-scan on the next
//      animation frame, throttled to ~12 Hz, since the scan is O(n) over
//      561k rows and would otherwise block the compass from feeling snappy.
//   5. Render the best candidate full-bleed. Bottom card shows address;
//      minimap (top-right) shows position + facing direction + true north.
//
// Design choices:
//   - "In view" = within ±22° of heading, ≤120 m. Phone cameras see ~60–70°
//     horizontally, so ±22° is "clearly pointed at".
//   - Ranking: score = distance_m + 2.5 * abs(angle_deg). Closer + more
//     aligned wins. Tuned by eye; adjust after real-world testing.
//   - Scan is linear O(n). At 561k photos that's ~15 ms on an iPhone. Running
//     it at every 60 Hz orientation event was the main cause of laggy-feeling
//     compass — now it's decoupled from the render path.
//   - GPS in NYC street canyons is commonly off 20–40 m (enough to put you
//     on the wrong side of a block). We let the user TAP the minimap to
//     correct: that location becomes the effective position until they reset.

// ---------- Config ----------
const PHOTOS_URL = "/data/export/photos.json";
const ALTS_URL   = "/data/export/alternates.json";
// Main photo uses full-res; alternates strip still uses thumbnails.
const THUMB_BASE = "https://nycrecords.access.preservica.com/download/thumbnail";
const FULL_BASE  = "https://nycrecords.access.preservica.com/download/file";

const CONE_DEG   = 22;    // half-angle considered "pointed at"
const MAX_DIST_M = 120;   // max range for candidate buildings (dense NYC)
const NEIGHBOR_DIST_M = 160; // wider range for the prev/next peeks
const NEIGHBOR_ANG_DEG = 90; // prev/next must lie within ±90° of heading
const ANGLE_WEIGHT = 2.5; // ranking weight: 1° misalignment ≈ 2.5 m

// Map tile style. OpenFreeMap is free, no API key, attribution baked in.
const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";
// Zoom 16.5 shows ~2 blocks around the user — enough context to see which
// street you're on and correct a bad GPS fix by tapping the right one.
const MAP_ZOOM  = 16.5;

// Candidate scan is throttled — no faster than once every SCAN_MIN_MS.
// With 561k rows the scan takes ~15 ms on mobile, so 80 ms keeps us well
// under a 16 ms frame budget for rendering compass/map updates in between.
const SCAN_MIN_MS = 80;

// localStorage key for remembered state (position, heading, card collapse).
// Versioned so a future schema change can safely invalidate old entries.
const STATE_KEY = "1940sLens.state.v1";

// ?debug in URL exposes a tiny testing API (window.__tm.setPose).
const DEBUG = new URLSearchParams(location.search).has("debug");

// ---------- State ----------
let index = null;          // { columns, data } from photos.json
let alts  = null;          // { bbl: [io, io, ...] } from alternates.json
let userPos = null;        // { lat, lon, accuracy } or null — raw GPS
let manualOverride = null; // { lat, lon } or null — user-corrected position
let heading = null;        // degrees 0-360, or null
let hasCompass = false;
let currentIoIdx = 0;      // which alternate of current BBL we're showing
// Directional slide entry — the previous heading, and the direction the user
// last turned ("left" or "right"). New center slides fly in from whichever
// side the user is turning TOWARDS; outgoing center slides exit the other
// side. This is what makes the carousel feel like panning across a row of
// buildings rather than always entering from the right.
let lastHeading = null;
let lastTurnDir = "right";

// MapLibre minimap.
let map = null;
let mapReady = false;

// Throttle state for candidate scan.
let scanPending = false;
let lastScanTime = 0;

// Recently-viewed full-res URLs. Browser HTTP cache keeps the bytes; this Set
// is how we KNOW we've already paid for them so we can skip the thumbnail +
// shimmer and paint full-res immediately. Capped at 20 so memory stays tiny.
const RECENT_CAP = 20;
const recentFullSet = new Set();
const recentFullList = [];
function markRecent(url) {
  if (recentFullSet.has(url)) {
    const i = recentFullList.indexOf(url);
    if (i >= 0) recentFullList.splice(i, 1);
  }
  recentFullList.push(url);
  recentFullSet.add(url);
  while (recentFullList.length > RECENT_CAP) {
    recentFullSet.delete(recentFullList.shift());
  }
}

// ---------- DOM ----------
const el = (id) => document.getElementById(id);
const photoWrap     = el("photoWrap");
const emptyHint     = el("emptyHint");
const topPill       = el("topPill");
const bottomCard    = el("bottomCard");
const addrText      = el("addrText");
const subText       = el("subText");
const altsHintEl    = el("altsHint");
const altsStrip     = el("altsStrip");
const infoBtn       = el("infoBtn");
const infoPanel     = el("infoPanel");
const collapseBtn   = el("collapseBtn");
const centerBtn     = el("centerBtn");
const startBtn      = el("startBtn");
const desktopCtrl   = el("desktopCtrl");
const desktopCtrlLabel = el("desktopCtrlLabel");
const headingSlider = el("headingSlider");
const miniMap       = el("miniMap");
const miniMapGl     = el("miniMapGl");
const miniMapNorth  = el("miniMapNorth");
const miniMapReset  = el("miniMapReset");

// ---------- Geo math ----------
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function distMeters(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial bearing from (lat1,lon1) to (lat2,lon2), degrees 0-360 from north. */
function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * D2R, φ2 = lat2 * D2R;
  const Δλ = (lon2 - lon1) * D2R;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * R2D) + 360) % 360;
}

/** Signed angular difference in degrees, result in (-180, 180]. */
function angleDiff(a, b) {
  return ((a - b + 540) % 360) - 180;
}

/** Effective position: user's manual override if set, else raw GPS. */
function effectivePos() {
  if (manualOverride) return manualOverride;
  return userPos;
}

// ---------- Data load ----------
async function loadData() {
  const [pRes, aRes] = await Promise.all([
    fetch(PHOTOS_URL), fetch(ALTS_URL),
  ]);
  if (!pRes.ok) throw new Error(`photos.json ${pRes.status}`);
  index = await pRes.json();
  alts  = aRes.ok ? await aRes.json() : {};
}

// ---------- Candidate selection ----------
function colIdx() {
  return Object.fromEntries(index.columns.map((c, i) => [c, i]));
}

/**
 * Pick up to three adjacent-by-bearing candidates around the user's heading:
 *   - current: best-scored candidate within the view cone
 *   - prev:    the building at the next-lower bearing (peek on the left)
 *   - next:    the building at the next-higher bearing (peek on the right)
 *
 * Returns null if nothing lies in the view cone. Previous/next can be null
 * individually if there's nothing on that side.
 *
 * Deduped by BBL so two photos of the same building (alts) don't eat the
 * prev/next slots — alts still live inside the bottom-card strip.
 */
function pickTrio(lat, lon, hdg) {
  const c = colIdx();
  // First pass: buildings within a slightly expanded radius for peeks.
  const cands = [];
  for (const r of index.data) {
    const plat = r[c.lat], plon = r[c.lon];
    const d = distMeters(lat, lon, plat, plon);
    if (d > NEIGHBOR_DIST_M) continue;
    const b = bearingDeg(lat, lon, plat, plon);
    cands.push({ row: r, d, b });
  }
  if (!cands.length) return null;

  // Dedupe by BBL (keep closest photo per BBL).
  const perBbl = new Map();
  for (const x of cands) {
    const bbl = x.row[c.bbl];
    const existing = perBbl.get(bbl);
    if (!existing || x.d < existing.d) perBbl.set(bbl, x);
  }
  const uniq = Array.from(perBbl.values());

  // Signed angle from heading; keep only the forward half so buildings
  // behind the user don't count as "prev/next".
  for (const x of uniq) x.ang = angleDiff(x.b, hdg);
  const window = uniq.filter(x => Math.abs(x.ang) <= NEIGHBOR_ANG_DEG);
  window.sort((a, b) => a.ang - b.ang);
  if (!window.length) return null;

  // Pick current = best-scoring building within the view cone.
  let bestIdx = -1, bestScore = Infinity;
  for (let i = 0; i < window.length; i++) {
    const x = window[i];
    const absA = Math.abs(x.ang);
    if (absA > CONE_DEG) continue;
    if (x.d > MAX_DIST_M) continue;
    const s = x.d + ANGLE_WEIGHT * absA;
    if (s < bestScore) { bestScore = s; bestIdx = i; }
  }
  if (bestIdx < 0) return null; // nothing in cone

  const make = (i) => i >= 0 && i < window.length
    ? rowToPhoto(window[i].row, c, {
        distance: window[i].d,
        offset: Math.abs(window[i].ang),
        bearing: window[i].b,
      })
    : null;

  return {
    prev:    make(bestIdx - 1),
    current: make(bestIdx),
    next:    make(bestIdx + 1),
  };
}

/** Fallback: nearest-in-any-direction (for "turn around" hint). */
function nearestAny(lat, lon) {
  const c = colIdx();
  let best = null;
  for (const r of index.data) {
    const d = distMeters(lat, lon, r[c.lat], r[c.lon]);
    if (!best || d < best.d) best = { d, row: r };
  }
  if (!best) return null;
  return rowToPhoto(best.row, c, {
    distance: best.d,
    bearing: bearingDeg(lat, lon, best.row[c.lat], best.row[c.lon]),
  });
}

function rowToPhoto(row, c, extra = {}) {
  return {
    io: `IO_${row[c.io]}`,
    bbl: row[c.bbl],
    lat: row[c.lat],
    lon: row[c.lon],
    addr: row[c.addr] ?? null,
    matchType: row[c.mt] === 0 ? "exact" : "block",
    ...extra,
  };
}

// ---------- Rendering (3-slide carousel) ----------
//
// slideRegistry maps BBL -> { el, hasFullRes, role, io } for every slide
// currently in the DOM. We key by BBL (not by IO) so that when the user
// taps through alternates of the same building, or when GPS jitter flips
// which angle of a building is "closest", the same persistent DOM node
// survives — the image src swaps, but the slide doesn't get recreated and
// re-fly-in.
//
// On each scan we compute the desired trio (prev/current/next), then
// reconcile:
//   - Slides no longer in the trio get a .slot-far-* class and are
//     removed 400 ms later, after the CSS transition slides them offscreen.
//     Direction = opposite of the user's turn direction (if you turn right,
//     the stale slide exits to the LEFT of the viewport).
//   - Desired slides that aren't in the registry are freshly appended.
//     They START with a .slot-far-* class on the side matching the turn
//     direction (turn right → enter from right; turn left → enter from
//     left). A forced reflow, then the real role class, lets CSS animate
//     them into position.
//   - Existing slides just get their role class swapped — CSS handles
//     the transform/filter interpolation.
//
// This persistent-DOM approach is what makes the transitions smooth: a
// building that was "next" and becomes "center" has the SAME DOM node, so
// the transition fires on a class change rather than a node replacement.

let lastBbl = null;
const slideRegistry = new Map(); // bbl -> { el, hasFullRes, role, io }

function hideEmptyHint() { emptyHint.hidden = true; }
function showEmptyHint(text) { emptyHint.textContent = text; emptyHint.hidden = false; }

/**
 * Pick the entry class for a NEW slide appearing in `role`.
 * Prev/next slots always enter from their own side; center slides enter
 * from the direction of the user's last turn.
 */
function entryClassFor(role, turnDir) {
  if (role === "left")  return "slot-far-left";
  if (role === "right") return "slot-far-right";
  // role === "center" — enter from the turn direction.
  return turnDir === "left" ? "slot-far-left" : "slot-far-right";
}

/**
 * Pick the exit class for a slide LEAVING `oldRole`. Mirrors entryClassFor:
 * a prev that's leaving the left side exits left; a stale center exits to
 * the OPPOSITE side from the current turn (i.e. if the user is turning
 * right, the old center slides off to the left).
 */
function exitClassFor(oldRole, turnDir) {
  if (oldRole === "left")  return "slot-far-left";
  if (oldRole === "right") return "slot-far-right";
  return turnDir === "right" ? "slot-far-left" : "slot-far-right";
}

function renderTrio(trio) {
  hideEmptyHint();
  photoWrap.classList.remove("empty");

  // Build desired state: bbl -> { role, hit }.
  const desired = new Map();
  if (trio.prev)    desired.set(trio.prev.bbl,    { role: "left",   hit: trio.prev });
  if (trio.current) desired.set(trio.current.bbl, { role: "center", hit: trio.current });
  if (trio.next)    desired.set(trio.next.bbl,    { role: "right",  hit: trio.next });

  // 1. Remove slides that are no longer desired — slide them off in the
  //    direction opposite to the user's turn.
  for (const [bbl, sl] of slideRegistry) {
    if (desired.has(bbl)) continue;
    const exit = exitClassFor(sl.role, lastTurnDir);
    sl.el.classList.remove("slot-left", "slot-center", "slot-right", "slot-far-left", "slot-far-right");
    sl.el.classList.add(exit);
    const { el } = sl;
    setTimeout(() => el.remove(), 400);
    slideRegistry.delete(bbl);
  }

  // 2. Add or update desired slides.
  for (const [bbl, { role, hit }] of desired) {
    let sl = slideRegistry.get(bbl);
    if (!sl) {
      const el = createSlideEl(hit, role);
      // Enter from offscreen in the direction the user is turning toward.
      const entry = entryClassFor(role, lastTurnDir);
      el.classList.add(entry);
      photoWrap.appendChild(el);
      // Force layout so the browser registers the "far" position before
      // the transition to the real role class fires.
      void el.offsetWidth;
      el.classList.remove(entry);
      sl = { el, hasFullRes: false, role, io: hit.io };
      slideRegistry.set(bbl, sl);
    } else if (sl.io !== hit.io) {
      // Same building, different angle (alt). Swap image in place — no
      // entry animation, since the DOM node is surviving the transition.
      swapSlideImage(sl, hit);
      sl.io = hit.io;
      sl.hasFullRes = false;
    }
    sl.role = role;
    // Assign/swap role class — CSS transition animates the move.
    sl.el.classList.remove("slot-left", "slot-center", "slot-right", "slot-far-left", "slot-far-right", "slot-exit");
    sl.el.classList.add(`slot-${role}`);

    // Only the center slide bothers with full-res — side peeks are
    // blurred+dimmed, thumbnail quality is invisible there. When a slide
    // transitions into center, upgrade its src to full.
    if (role === "center" && !sl.hasFullRes) {
      upgradeToFullRes(sl, hit);
    }
  }

  // 3. Bottom card follows the center slide.
  if (trio.current) updateBottomCard(trio.current);
}

/**
 * Swap the image src on an existing slide to a different IO (same BBL,
 * different angle). Used when pickTrio picks a different alt as "closest"
 * for a BBL that was already on screen — we want the node to persist so
 * it doesn't re-animate in.
 */
function swapSlideImage(sl, hit) {
  const img = sl.el.querySelector("img");
  if (!img) return;
  const fullUrl  = `${FULL_BASE}/${hit.io}`;
  const thumbUrl = `${THUMB_BASE}/${hit.io}?fallback-thumbnail=1`;
  const cached = recentFullSet.has(fullUrl);
  img.dataset.target = fullUrl;
  img.src = cached ? fullUrl : thumbUrl;
  if (cached) markRecent(fullUrl);
}

function createSlideEl(hit, role) {
  const io = hit.io;
  const thumbUrl = `${THUMB_BASE}/${io}?fallback-thumbnail=1`;
  const fullUrl  = `${FULL_BASE}/${io}`;
  const cached   = recentFullSet.has(fullUrl);

  const el = document.createElement("div");
  el.className = "slide";
  el.dataset.io = io;

  // If we already have full-res cached and this is the center slot, go
  // straight to full. Otherwise start on the thumbnail; upgrade later.
  const startFull = cached && role === "center";
  const showShimmer = role === "center" && !cached;
  el.innerHTML = `
    <a href="${fullUrl}" target="_blank" rel="noopener">
      <img src="${startFull ? fullUrl : thumbUrl}"
           data-target="${fullUrl}"
           loading="lazy"
           alt="${escAttr(hit.addr ?? "")}">
      ${showShimmer ? `<div class="shimmer"></div>` : ""}
    </a>
  `;
  // If the thumbnail itself 404s (rare but happens), swap straight to full-res.
  const img = el.querySelector("img");
  img.addEventListener("error", () => {
    if (img.src !== fullUrl) img.src = fullUrl;
  }, { once: true });
  return el;
}

function upgradeToFullRes(sl, hit) {
  const fullUrl = `${FULL_BASE}/${hit.io}`;
  const img = sl.el.querySelector("img");
  if (!img) return;

  if (recentFullSet.has(fullUrl)) {
    if (img.src !== fullUrl) img.src = fullUrl;
    sl.hasFullRes = true;
    markRecent(fullUrl);
    return;
  }

  // Add shimmer if not already present, then preload full-res.
  const a = sl.el.querySelector("a");
  if (a && !sl.el.querySelector(".shimmer")) {
    a.insertAdjacentHTML("beforeend", `<div class="shimmer"></div>`);
  }
  const pre = new Image();
  pre.onload = () => {
    if (img.dataset.target !== fullUrl) return;
    img.src = fullUrl;
    sl.hasFullRes = true;
    const shim = sl.el.querySelector(".shimmer");
    if (shim) { shim.classList.add("fade-out"); setTimeout(() => shim.remove(), 240); }
    markRecent(fullUrl);
  };
  pre.onerror = () => {
    const shim = sl.el.querySelector(".shimmer");
    if (shim) shim.remove();
  };
  pre.src = fullUrl;
}

function clearAllSlides() {
  for (const [, sl] of slideRegistry) {
    sl.el.classList.remove("slot-left", "slot-center", "slot-right", "slot-far-left", "slot-far-right");
    sl.el.classList.add("slot-exit");
    const { el } = sl;
    setTimeout(() => el.remove(), 400);
  }
  slideRegistry.clear();
}

function updateBottomCard(hit) {
  if (hit.bbl !== lastBbl) {
    currentIoIdx = 0;
    lastBbl = hit.bbl;
  }
  const extra = alts[hit.bbl] ?? [];
  const ids = [stripIo(hit.io), ...extra];

  bottomCard.hidden = false;
  addrText.textContent = hit.addr ?? "Unknown address";
  subText.innerHTML = `${hit.distance.toFixed(0)} m away${manualOverride ? manualChipHtml() : ""}`;
  wireManualChipReset();

  if (ids.length > 1) {
    altsHintEl.hidden = false;
    altsHintEl.textContent = `${ids.length} angles of this building — tap below`;
    altsStrip.innerHTML = ids.map((id, i) => `
      <a href="#" class="${i === currentIoIdx ? "current" : ""}" data-i="${i}">
        <img src="${THUMB_BASE}/IO_${id}?fallback-thumbnail=1" alt="">
      </a>
    `).join("");
    altsStrip.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        currentIoIdx = Number(a.dataset.i);
        swapCenterAlt(hit, ids[currentIoIdx]);
        // Refresh the "current" indicator on the strip.
        altsStrip.querySelectorAll("a").forEach((a, i) => {
          a.classList.toggle("current", i === currentIoIdx);
        });
      });
    });
  } else {
    altsHintEl.hidden = true;
    altsStrip.innerHTML = "";
  }
}

// Swap the center slide's image to a different angle (same BBL) without
// disturbing the carousel. Used when the user taps an alternate thumbnail.
// Registry is keyed by BBL, so the center's DOM node is looked up by the
// hit's bbl rather than its IO — the IO is just what we're swapping TO.
function swapCenterAlt(hit, altId) {
  const sl = slideRegistry.get(hit.bbl);
  if (!sl) return;
  const newIo   = `IO_${altId}`;
  const fullUrl  = `${FULL_BASE}/${newIo}`;
  const thumbUrl = `${THUMB_BASE}/${newIo}?fallback-thumbnail=1`;
  const img = sl.el.querySelector("img");
  if (!img) return;
  const cached = recentFullSet.has(fullUrl);
  img.dataset.target = fullUrl;
  img.src = cached ? fullUrl : thumbUrl;
  sl.io = newIo;
  sl.hasFullRes = cached;
  if (cached) { markRecent(fullUrl); return; }
  const pre = new Image();
  pre.onload = () => {
    if (img.dataset.target !== fullUrl) return;
    img.src = fullUrl;
    sl.hasFullRes = true;
    markRecent(fullUrl);
  };
  pre.src = fullUrl;
}

function manualChipHtml() {
  return ` <span class="manualChip" id="manualChip" title="Tap to reset to GPS">📍 manual · reset</span>`;
}
function wireManualChipReset() {
  const chip = el("manualChip");
  if (chip) chip.addEventListener("click", clearManualOverride);
}

function escAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

function stripIo(io) { return io.startsWith("IO_") ? io.slice(3) : io; }

function renderNoCandidate(lat, lon, hdg) {
  clearAllSlides();
  photoWrap.classList.add("empty");
  lastBbl = null;

  // Tell the user what's going on — never leave the pane totally blank.
  const near = nearestAny(lat, lon);
  if (!near) {
    showEmptyHint("No 1940s photos nearby.\nThis map covers NYC.");
    bottomCard.hidden = true;
    return;
  }

  const hint = compassHint(angleDiff(near.bearing, hdg));
  // If we're clearly in NYC but nothing's in the view cone, encourage turning.
  if (near.distance < 300) {
    showEmptyHint("No 1940s photo in this direction.\nTry turning your phone.");
  } else {
    showEmptyHint("No 1940s photos right here.\nNearest is below.");
  }

  bottomCard.hidden = false;
  addrText.textContent = near.addr ?? "Nearest photo";
  subText.innerHTML = `${near.distance.toFixed(0)} m · ${hint}${manualOverride ? manualChipHtml() : ""}`;
  wireManualChipReset();
  altsHintEl.hidden = true;
  altsStrip.innerHTML = "";
}

function compassHint(diff) {
  const abs = Math.abs(diff);
  if (abs < 15) return "straight ahead";
  const dir = diff > 0 ? "right" : "left";
  if (abs < 45) return `slightly to your ${dir}`;
  if (abs < 135) return `to your ${dir}`;
  return "behind you";
}

// ---------- Heading / position update pipeline ----------
//
// These run in two speeds:
//   FAST (every event): compass SVG rotate, map bearing, N label placement.
//     Just CSS transforms — cheap enough to do at ~60 Hz.
//   SLOW (throttled): the O(n) candidate scan. Scheduled on rAF, but no
//     faster than SCAN_MIN_MS to avoid starving the fast-path renders.
//
// This is the key fix for the "compass feels laggy" problem — previously,
// every orientation event ran a full 561k-row scan, which dropped frames
// and made the compass feel delayed.

function onHeadingChange(h) {
  // Track turn direction from signed heading delta. Small deltas (<0.3°) are
  // gyro noise — ignore them so the turn direction doesn't flap on every
  // micro-jitter. Positive delta = turning right (clockwise, bearing grows);
  // negative = turning left.
  if (lastHeading != null) {
    const delta = angleDiff(h, lastHeading);
    if (Math.abs(delta) > 0.3) {
      lastTurnDir = delta > 0 ? "right" : "left";
    }
  }
  lastHeading = h;

  heading = h;
  // Map: rotate the tiles so the user's facing direction is UP. This is
  // Google-Maps-style orientation. The N badge around the ring shows
  // where true north is.
  if (mapReady) {
    map.setBearing(h);
    placeNorthLabel(h);
  }
  requestScan();
  persistState();
}

function onPositionChange(newPos) {
  userPos = newPos;
  centerBtn.hidden = true;
  // If no manual override, keep the map centered on GPS.
  if (mapReady && !manualOverride) {
    map.jumpTo({ center: [newPos.lon, newPos.lat] });
  }
  requestScan();
  persistState();
}

function requestScan() {
  if (scanPending) return;
  scanPending = true;
  const now = performance.now();
  const wait = Math.max(0, SCAN_MIN_MS - (now - lastScanTime));
  setTimeout(() => {
    scanPending = false;
    lastScanTime = performance.now();
    runCandidateScan();
  }, wait);
}

function runCandidateScan() {
  const pos = effectivePos();
  if (!pos || heading == null || !index) return;
  const trio = pickTrio(pos.lat, pos.lon, heading);
  if (trio) renderTrio(trio);
  else renderNoCandidate(pos.lat, pos.lon, heading);
}

// ---------- Minimap ----------
//
// Initialises once, after MapLibre is loaded and we have SOMETHING to show
// (either a restored position or a live GPS fix). The tiles themselves rotate
// via map.setBearing(); the user dot and the facing cone are DOM elements
// fixed at the minimap center; the "N" badge is a DOM element we reposition
// on a circle around the center so it always points to true north.

function initMap() {
  if (typeof maplibregl === "undefined") {
    // Script hasn't arrived yet — try again shortly.
    setTimeout(initMap, 250);
    return;
  }
  if (map) return;

  const pos = effectivePos() ?? { lat: 40.7128, lon: -74.006 };
  map = new maplibregl.Map({
    container: "miniMapGl",
    style: MAP_STYLE,
    center: [pos.lon, pos.lat],
    zoom: MAP_ZOOM,
    bearing: heading ?? 0,
    pitch: 0,
    interactive: false,      // no pan/zoom — we want the tap handler instead
    attributionControl: false,
    fadeDuration: 0,
  });

  map.on("load", () => {
    mapReady = true;
    miniMap.hidden = false;
    placeNorthLabel(heading ?? 0);
    cleanupMapStyle();
  });
  // If the style fails (network blip), log and keep the rest of the app alive.
  map.on("error", (e) => console.warn("[minimap]", e?.error?.message || e));

  // Tap-to-correct: one of the only useful workarounds for GPS error in the
  // NYC street canyon. User taps the street they're actually on; that becomes
  // the effective position until they reset.
  bindMinimapTap();
}

// Distinguishes "tap" from "drag" (ignore drags) and "long press" (ignore).
function bindMinimapTap() {
  let down = null;
  miniMapGl.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  miniMapGl.addEventListener("pointerup", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    const dt = performance.now() - down.t;
    down = null;
    if (Math.hypot(dx, dy) > 10) return;  // drag
    if (dt > 500) return;                 // long press
    if (!map) return;
    const rect = miniMapGl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const lngLat = map.unproject([x, y]);
    setManualOverride(lngLat.lat, lngLat.lng);
  });
}

function setManualOverride(lat, lon) {
  manualOverride = { lat, lon };
  if (mapReady) map.jumpTo({ center: [lon, lat] });
  miniMapReset.hidden = false;
  requestScan();
  persistState();
}

function clearManualOverride() {
  manualOverride = null;
  miniMapReset.hidden = true;
  const pos = effectivePos();
  if (pos && mapReady) map.jumpTo({ center: [pos.lon, pos.lat] });
  requestScan();
  persistState();
}

// Place the "N" badge on the circle edge at the angle where true north lies,
// given the current heading. When heading=0 (facing north) N is at the top;
// when heading=90 (east) N is to the left; heading=270 (west) N is right.
function placeNorthLabel(h) {
  if (!miniMapNorth) return;
  const r = 58; // radius in px — sits on the ring of the 110 px minimap
  const b = h * Math.PI / 180;
  const x = -r * Math.sin(b);
  const y = -r * Math.cos(b);
  miniMapNorth.style.transform = `translate(${x}px, ${y}px)`;
}

// Post-load tweak: (a) brighten road fills to clean white so street-level
// detail is readable on a 110 px porthole, and (b) hide the dark "casing"
// layers (the outline lines that flank every road) because once the fill
// is white, the casings read as distracting dotted white lines on either
// side of every street. Matched by layer-id heuristic — OpenFreeMap uses
// names like `highway_primary`, `highway_primary_casing`, etc.
function cleanupMapStyle() {
  if (!map) return;
  const style = map.getStyle();
  if (!style?.layers) return;
  for (const layer of style.layers) {
    if (layer.type !== "line") continue;
    const id = (layer.id || "").toLowerCase();
    const isRoadish = /(highway|road|street|path|motorway|trunk|primary|secondary|tertiary|residential|service|transportation)/.test(id);
    if (!isRoadish) continue;
    const isCasing = /(casing|outline|bridge_casing|tunnel_casing)/.test(id);
    try {
      if (isCasing) {
        map.setLayoutProperty(layer.id, "visibility", "none");
      } else {
        map.setPaintProperty(layer.id, "line-color", "#f2f2f2");
        map.setPaintProperty(layer.id, "line-opacity", 1);
      }
    } catch { /* some layers don't accept updates — ignore */ }
  }
}

// ---------- Permissions / sources ----------
function watchGps() {
  navigator.geolocation.watchPosition(
    (pos) => {
      onPositionChange({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      });
    },
    (err) => showLocationError(err.message),
    { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 }
  );
}

function installCompass() {
  const needsIosPerm =
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function";

  // Single handler for both event variants — dedup so we don't fire twice on
  // devices that support both (was a subtle cause of extra work).
  const handler = (e) => {
    let h = null;
    if (e.webkitCompassHeading != null) {
      h = e.webkitCompassHeading;        // iOS: true-north, CW
    } else if (e.alpha != null) {
      h = (360 - e.alpha) % 360;         // Android: alpha is CCW from north
    }
    if (h != null) onHeadingChange(h);
  };

  const listen = () => {
    hasCompass = true;
    // Prefer absolute (true-north) where available; otherwise deviceorientation
    // (on iOS that's where webkitCompassHeading lives).
    if ("ondeviceorientationabsolute" in window) {
      window.addEventListener("deviceorientationabsolute", handler, true);
    } else {
      window.addEventListener("deviceorientation", handler);
    }
  };

  if (needsIosPerm) {
    DeviceOrientationEvent.requestPermission().then((state) => {
      if (state === "granted") listen();
      else installSlider("Compass denied — drag to change heading");
    }).catch(() => installSlider("Compass unavailable — drag to change heading"));
  } else if ("DeviceOrientationEvent" in window) {
    listen();
    setTimeout(() => { if (!hasCompass) installSlider(); }, 2000);
  } else {
    installSlider();
  }
}

function installSlider(reason = "No compass — drag to change heading") {
  desktopCtrl.style.display = "block";
  desktopCtrlLabel.textContent = reason;
  if (heading == null) heading = 0;
  headingSlider.value = heading;
  headingSlider.addEventListener("input", (e) => {
    onHeadingChange(Number(e.target.value));
  });
  onHeadingChange(heading);
}

function showLocationError(msg) {
  centerBtn.hidden = false;
  startBtn.textContent = "Enable location";
  startBtn.title = msg;
  showEmptyHint("Couldn't get your location.\nTap the button to try again.");
}

// ---------- State persistence (localStorage) ----------
//
// Survives tab close / app backgrounding. We don't try to auto-skip the
// permission gesture — iOS still requires a tap for DeviceOrientation — but
// we do show the map immediately with the last-known position so the app
// doesn't feel like it's "starting from zero" every time.

function persistState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      pos: userPos ? { lat: userPos.lat, lon: userPos.lon } : null,
      manual: manualOverride,
      heading,
      cardCollapsed: bottomCard.classList.contains("collapsed"),
    }));
  } catch { /* private mode, full disk, etc. — silently skip */ }
}

function restoreState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
    if (s.pos && Number.isFinite(s.pos.lat) && Number.isFinite(s.pos.lon)) {
      userPos = { lat: s.pos.lat, lon: s.pos.lon, accuracy: 9999 };
    }
    if (s.manual && Number.isFinite(s.manual.lat) && Number.isFinite(s.manual.lon)) {
      manualOverride = s.manual;
    }
    if (Number.isFinite(s.heading)) heading = s.heading;
    if (s.cardCollapsed) bottomCard.classList.add("collapsed");
  } catch { /* ignore */ }
}

// ---------- Bottom card interactions ----------
collapseBtn.addEventListener("click", () => {
  bottomCard.classList.toggle("collapsed");
  const collapsed = bottomCard.classList.contains("collapsed");
  collapseBtn.setAttribute("aria-label", collapsed ? "Expand" : "Collapse");
  if (collapsed) infoPanel.hidden = true;
  persistState();
});

infoBtn.addEventListener("click", () => {
  bottomCard.classList.remove("collapsed");
  collapseBtn.setAttribute("aria-label", "Collapse");
  infoPanel.hidden = !infoPanel.hidden;
  persistState();
});

miniMapReset.addEventListener("click", clearManualOverride);

// ---------- Startup ----------
startBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    startBtn.textContent = "Geolocation unavailable";
    startBtn.disabled = true;
    return;
  }
  // Android supports portrait lock; Safari iOS silently rejects it. The CSS
  // landscape-overlay (#rotateHint) covers the iOS case.
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock("portrait").catch(() => {});
  }
  startBtn.textContent = "Getting location…";
  startBtn.disabled = true;

  // Immediate empty-hint so the black pane doesn't look broken.
  showEmptyHint("Getting your location…");

  watchGps();
  installCompass();
  initMap();
});

// Boot sequence:
//   1. Restore any saved state (renders card-collapsed if it was last time).
//   2. Show an initial hint on the black pane so the user knows what to do.
//   3. Kick off data load in the background. When it finishes AND we have a
//      position + heading, the first candidate scan runs.
restoreState();

// If the previous session had a manual location override, surface the reset
// button so the user remembers and can go back to raw GPS.
if (manualOverride) miniMapReset.hidden = false;

// If we have a saved position, we can show the minimap immediately — even
// before the first fresh GPS fix — which makes the return-visit feel fast.
if (userPos || manualOverride) {
  // MapLibre needs the script loaded; it will retry itself if not.
  initMap();
}

// Default pre-start message. The button is also there; this supplements it.
showEmptyHint("Point your phone at a building\nto see it in the 1940s.");

loadData().then(() => {
  // If state was restored AND permissions previously granted, a fresh GPS
  // fix + orientation event will kick off the first scan automatically.
  // Otherwise we wait for the button tap.
  if (userPos && heading != null) requestScan();
}).catch((e) => {
  startBtn.textContent = `Load failed: ${e.message}`;
  startBtn.disabled = true;
  showEmptyHint(`Couldn't load photos.\n${e.message}`);
});

// In DEBUG mode, expose a tiny API for scripted testing.
if (DEBUG) {
  window.__tm = {
    setPose(lat, lon, hdg) {
      onPositionChange({ lat, lon, accuracy: 5 });
      onHeadingChange(hdg);
    },
    override(lat, lon) { setManualOverride(lat, lon); },
    reset() { clearManualOverride(); },
    get state() { return { userPos, manualOverride, heading, currentIoIdx }; },
  };
}
