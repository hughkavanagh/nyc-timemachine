// NYC Lens — compass-aware "point to view".
//
// Flow:
//   1. Load photos.json (packed, ~2-15MB depending on how much has been scraped/exported).
//   2. Show a centered "Enable location" button. On tap, request geolocation +
//      device-orientation permissions (iOS 13+ requires a user gesture).
//   3. Subscribe to GPS updates and compass heading. On desktop (no compass),
//      fall back to a 0-360 slider so the logic can be tested without a phone.
//   4. Each tick: pick the best candidate photo for (position, heading) — the
//      closest building in roughly the direction we're pointed at. Show it
//      full-bleed as the background, with address in the bottom bubble and
//      "other angles" of the same BBL as thumbnails.
//
// Design choices:
//   - "In view" = within ±22° of heading, ≤120m distance. Phone cameras see
//     ~60-70° horizontally, so ±22° is "clearly pointed at".
//   - Ranking: score = distance_m + 2.5 * abs(angle_deg). Closer + more
//     aligned wins. Tuned by eye; adjust after real-world testing.
//   - Scan is linear (O(n)) for now. At 100k photos that's ~1ms per frame on
//     a laptop, which is fine. If it becomes a bottleneck on old phones we'll
//     add a spatial grid index.

// ---------- Config ----------
const PHOTOS_URL = "/data/export/photos.json";
const ALTS_URL   = "/data/export/alternates.json";
// Main photo uses full-res; alternates strip still uses thumbnails (tiny 48px
// squares in the bottom card — full-res would be wasted bandwidth there).
const THUMB_BASE = "https://nycrecords.access.preservica.com/download/thumbnail";
const FULL_BASE  = "https://nycrecords.access.preservica.com/download/file";

const CONE_DEG   = 22;    // half-angle considered "pointed at"
const MAX_DIST_M = 120;   // max range for candidate buildings (dense NYC)
const ANGLE_WEIGHT = 2.5; // ranking weight: 1° misalignment ≈ 2.5 m

// ?debug in URL exposes a tiny testing API (window.__tm.setPose) and the
// "All nearby" toggle. Hidden by default so the shareable view stays clean.
const DEBUG = new URLSearchParams(location.search).has("debug");

// ---------- State ----------
let index = null;          // { columns, data } from photos.json
let alts  = null;          // { bbl: [io, io, ...] } from alternates.json
let userPos = null;        // { lat, lon, accuracy } or null
let heading = null;        // degrees 0-360, or null
let hasCompass = false;
let currentIoIdx = 0;      // which alternate of current BBL we're showing

// Recently-viewed full-res URLs. Browser HTTP cache keeps the bytes; this Set
// is how we KNOW we've already paid for them so we can skip the thumbnail +
// shimmer and paint full-res immediately. Most-recent at end; capped at 20 so
// memory stays tiny.
const RECENT_CAP = 20;
const recentFullSet = new Set();
const recentFullList = [];
function markRecent(url) {
  if (recentFullSet.has(url)) {
    // Re-touch: move to end of list.
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

function renderTarget(hit) {
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
  // If we've loaded this full-res recently (within last ~20 views), the
  // browser HTTP cache will serve it instantly — skip the thumbnail step.
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
    // Preload full-res, then swap if the user is still looking at this photo.
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
      // Leave the thumbnail up; just stop shimmering so we don't look broken.
      const shim = photoWrap.querySelector(".shimmer");
      if (shim) shim.remove();
    };
    pre.src = fullUrl;
  } else {
    markRecent(fullUrl); // bump recency on repeat view
  }

  // Bottom card: address + distance; optional alts.
  bottomCard.hidden = false;
  addrText.textContent = hit.addr ?? "Unknown address";
  subText.textContent = `${hit.distance.toFixed(0)} m away`;

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

function escAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

// Horizontal swipe on the photo cycles alternates.
// Threshold: 40px horizontal, <60px vertical (avoids clashing with scroll).
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

  // If there's a nearest building, use the bottom card as a turn-around hint.
  const near = nearestAny(lat, lon);
  if (!near) {
    bottomCard.hidden = true;
    return;
  }
  const hint = compassHint(angleDiff(near.bearing, hdg));
  bottomCard.hidden = false;
  addrText.textContent = near.addr ?? "Nearest photo";
  subText.textContent = `${near.distance.toFixed(0)} m · ${hint}`;
  altsHintEl.hidden = true;
  altsStrip.innerHTML = "";
}

