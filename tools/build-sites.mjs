// Build sites.json from real data:
//   terrain   NASA LRO LOLA polar DEM LDEM_75S_240M (PDS Geosciences), 240 m/pixel, 75°S–90°S
//   ephemeris JPL Horizons API: hourly apparent Sun & Earth az/el seen from each site on the Moon,
//             plus the hourly sub-solar point (for the globe's lighting)
//
// Usage: node tools/build-sites.mjs <path/to/ldem_75s_240m.img> [out=sites.json]
//   The DEM is ~29 MB: https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ldem_75s_240m.img
import { readFileSync, writeFileSync } from 'node:fs';

const [, , demPath, outPath = 'sites.json'] = process.argv;
if (!demPath) { console.error('usage: node tools/build-sites.mjs <ldem_75s_240m.img> [out]'); process.exit(1); }

// ------------------------------------------------------------------ config
const START = '2026-12-01 00:00', STOP = '2027-01-29 23:00', HOURS = 60 * 24;
const R = 1737400;                 // reference sphere (m), same as the DEM's OFFSET
const N = 3812, SCALE = 240, OFF = 1905.5;   // from the PDS label
const OBS_HEIGHT = 2;              // observer (lander sensor) height above the surface, m
const SUN_R = 0.2666;              // apparent solar radius, deg
const REFINE_KM = 2.4;             // snap each candidate point to the highest terrain within this radius
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const SITES = [
  { id: 'site_a', name: 'Connecting Ridge', lat: -89.45, lon: 222.7,
    summary: 'A raised ridge joining the rims of Shackleton and de Gerlache craters, almost on the pole itself. Its height lifts it above most nearby shadows, making it one of the best-lit places on the Moon, with permanently shadowed crater floors, where water ice may be trapped, within reach.' },
  { id: 'site_b', name: 'Peak Near Shackleton', lat: -88.79, lon: 123.6,
    summary: 'A high point on the far side of Shackleton crater. Being high above the surrounding terrain gives long stretches of sunlight, and the slopes below lead toward the shadowed interior of Shackleton.' },
  { id: 'site_c', name: 'de Gerlache Rim 1', lat: -88.67, lon: 292.2,
    summary: 'A high point on the rim of de Gerlache crater. The crater floor below is a permanently shadowed region worth sampling, and the rim itself rises high enough to see the Sun over most of the surrounding terrain.' },
  { id: 'site_d', name: 'Malapert Massif', lat: -85.99, lon: 2.74,
    summary: 'A five-kilometre-high massif about four degrees from the pole, on the side of the Moon that faces Earth. That makes direct-to-Earth radio easier, but being farther from the pole means the Sun swings lower each month and can drop out of view for days at a time.' }
];

// ------------------------------------------------------------------ DEM
const buf = readFileSync(demPath);
if (buf.length !== N * N * 2) throw new Error(`unexpected DEM size ${buf.length}`);
const dem = new Int16Array(buf.buffer, buf.byteOffset, N * N);   // LSB_INTEGER; height m = DN * 0.5

// polar stereographic (south), spherical. Orientation of the image axes is chosen by validation below.
let SX = 1, SY = 1;  // pixel sample = OFF + SX*x/SCALE, line = OFF + SY*y/SCALE  (0-based, half-pixel ignored)
function toXY(lat, lon) {
  const k = 2 * R * Math.tan(Math.PI / 4 + lat * D2R / 2);
  return { x: k * Math.sin(lon * D2R), y: k * Math.cos(lon * D2R) };
}
function fromXY(x, y) {
  const rho = Math.hypot(x, y);
  return { lat: (2 * Math.atan(rho / (2 * R)) - Math.PI / 2) * R2D, lon: ((Math.atan2(x, y) * R2D) + 360) % 360 };
}
const pix = (x, y) => ({ s: OFF + SX * x / SCALE, l: OFF + SY * y / SCALE });
function hAtXY(x, y) {            // bilinear height (m) or NaN outside
  const { s, l } = pix(x, y);
  const s0 = Math.floor(s), l0 = Math.floor(l);
  if (s0 < 0 || l0 < 0 || s0 >= N - 1 || l0 >= N - 1) return NaN;
  const fs = s - s0, fl = l - l0, i = l0 * N + s0;
  return 0.5 * ((dem[i] * (1 - fs) + dem[i + 1] * fs) * (1 - fl) + (dem[i + N] * (1 - fs) + dem[i + N + 1] * fs) * fl);
}
const hAt = (lat, lon) => { const p = toXY(lat, lon); return hAtXY(p.x, p.y); };

