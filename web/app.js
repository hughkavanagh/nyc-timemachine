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

// Candidate selection uses a corridor, not a cone. The corridor is a strip
// running along the user's heading ray, with a half-width measured
// perpendicular to the heading (in meters). This matches physical intuition:
// a building is "pointed at" if your line-of-sight passes within a few
// meters of it, regardless of distance. The old cone approach over-rejected
// close, slightly-off-axis buildings and accepted distant nearly-aligned
// ones — geometrically backwards.
const CORRIDOR_HALFWIDTH_M          = 10;  // primary: first building in line-of-sight
const CORRIDOR_FALLBACK_HALFWIDTH_M = 22;  // "neighbor's neighbor" wider strip
const MAX_DIST_M                    = 120; // max forward distance for trio selection
const NEIGHBOR_DIST_M               = 200; // outer radius: everything we might consider

// Map tile style. OpenFreeMap is free, no API key, attribution baked in.
const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";
// Zoom 15.2 shows ~6 surrounding blocks on the 110 px porthole — enough
// context to see your cross-streets and swipe the pin cleanly.
const MAP_ZOOM  = 15.2;

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
// True while the user is mid-drag on the minimap. Suppresses GPS-driven
// recentering so their finger doesn't get yanked off the location they're
// sliding the pin toward.
let isDraggingMinimap = false;

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

// Radius (m) inside which we look at neighboring buildings to infer which
// street the user is ON. 35 m easily covers both sides of an NYC street
// (most are 15–25 m wide curb-to-curb) without bleeding into buildings on
// the next parallel avenue.
const USER_STREET_RADIUS_M = 35;

/**
 * Extract a street name from a MapPLUTO-style address like "123 PRINCE ST"
 * or "456-460 BROADWAY". Returns uppercase street name (unit-agnostic), or
 * null if we can't parse one. Used for same-street filtering.
 */
function extractStreet(addr) {
  if (!addr) return null;
  const s = String(addr).trim().toUpperCase();
  if (!s) return null;
  // Drop the leading house-number token(s). MapPLUTO formats are things
  // like "123 PRINCE ST", "123-125 PRINCE ST", "123A PRINCE ST".
  const m = s.match(/^[\d][\dA-Z\-\/]*\s+(.+)$/);
  const street = m ? m[1] : s;
  return street.trim() || null;
}

/**
 * Decide what to show. Returns one of:
 *   { mode: "trio", prev, current, next }
 *     — The sweet case. `current` is a building in the user's line-of-sight
 *       corridor. `prev`/`next` are its ang-adjacent neighbors for the
 *       carousel peeks.
 *   { mode: "peek", peekLeft, peekRight }
 *     — No building lies in a plausible corridor, but photos DO exist to
 *       the user's left and/or right. The UI shows 10-15% slivers of those
 *       images at the screen edges so the user knows which way to turn.
 *   null
 *     — Nothing within NEIGHBOR_DIST_M after street-filtering.
 *
 * The ranking within "trio" mode uses a CORRIDOR, not a cone:
 *   perp (m) = d * sin(ang_deg)   -- perpendicular from heading ray
 *   fwd  (m) = d * cos(ang_deg)   -- forward distance along heading ray
 *
 * A building is "in the corridor" if |perp| < halfwidth and fwd > 0. Among
 * those we pick the CLOSEST forward building — i.e. the first one your
 * eye meets along the ray. This is far more accurate than
 * `distance + k*angle`: a near-miss from 10 m away won't get outranked by
 * a perfectly-aligned building 80 m down the block.
 *
 * Cascade:
 *   1. Tight corridor (perp ≤ 10 m): sweet spot.
 *   2. Widened corridor (perp ≤ 22 m): catches a next-door neighbor if the
 *      exact building you're pointing at isn't in our photo index.
 *   3. Peek mode: no hit even in the wide corridor. Surface the nearest
 *      same-street photo on each side so the user knows to turn.
 *
 * Same-street filter is applied up front — if the user is mid-block on
 * Prince St, Broadway candidates at the end of the block are excluded
 * (unless the user is standing at the corner, in which case the nearby
 * buildings vote for both streets and both sets are kept).
 */