function compassHint(diff) {
  // diff > 0 means turn right (clockwise), < 0 means left.
  const abs = Math.abs(diff);
  if (abs < 15) return "straight ahead";
  const dir = diff > 0 ? "right" : "left";
  if (abs < 45) return `slightly to your ${dir}`;
  if (abs < 135) return `to your ${dir}`;
  return "behind you";
}

// ---------- Tick ----------
function tick() {
  if (!userPos || heading == null) return;

  compass.classList.remove("idle");
  // The compass SVG is drawn "needle up = north". Rotating the whole SVG by
  // heading makes the needle point in the direction the user is facing.
  compassSvg.style.transform = `rotate(${heading}deg)`;

  const hit = pickTarget(userPos.lat, userPos.lon, heading);
  if (hit) {
    renderTarget(hit);
  } else {
    renderNoCandidate(userPos.lat, userPos.lon, heading);
  }
}

// ---------- Permissions / sources ----------
function watchGps() {
  navigator.geolocation.watchPosition(
    (pos) => {
      userPos = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      // First fix — hide the enable button permanently.
      centerBtn.hidden = true;
      tick();
    },
    (err) => showLocationError(err.message),
    { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 }
  );
}

function installCompass() {
  const needsIosPerm =
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function";

  const listen = () => {
    hasCompass = true;
    if ("ondeviceorientationabsolute" in window) {
      window.addEventListener("deviceorientationabsolute", (e) => {
        if (e.alpha != null) {
          heading = (360 - e.alpha) % 360;
          tick();
        }
      }, true);
    }
    window.addEventListener("deviceorientation", (e) => {
      // Prefer iOS's webkitCompassHeading (true north) when present.
      let h = e.webkitCompassHeading;
      if (h == null && e.alpha != null) h = (360 - e.alpha) % 360;
      if (h != null) {
        heading = h;
        tick();
      }
    });
  };

  if (needsIosPerm) {
    DeviceOrientationEvent.requestPermission().then((state) => {
      if (state === "granted") listen();
      else installSlider("Compass denied — drag to change heading");
    }).catch(() => installSlider("Compass unavailable — drag to change heading"));
  } else if ("DeviceOrientationEvent" in window) {
    listen();
    // If after 2s we've got no event, assume desktop and offer the slider.
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
    heading = Number(e.target.value);
    tick();
  });
  tick();
}

function showLocationError(msg) {
  // Keep the center button visible; swap its label so the retry is obvious.
  centerBtn.hidden = false;
  startBtn.textContent = "Enable location";
  startBtn.title = msg;
}

// ---------- Bottom card interactions ----------
// Collapse/expand the whole bottom card. Collapsed state = address line only.
collapseBtn.addEventListener("click", () => {
  bottomCard.classList.toggle("collapsed");
  const collapsed = bottomCard.classList.contains("collapsed");
  collapseBtn.setAttribute("aria-label", collapsed ? "Expand" : "Collapse");
  // When collapsing, also close the info panel so re-expanding starts clean.
  if (collapsed) infoPanel.hidden = true;
});

// Tiny "i" button toggles the attribution panel.
infoBtn.addEventListener("click", () => {
  // If the card is collapsed, uncollapse first so the panel is visible.
  bottomCard.classList.remove("collapsed");
  collapseBtn.setAttribute("aria-label", "Collapse");
  infoPanel.hidden = !infoPanel.hidden;
});

// ---------- Startup ----------
startBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    startBtn.textContent = "Geolocation unavailable";
    startBtn.disabled = true;
    return;
  }
  // Android Chrome supports orientation lock; Safari iOS silently rejects it.
  // Either way we also have the CSS landscape-overlay as a fallback.
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock("portrait").catch(() => {});
  }
  startBtn.textContent = "Getting location…";
  startBtn.disabled = true;
  watchGps();
  installCompass();
});

loadData().catch((e) => {
  startBtn.textContent = `Load failed: ${e.message}`;
  startBtn.disabled = true;
});

// In DEBUG mode, expose a tiny API for scripted testing (headless previews,
// screenshots, etc.). Not for production users.
if (DEBUG) {
  window.__tm = {
    setPose(lat, lon, hdg) {
      userPos = { lat, lon, accuracy: 5 };
      heading = hdg;
      centerBtn.hidden = true;
      tick();
    },
    get state() { return { userPos, heading, currentIoIdx }; },
  };
}