// Validate orientation: Shackleton's floor (≈89.67°S, 129.8°E) is a deep bowl; Malapert (≈86°S, 2.7°E) a tall massif.
function localMin(lat, lon, km) { const c = toXY(lat, lon); let m = Infinity; for (let dx = -km * 1000; dx <= km * 1000; dx += SCALE) for (let dy = -km * 1000; dy <= km * 1000; dy += SCALE) { const h = hAtXY(c.x + dx, c.y + dy); if (h < m) m = h; } return m; }
function localMax(lat, lon, km) { const c = toXY(lat, lon); let m = -Infinity; for (let dx = -km * 1000; dx <= km * 1000; dx += SCALE) for (let dy = -km * 1000; dy <= km * 1000; dy += SCALE) { const h = hAtXY(c.x + dx, c.y + dy); if (h > m) m = h; } return m; }
let best = null;
for (const sx of [1, -1]) for (const sy of [1, -1]) {
  SX = sx; SY = sy;
  const shackFloor = localMin(-89.67, 129.8, 2), shackRim = localMax(-89.67, 129.8, 12), malapert = localMax(-85.99, 2.74, 6), malBase = localMin(-85.99, 2.74, 25);
  const score = (shackRim - shackFloor) + (malapert - malBase);
  console.log(`axes SX=${sx} SY=${sy}: Shackleton floor ${shackFloor.toFixed(0)} m, rim ${shackRim.toFixed(0)} m | Malapert ${malapert.toFixed(0)} m over ${malBase.toFixed(0)} m  score ${score.toFixed(0)}`);
  if (!best || score > best.score) best = { sx, sy, score };
}
SX = best.sx; SY = best.sy;
console.log(`using SX=${SX} SY=${SY}`);

// ------------------------------------------------------------------ horizons from terrain
// north = away from the pole (radial), east = direction of increasing longitude
function horizonAt(x0, y0, h0) {
  const rho = Math.hypot(x0, y0), nx = x0 / rho, ny = y0 / rho, ex = ny, ey = -nx;
  // check east sign: moving along +east should increase longitude
  const test = fromXY(x0 + ex * 100, y0 + ey * 100).lon - fromXY(x0, y0).lon;
  const es = ((test + 540) % 360) - 180 > 0 ? 1 : -1;
  const out = new Array(360);
  for (let az = 0; az < 360; az++) {
    const a = az * D2R, dx = Math.cos(a) * nx + Math.sin(a) * ex * es, dy = Math.cos(a) * ny + Math.sin(a) * ey * es;
    let maxEl = -90, d = 300;
    while (d < 320000) {
      const h = hAtXY(x0 + dx * d, y0 + dy * d);
      if (Number.isNaN(h)) break;
      const el = Math.atan2(h - h0 - d * d / (2 * R), d) * R2D;
      if (el > maxEl) maxEl = el;
      d += d < 20000 ? 120 : d < 100000 ? 240 : 480;
    }
    out[az] = Math.round(maxEl * 100) / 100;
  }
  return out;
}

// ------------------------------------------------------------------ JPL Horizons
async function horizons(params) {
  const q = new URLSearchParams({ format: 'text', OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'OBSERVER', CSV_FORMAT: 'YES',
    START_TIME: `'${START}'`, STOP_TIME: `'${STOP}'`, STEP_SIZE: "'1h'", ...params });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch('https://ssd.jpl.nasa.gov/api/horizons.api?' + q.toString(), { headers: { 'User-Agent': 'lunar-landing-site-navigator/1.0' } });
    const t = await r.text();
    const a = t.indexOf('$$SOE'), b = t.indexOf('$$EOE');
    if (r.ok && a >= 0 && b > a) {
      const header = t.slice(0, a).split('\n').filter(l => l.includes('Date__')).pop();
      const rows = t.slice(a + 5, b).trim().split('\n').map(l => l.split(',').map(s => s.trim()));
      return { header, rows };
    }
    console.warn(`Horizons attempt ${attempt} failed (${r.status}): ${t.slice(0, 300)}`);
    await new Promise(res => setTimeout(res, 1500 * attempt));
  }
  throw new Error('Horizons request failed');
}
const toISO = s => {   // "2026-Dec-01 00:00" -> "2026-12-01T00:00Z"
  const M = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const [d, hm] = s.split(' '); const [y, mo, da] = d.split('-'); return `${y}-${M[mo]}-${da}T${hm}Z`;
};

// ------------------------------------------------------------------ helpers shared with the app
const r2 = v => Math.round(v * 100) / 100;
function hAtArr(h, az) { az = ((az % 360) + 360) % 360; const i = Math.floor(az), f = az - i; return h[i % 360] * (1 - f) + h[(i + 1) % 360] * f; }
function diskFrac(el, h, r) { const d = Math.max(-1, Math.min(1, (el - h) / r)); return 1 - (Math.acos(d) - d * Math.sqrt(1 - d * d)) / Math.PI; }
function metrics(tl) { let lit = 0, com = 0, run = 0, longest = 0; for (const p of tl) { lit += p.lit; com += p.comms; if (!p.lit) { run++; longest = Math.max(longest, run); } else run = 0; } return { pctSunlit: r2(100 * lit / tl.length), longestDarkHrs: longest, pctComms: r2(100 * com / tl.length) }; }
function windows(tl) { const w = []; let s = -1; for (let i = 0; i <= tl.length; i++) { const on = i < tl.length && tl[i].comms; if (on && s < 0) s = i; if (!on && s >= 0) { w.push({ start: tl[s].t, end: tl[i - 1].t }); s = -1; } } return w; }