function pickScene(lat, lon, hdg) {
  const c = colIdx();
  // First pass: collect candidates AND tally which streets are within the
  // "user is on this street" radius. One loop; keeping both passes folded
  // together so we don't iterate 561k rows twice per scan.
  const cands = [];
  const streetTally = new Map(); // streetName -> count within USER_STREET_RADIUS_M
  for (const r of index.data) {
    const plat = r[c.lat], plon = r[c.lon];
    const d = distMeters(lat, lon, plat, plon);
    if (d > NEIGHBOR_DIST_M) continue;
    const b = bearingDeg(lat, lon, plat, plon);
    cands.push({ row: r, d, b });
    if (d <= USER_STREET_RADIUS_M) {
      const s = extractStreet(r[c.addr]);
      if (s) streetTally.set(s, (streetTally.get(s) || 0) + 1);
    }
  }
  if (!cands.length) return null;

  // Determine the user's "street set". If one street dominates, use only it.
  // If two streets are comparably represented (user at a corner), keep both.
  // No street data nearby → skip the filter (be lenient, show the best we have).
  let userStreetSet = null;
  if (streetTally.size > 0) {
    const ranked = [...streetTally.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0][1];
    // Keep streets with at least half the top count (min 2 hits to count as
    // a "real" cross-street — one stray parcel shouldn't unlock an avenue).
    const keep = ranked.filter(([, n]) => n === top || n >= Math.max(2, top / 2))
                       .slice(0, 2)
                       .map(([s]) => s);
    userStreetSet = new Set(keep);
  }

  // Dedupe by BBL (keep closest photo per BBL).
  const perBbl = new Map();
  for (const x of cands) {
    const bbl = x.row[c.bbl];
    const existing = perBbl.get(bbl);
    if (!existing || x.d < existing.d) perBbl.set(bbl, x);
  }
  let uniq = Array.from(perBbl.values());

  // Apply same-street filter. A candidate whose address doesn't parse is
  // KEPT (we don't punish bad data), but anything on a clearly-different
  // street is dropped.
  if (userStreetSet && userStreetSet.size > 0) {
    uniq = uniq.filter(x => {
      const s = extractStreet(x.row[c.addr]);
      return !s || userStreetSet.has(s);
    });
    if (!uniq.length) return null;
  }

  // Compute angle / perp / fwd for every candidate, and drop the back half.
  for (const x of uniq) {
    x.ang = angleDiff(x.b, hdg);
    const angR = x.ang * D2R;
    x.perp = x.d * Math.sin(angR); // signed: + right of ray, - left of ray
    x.fwd  = x.d * Math.cos(angR); // signed: + ahead, - behind
  }
  const forward = uniq.filter(x => x.fwd > 0);
  // Sort by signed angle so prev/next ang-neighbors of the chosen "current"
  // are just indices ±1 in this array.
  forward.sort((a, b) => a.ang - b.ang);
  if (!forward.length) return null;

  // Corridor pick: closest forward building within a perpendicular half-width.
  const pickInCorridor = (perpHalfwidth, maxFwd) => {
    let bestIdx = -1, bestFwd = Infinity;
    for (let i = 0; i < forward.length; i++) {
      const x = forward[i];
      if (Math.abs(x.perp) > perpHalfwidth) continue;
      if (x.fwd > maxFwd) continue;
      if (x.fwd < bestFwd) { bestFwd = x.fwd; bestIdx = i; }
    }
    return bestIdx;
  };

  let bestIdx = pickInCorridor(CORRIDOR_HALFWIDTH_M, MAX_DIST_M);
  // Fallback: widen corridor (catches the next-door neighbor when the
  // exact building you're aimed at isn't in our index).
  if (bestIdx < 0) bestIdx = pickInCorridor(CORRIDOR_FALLBACK_HALFWIDTH_M, MAX_DIST_M * 1.25);

  const makeHit = (i) => i >= 0 && i < forward.length
    ? rowToPhoto(forward[i].row, c, {
        distance: forward[i].d,
        offset: Math.abs(forward[i].ang),
        bearing: forward[i].b,
      })
    : null;

  if (bestIdx >= 0) {
    return {
      mode:    "trio",
      prev:    makeHit(bestIdx - 1),
      current: makeHit(bestIdx),
      next:    makeHit(bestIdx + 1),
    };
  }

  // Peek mode: no building in even the wide corridor. Pick the nearest
  // forward candidate on each side so the user sees which way to turn.
  let nearestLeft = null, nearestRight = null;
  for (const x of forward) {
    if (x.ang < 0) {
      if (!nearestLeft || x.d < nearestLeft.d) nearestLeft = x;
    } else if (x.ang > 0) {
      if (!nearestRight || x.d < nearestRight.d) nearestRight = x;
    }
  }
  const peekLeft  = nearestLeft  ? makeHit(forward.indexOf(nearestLeft))  : null;
  const peekRight = nearestRight ? makeHit(forward.indexOf(nearestRight)) : null;
  if (!peekLeft && !peekRight) return null;
  return { mode: "peek", peekLeft, peekRight };
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

// ---------- Rendering (persistent-DOM slide carousel) ----------
//
// slideRegistry maps BBL -> { el, hasFullRes, role, io } for every slide
// currently in the DOM. We key by BBL (not by IO) so that when the user
// taps through alternates of the same building, or when GPS jitter flips
// which angle of a building is "closest", the same persistent DOM node
// survives — the image src swaps, but the slide doesn't get recreated and
// re-fly-in.
//
// Each scan produces a "scene" (see pickScene) with two shapes:
//   trio mode: prev + current + next, the normal 3-slide carousel.
//   peek mode: peekLeft + peekRight, thin slivers at the screen edges
//              telling the user to turn toward an off-axis photo.
//
// renderScene reconciles the registry against the desired scene:
//   - Slides no longer desired get a .slot-far-* class and are removed
//     400 ms later, after the CSS transition slides them offscreen.
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
// This is what makes transitions smooth: a building that was "next" and
// becomes "center" has the SAME DOM node, so the transition fires on a
// class change rather than a node replacement.

let lastBbl = null;
const slideRegistry = new Map(); // bbl -> { el, hasFullRes, role, io }

// All slot classes that renderScene may apply/remove. Kept as a const so
// adding a new slot class (e.g. slot-peek-*) is a one-line change.
const SLOT_CLASSES = [
  "slot-left", "slot-center", "slot-right",
  "slot-far-left", "slot-far-right", "slot-exit",
  "slot-peek-left", "slot-peek-right",
];

function hideEmptyHint() { emptyHint.hidden = true; }
function showEmptyHint(text) { emptyHint.textContent = text; emptyHint.hidden = false; }

/**
 * Pick the entry class for a NEW slide appearing in `role`.
 * Slides that have a natural side (left/right, peek-left/peek-right) enter
 * from that side. Center slides enter from the direction of the user's
 * last turn.
 */
function entryClassFor(role, turnDir) {
  if (role === "left"  || role === "peek-left")  return "slot-far-left";
  if (role === "right" || role === "peek-right") return "slot-far-right";
  // role === "center" — enter from the turn direction.
  return turnDir === "left" ? "slot-far-left" : "slot-far-right";
}

/**
 * Pick the exit class for a slide LEAVING `oldRole`. Side-anchored slides
 * exit toward their own side. A stale center exits OPPOSITE to the current
 * turn direction (turning right → old center slides off to the left).
 */
function exitClassFor(oldRole, turnDir) {
  if (oldRole === "left"  || oldRole === "peek-left")  return "slot-far-left";
  if (oldRole === "right" || oldRole === "peek-right") return "slot-far-right";
  return turnDir === "right" ? "slot-far-left" : "slot-far-right";
}

/**
 * Top-level renderer. Takes the output of pickScene and reconciles the DOM.
 * Handles both "trio" and "peek" modes with a single codepath — the roles
 * are just different entries in the `desired` map.
 */
function renderScene(scene) {
  photoWrap.classList.remove("empty");

  // Build desired state: bbl -> { role, hit }.
  const desired = new Map();
  if (scene.mode === "trio") {
    if (scene.prev)    desired.set(scene.prev.bbl,    { role: "left",   hit: scene.prev });
    if (scene.current) desired.set(scene.current.bbl, { role: "center", hit: scene.current });
    if (scene.next)    desired.set(scene.next.bbl,    { role: "right",  hit: scene.next });
  } else {
    // peek mode
    if (scene.peekLeft)  desired.set(scene.peekLeft.bbl,  { role: "peek-left",  hit: scene.peekLeft });
    if (scene.peekRight) desired.set(scene.peekRight.bbl, { role: "peek-right", hit: scene.peekRight });
  }

  // 1. Remove slides that are no longer desired — slide them off in the
  //    direction opposite to the user's turn (or to their own side for
  //    peek/side-anchored slides).
  for (const [bbl, sl] of slideRegistry) {
    if (desired.has(bbl)) continue;
    const exit = exitClassFor(sl.role, lastTurnDir);
    sl.el.classList.remove(...SLOT_CLASSES);
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
      // Enter from offscreen — toward role's natural side, or user's turn
      // direction for center slides.
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
    sl.el.classList.remove(...SLOT_CLASSES);
    sl.el.classList.add(`slot-${role}`);

    // Only the center slide bothers with full-res — everything else is
    // dimmed/blurred and thumbnail-quality is invisible. When a slide
    // transitions into center, upgrade its src to full.
    if (role === "center" && !sl.hasFullRes) {
      upgradeToFullRes(sl, hit);
    }
  }

  // 3. Bottom chrome + overlay hint.
  if (scene.mode === "trio" && scene.current) {
    hideEmptyHint();
    updateBottomCard(scene.current);
  } else if (scene.mode === "peek") {
    // No building directly ahead — tell the user to turn.
    bottomCard.hidden = true;
    const l = scene.peekLeft, r = scene.peekRight;
    let hint;
    if (l && r) {
      const leftCloser = l.distance <= r.distance;
      const near = leftCloser ? l : r;
      hint = `No 1940s photo directly ahead.\nTurn ${leftCloser ? "left" : "right"} — a photo is ~${Math.round(near.distance)} m away.`;
    } else if (l) {
      hint = `No 1940s photo directly ahead.\nTurn left — a photo is ~${Math.round(l.distance)} m away.`;
    } else {
      hint = `No 1940s photo directly ahead.\nTurn right — a photo is ~${Math.round(r.distance)} m away.`;
    }
    showEmptyHint(hint);
  }
}

/**
 * Swap the image src on an existing slide to a different IO (same BBL,
 * different angle). Used when pickScene picks a different alt as "closest"
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
    sl.el.classList.remove(...SLOT_CLASSES);
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
  // If no manual override AND the user isn't mid-swipe on the minimap,
  // keep the map centered on GPS. Suppressing during drag avoids yanking
  // the map out from under their finger as a background GPS update arrives.
  if (mapReady && !manualOverride && !isDraggingMinimap) {
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
  const scene = pickScene(pos.lat, pos.lon, heading);
  if (scene) renderScene(scene);
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

  // Two interaction modes, distinguished by motion distance:
  //   tap  → jump the pin to the tapped spot (GPS correction, fast).
  //   drag → pan the pin around live as the finger moves, commit on release.
  // Both end up calling setManualOverride, which locks the pin until the user
  // hits the reset button.
  bindMinimapInteraction();
}

function bindMinimapInteraction() {
  // Pointer state for the current gesture. `startCenter` captures the geo
  // point under the pin at gesture-start; every mousemove re-derives the
  // center from this anchor + pixel delta (absolute, not cumulative) so
  // there's no drift from skipped events.
  let start = null;
  let dragged = false;
  const DRAG_THRESHOLD_PX = 6; // below this, treat as a tap
  const TAP_MAX_MS = 500;

  miniMapGl.addEventListener("pointerdown", (e) => {
    if (!map) return;
    start = {
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      startCenter: map.getCenter(),
    };
    dragged = false;
    try { miniMapGl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  miniMapGl.addEventListener("pointermove", (e) => {
    if (!start || !map) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!dragged) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      dragged = true;
      isDraggingMinimap = true; // suppress GPS-driven recenter while dragging
    }
    // Re-anchor to start, then compute the geo point that would appear at
    // screen (cx + dx, cy + dy) and recenter there. That makes the geo
    // location under the user's fingertip follow the finger exactly — the
    // pin visually stays at the center while the map scrolls underneath.
    // Two jumpTos in one handler settle into a single browser paint.
    map.jumpTo({ center: [start.startCenter.lng, start.startCenter.lat] });
    const rect = miniMapGl.getBoundingClientRect();
    const target = map.unproject([rect.width / 2 + dx, rect.height / 2 + dy]);
    map.jumpTo({ center: [target.lng, target.lat] });
  });

  const endGesture = (e) => {
    if (!start) return;
    const dt = performance.now() - start.t;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const wasDragged = dragged;
    start = null;
    dragged = false;
    isDraggingMinimap = false;
    if (!map) return;

    if (wasDragged) {
      // Commit the dragged-to center as the manual override.
      const c = map.getCenter();
      setManualOverride(c.lat, c.lng);
    } else if (dt <= TAP_MAX_MS && Math.hypot(dx, dy) < 10) {
      // Tap: unproject the click point directly.
      const rect = miniMapGl.getBoundingClientRect();
      const lngLat = map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
      setManualOverride(lngLat.lat, lngLat.lng);
    }
  };

  miniMapGl.addEventListener("pointerup", endGesture);
  miniMapGl.addEventListener("pointercancel", () => {
    start = null;
    dragged = false;
    isDraggingMinimap = false;
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

// Post-load tweak: take OpenFreeMap's dark style and make it readable on a
// 110 px porthole. Three things:
//
//   (a) Road fills → clean white, with dash arrays cleared. A stock layer
//       like `highway_path` ships with `line-dasharray: [1.5, 1.5]`; if we
//       just recolor without clearing dash, it paints as a dotted white
//       line on top of the street, which looked exactly like sidewalk dashes.
//   (b) "Casing" layers (the outline lines that flank every road) → hidden
//       entirely. At 110 px they'd read as doubled edges around every road.
//       Pedestrian `highway_path` also falls in here — at this zoom, trails
//       inside parks are just distracting confetti.
//   (c) Road-name symbols → white at ~70% opacity with a black halo so they
//       stay readable without dominating. Stock is `rgb(80,78,78)` which is
//       invisible on the dark basemap.
function cleanupMapStyle() {
  if (!map) return;
  const style = map.getStyle();
  if (!style?.layers) return;
  for (const layer of style.layers) {
    const id = (layer.id || "").toLowerCase();

    if (layer.type === "line") {
      const isRoadish = /(highway|road|street|motorway|trunk|primary|secondary|tertiary|residential|service|transportation)/.test(id);
      if (!isRoadish) continue;
      // Hide the thin dark outlines and the pedestrian/path overlays.
      const shouldHide = /(casing|outline|path|pier|pedestrian|footway|track)/.test(id);
      try {
        if (shouldHide) {
          map.setLayoutProperty(layer.id, "visibility", "none");
        } else {
          map.setPaintProperty(layer.id, "line-color", "#f2f2f2");
          map.setPaintProperty(layer.id, "line-opacity", 1);
          // Clear any dash pattern — setting to [1,0] forces solid strokes.
          // `null` would reset to default (empty), which also works, but
          // `[1,0]` is the documented explicit "solid line" incantation.
          map.setPaintProperty(layer.id, "line-dasharray", [1, 0]);
        }
      } catch { /* some layers don't accept updates — ignore */ }
    } else if (layer.type === "symbol") {
      // Street-name labels. OpenFreeMap tags them via source-layer
      // `transportation_name`; the id pattern is `highway_name_*`.
      const isRoadName = /(highway_name|road_name|street_name|transportation_name)/.test(id)
                       || (layer["source-layer"] === "transportation_name");
      if (!isRoadName) continue;
      try {
        map.setLayoutProperty(layer.id, "visibility", "visible");
        map.setPaintProperty(layer.id, "text-color", "rgba(255,255,255,0.72)");
        map.setPaintProperty(layer.id, "text-halo-color", "rgba(0,0,0,0.95)");
        map.setPaintProperty(layer.id, "text-halo-width", 1.2);
      } catch { /* ignore */ }
    }
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
