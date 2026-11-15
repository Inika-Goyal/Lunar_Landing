// Add NASA's long-term average illumination to each site in sites.json (the "vs NASA illumination map" value).
//
// Source: LOLA Lunar Polar Illumination Products, NASA GSFC PGDA product 69
//   https://pgda.gsfc.nasa.gov/products/69
//   AVGVISIB_85S_060M_201608.IMG (+ .LBL): average fraction of the solar disc visible, hourly over 18.6 years,
//   85°S–90°S, polar stereographic, 60 m/pixel, int16, value = DN * 0.00004
//   http://imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG/AVGVISIB_85S_060M_201608.IMG  (~51 MB)
// Citation: Mazarico, E., et al. (2011), Illumination conditions of the lunar polar regions using LOLA
//   topography, Icarus 211, 1066–1081, doi:10.1016/j.icarus.2010.10.030
//
// Usage: node tools/nasa-illum.mjs <AVGVISIB_85S_060M_201608.IMG> [sites.json]
import { readFileSync, writeFileSync } from 'node:fs';

const [, , imgPath, sitesPath = 'sites.json'] = process.argv;
if (!imgPath) { console.error('usage: node tools/nasa-illum.mjs <AVGVISIB_85S_060M_201608.IMG> [sites.json]'); process.exit(1); }

const R = 1737400, N = 5058, SCALE = 60, OFF = 2528.5, K = 0.00004;   // from the PDS label
const D2R = Math.PI / 180;
const buf = readFileSync(imgPath);
if (buf.length !== N * N * 2) throw new Error(`unexpected size ${buf.length}`);
const img = new Int16Array(buf.buffer, buf.byteOffset, N * N);

let SX = 1, SY = 1;
function toXY(lat, lon) {
  const k = 2 * R * Math.tan(Math.PI / 4 + lat * D2R / 2);
  return { x: k * Math.sin(lon * D2R), y: k * Math.cos(lon * D2R) };
}
function at(lat, lon) {            // bilinear average visibility 0..1, NaN outside
  const p = toXY(lat, lon), s = OFF + SX * p.x / SCALE, l = OFF + SY * p.y / SCALE;
  const s0 = Math.floor(s), l0 = Math.floor(l);
  if (s0 < 0 || l0 < 0 || s0 >= N - 1 || l0 >= N - 1) return NaN;
  const fs = s - s0, fl = l - l0, i = l0 * N + s0;
  return K * ((img[i] * (1 - fs) + img[i + 1] * fs) * (1 - fl) + (img[i + N] * (1 - fs) + img[i + N + 1] * fs) * fl);
}
function ring(lat, lon, m) {       // max within m metres (sites sit on small summits)
  const c = toXY(lat, lon); let best = 0;
  for (let dx = -m; dx <= m; dx += SCALE) for (let dy = -m; dy <= m; dy += SCALE) {
    const rho = Math.hypot(c.x + dx, c.y + dy);
    const la = (2 * Math.atan(rho / (2 * R)) - Math.PI / 2) / D2R, lo = Math.atan2(c.x + dx, c.y + dy) / D2R;
    const v = at(la, lo); if (v > best) best = v;
  }
  return best;
}

const data = JSON.parse(readFileSync(sitesPath, 'utf8'));

// Validate image orientation: Shackleton's floor (89.67°S, 129.8°E) is permanently shadowed (≈0),
// and the four sites are among the best-lit places at the pole.
let best = null;
for (const sx of [1, -1]) for (const sy of [1, -1]) {
  SX = sx; SY = sy;
  const floor = at(-89.67, 129.8);
  const mean = data.sites.reduce((a, s) => a + at(s.lat, s.lon), 0) / data.sites.length;
  console.log(`axes SX=${sx} SY=${sy}: Shackleton floor ${floor.toFixed(3)}, sites mean ${mean.toFixed(3)}`);
  if (!best || mean - floor > best.score) best = { sx, sy, score: mean - floor };
}
SX = best.sx; SY = best.sy;
console.log(`using SX=${SX} SY=${SY}`);

for (const s of data.sites) {
  const v = at(s.lat, s.lon), nb = ring(s.lat, s.lon, 240);
  s.nasaIllumPct = Math.round(v * 1000) / 10;
  s.nasaIllumBestNearbyPct = Math.round(nb * 1000) / 10;   // our sites come from a 240 m grid; NASA's map is 60 m
  console.log(`${s.name.padEnd(22)} NASA avg ${(v * 100).toFixed(1)}%  (best within 240 m ${(nb * 100).toFixed(1)}%)  ours ${s.metrics.pctSunlit}% over 60 days`);
}
data.meta.nasaIllum = 'nasaIllumPct: NASA GSFC PGDA LOLA polar illumination map AVGVISIB_85S_060M_201608 (Mazarico et al. 2011, Icarus 211), average solar-disc visibility over 18.6 years, sampled at each site (60 m/pixel, surface level).';
writeFileSync(sitesPath, JSON.stringify(data).replace(/\},\{"t"/g, '},\n{"t"'));   // same layout as build-sites.mjs
console.log('wrote', sitesPath);
