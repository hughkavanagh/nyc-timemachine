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
const ANGLE_WEIGHT = 2.5; // ranking weight: 1° misalignment ≈ 2.5 m

// Map tile style. OpenFreeMap is free, no API key, attribution baked in.
const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";
const MAP_ZOOM  = 17.5;

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
const compass       = el("compass");
const compassSvg    = el("compassSvg");
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

/** Return best-aligned photo within the view cone, or null. */
function pickTarget(lat, lon, hdg) {
  const c = colIdx();
  let best = null;
  for (const r of index.data) {
    const plat = r[c.lat], plon = r[c.lon];
    const d = distMeters(lat, lon, plat, plon);
    if (d > MAX_DIST_M) continue;
    const b = bearingDeg(lat, lon, plat, plon);
    const off = Math.abs(angleDiff(b, hdg));
    if (off > CONE_DEG) continue;
    const score = d + ANGLE_WEIGHT * off;
    if (!best || score < best.score) {
      best = { score, d, off, bearing: b, row: r, col: c };
    }
  }
  if (!best) return null;
  return rowToPhoto(best.row, best.col, { distance: best.d, offset: best.off, bearing: best.bearing });
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

// ---------- Rendering ----------
let lastBbl = null;

function hideEmptyHint() {
  emptyHint.hidden = true;
}

function showEmptyHint(text) {
  emptyHint.textContent = text;
  emptyHint.hidden = false;
}

function renderTarget(hit) {
  hideEmptyHint();
  // If BBL changed, reset alt cycling.
  if (hit.bbl !== lastBbl) {
    currentIoIdx = 0;
    lastBbl = hit.bbl;
  }
  const extra = alts[hit.bbl] ?? [];
  const ids = [stripIo(hit.io), ...extra];
  const currentId = ids[currentIoIdx] ?? ids[0];
  const io = `IO_${currentId}`;

  // Photo strategy: render thumbnail immediately with a shimmer overlay,
  // preload full-res in the background, then swap src + fade shimmer out.
  // If we've loaded this full-res recently, the HTTP cache serves it
  // instantly — skip the thumbnail step.
  const thumbUrl = `${THUMB_BASE}/${io}?fallback-thumbnail=1`;
  const fullUrl  = `${FULL_BASE}/${io}`;
  const cached   = recentFullSet.has(fullUrl);

  photoWrap.classList.remove("empty");
  photoWrap.innerHTML = `
    <a href="${fullUrl}" target="_blank" rel="noopener">
      <img src="${cached ? fullUrl : thumbUrl}"
           data-target="${fullUrl}"
           alt="${escAttr(hit.addr ?? "")}">
      ${cached ? "" : `<div class="shimmer"></div>`}
    </a>
  `;

  if (!cached) {
    const pre = new Image();
    pre.onload = () => {
      const img = photoWrap.querySelector("img");
      if (!img || img.dataset.target !== fullUrl) return;
      img.src = fullUrl;
      const shim = photoWrap.querySelector(".shimmer");
      if (shim) {
        shim.classList.add("fade-out");
        setTimeout(() => shim.remove(), 240);
      }
      markRecent(fullUrl);
    };
    pre.onerror = () => {
      const shim = photoWrap.querySelector(".shimmer");
      if (shim) shim.remove();
    };
    pre.src = fullUrl;
  } else {
    markRecent(fullUrl);
  }

  // Bottom card: address + distance; optional alts.
  bottomCard.hidden = false;
  addrText.textContent = hit.addr ?? "Unknown address";
  subText.innerHTML = `${hit.distance.toFixed(0)} m away${manualOverride ? manualChipHtml() : ""}`;
  wireManualChipReset();

  if (ids.length > 1) {
    altsHintEl.hidden = false;
    altsHintEl.textContent = `${ids.length} angles of this building — tap or swipe`;
    altsStrip.innerHTML = ids.map((id, i) => `
      <a href="#" class="${i === currentIoIdx ? "current" : ""}" data-i="${i}">
        <img src="${THUMB_BASE}/IO_${id}?fallback-thumbnail=1" alt="">
      </a>
    `).join("");
    altsStrip.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        currentIoIdx = Number(a.dataset.i);
        renderTarget(hit);
      });
    });
    attachSwipe(photoWrap, ids.length, hit);
  } else {
    altsHintEl.hidden = true;
    altsStrip.innerHTML = "";
  }
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

// Horizontal swipe on the photo cycles alternates.
function attachSwipe(target, count, hit) {
  if (!target || count <= 1) return;
  if (target._swipeBound) return;
  target._swipeBound = true;
  let x0 = null, y0 = null;
  target.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY;
  }, { passive: true });
  target.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = y0 = null;
    if (Math.abs(dx) < 40 || Math.abs(dy) > 60) return;
    currentIoIdx = (currentIoIdx + (dx < 0 ? 1 : -1) + count) % count;
    renderTarget(hit);
  }, { passive: true });
}

function stripIo(io) { return io.startsWith("IO_") ? io.slice(3) : io; }

function renderNoCandidate(lat, lon, hdg) {
  photoWrap.innerHTML = "";
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
  heading = h;
  compass.classList.remove("idle");

  // Compass SVG: rotate so the needle points to the user's facing direction
  // (top of the screen = direction they're pointed).
  compassSvg.style.transform = `rotate(${h}deg)`;

  // Map: rotate the tiles so the user's facing direction is UP. This is
  // Google-Maps-style orientation.
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
  const hit = pickTarget(pos.lat, pos.lon, heading);
  if (hit) renderTarget(hit);
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
  const r = 76; // radius in px from minimap center
  const b = h * Math.PI / 180;
  const x = -r * Math.sin(b);
  const y = -r * Math.cos(b);
  miniMapNorth.style.transform = `translate(${x}px, ${y}px)`;
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