// ------------------------------------------------------------------ build
const out = [];
for (const def of SITES) {
  // snap to the highest terrain near the candidate coordinate (landers target ridge crests)
  const c = toXY(def.lat, def.lon);
  let bx = c.x, by = c.y, bh = hAtXY(c.x, c.y);
  for (let dx = -REFINE_KM * 1000; dx <= REFINE_KM * 1000; dx += SCALE / 2)
    for (let dy = -REFINE_KM * 1000; dy <= REFINE_KM * 1000; dy += SCALE / 2) {
      if (Math.hypot(dx, dy) > REFINE_KM * 1000) continue;
      const h = hAtXY(c.x + dx, c.y + dy); if (h > bh) { bh = h; bx = c.x + dx; by = c.y + dy; }
    }
  const ll = fromXY(bx, by), h0 = bh + OBS_HEIGHT;
  console.log(`\n${def.name}: candidate ${def.lat}, ${def.lon} (${hAt(def.lat, def.lon).toFixed(0)} m) -> peak ${ll.lat.toFixed(4)}, ${ll.lon.toFixed(3)}E at ${bh.toFixed(0)} m`);
  const horizon = horizonAt(bx, by, h0);
  console.log(`  horizon ${Math.min(...horizon).toFixed(2)}°..${Math.max(...horizon).toFixed(2)}°`);

  const site = `'${ll.lon.toFixed(5)},${ll.lat.toFixed(5)},${(h0 / 1000).toFixed(4)}'`;
  const common = { CENTER: "'coord@301'", COORD_TYPE: "'GEODETIC'", SITE_COORD: site, QUANTITIES: "'4'", ANG_FORMAT: "'DEG'", APPARENT: "'AIRLESS'" };
  const sun = await horizons({ COMMAND: "'10'", ...common });
  const earth = await horizons({ COMMAND: "'399'", ...common });
  if (sun.rows.length !== HOURS || earth.rows.length !== HOURS) throw new Error(`expected ${HOURS} rows, got ${sun.rows.length}/${earth.rows.length}`);
  const timeline = sun.rows.map((sr, i) => {
    const er = earth.rows[i];
    const sunAz = +sr[3], sunEl = +sr[4], earthAz = +er[3], earthEl = +er[4];
    const f = diskFrac(sunEl, hAtArr(horizon, sunAz), SUN_R);
    return { t: toISO(sr[0]), sunAz: r2(sunAz), sunEl: r2(sunEl), earthAz: r2(earthAz), earthEl: r2(earthEl),
      lit: f > 0.02 ? 1 : 0, sunFrac: r2(f), comms: earthEl > hAtArr(horizon, earthAz) ? 1 : 0 };
  });
  const m = metrics(timeline);
  console.log(`  ${JSON.stringify(m)}  sunEl ${Math.min(...timeline.map(p => p.sunEl))}..${Math.max(...timeline.map(p => p.sunEl))}`);
  out.push({
    id: def.id, name: def.name, region: 'Artemis III candidate region', lat: r2(ll.lat * 100) / 100, lon: r2(ll.lon * 100) / 100,
    elevationM: Math.round(bh), summary: def.summary,
    quickmapUrl: 'https://quickmap.lroc.asu.edu/', moonTrekUrl: 'https://trek.nasa.gov/moon/',
    approxCoords: false, horizon, timeline, metrics: m, commsWindows: windows(timeline), nasaIllumPct: null
  });
}

// sub-solar point on the Moon (observer = Sun's centre, target = Moon, quantity 14)
const ss = await horizons({ COMMAND: "'301'", CENTER: "'500@10'", QUANTITIES: "'14'", ANG_FORMAT: "'DEG'" });
console.log('\nsub-solar header:', ss.header.trim());
const subsolar = ss.rows.map(r => [r2(+r[4]), r2(+r[3])]);   // [lat, lon] — order checked against the header printed above

const data = {
  meta: {
    source: 'horizons', generated: new Date().toISOString().slice(0, 16) + 'Z', start: out[0].timeline[0].t, hours: HOURS, step: '1h',
    ephemeris: 'JPL Horizons API: apparent (airless) azimuth/elevation of Sun (10) and Earth (399) from topocentric sites on the Moon (coord@301, geodetic)',
    terrain: `NASA LRO LOLA LDEM_75S_240M (240 m/pixel); 360 one-degree rays to 320 km with lunar curvature; observer ${OBS_HEIGHT} m above the surface; sites snapped to the highest terrain within ${REFINE_KM} km of each candidate coordinate`,
    subsolarNote: 'hourly [lat, lon] of the sub-solar point from Horizons (observer: Sun centre, target: Moon)',
    subsolar
  },
  sites: out
};
let txt = JSON.stringify(data);
txt = txt.replace(/\},\{"t"/g, '},\n{"t"');
writeFileSync(outPath, txt);
console.log(`\nwrote ${outPath} (${(txt.length / 1024).toFixed(0)} KB)`);
