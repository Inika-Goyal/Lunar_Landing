// Printable crater template for the tabletop model, built from a site's real 360° horizon in sites.json.
//
// The model works like this: the lander's light sensor sits at height s above the base disc, a crater wall
// stands around it at radius R, and the Sun LED arm is further out. The wall height at each azimuth is
//     H(az) = s + R · k · tan(horizonEl(az))
// which is the same formula the app uses for the Sun LED (H = s + D · k · tan(sunEl)). So the sensor loses
// the Sun LED exactly when the real Sun drops below the real horizon (angles exaggerated k times).
//
// Usage: node tools/build-template.mjs [siteId=site_d] [out=templates/<site>-crater-template.pdf]
//   Needs Google Chrome or Microsoft Edge installed (used only to print the PDF).
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , siteId = 'site_d', outArg] = process.argv;
const data = JSON.parse(readFileSync('sites.json', 'utf8'));
const site = data.sites.find(s => s.id === siteId);
if (!site) { console.error(`no site ${siteId}; have ${data.sites.map(s => s.id).join(', ')}`); process.exit(1); }
const slug = site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const out = resolve(outArg || `templates/${slug}-crater-template.pdf`);

// ------------------------------------------------------------------ model constants (mm)
const K = 10;          // elevation exaggeration (the app's default k)
const RW = 80;         // crater wall radius
const S = 60;          // lander sensor height above the base disc (works for every site in sites.json)
const FLAP = 8;        // glue flap under the wall
const PARTS = 3;       // the wall is printed in this many pieces
const D2R = Math.PI / 180;
const hor = site.horizon;                       // 360 values, index = azimuth in degrees (0 = north, 90 = east)
const wallH = az => {
  const i = Math.floor(az) % 360, f = az - Math.floor(az);
  const el = hor[i] + (hor[(i + 1) % 360] - hor[i]) * f;
  return S + RW * K * Math.tan(el * D2R);
};
let minH = Infinity, maxH = -Infinity, minAz = 0, maxAz = 0;
for (let a = 0; a < 360; a += 0.25) { const h = wallH(a); if (h < minH) { minH = h; minAz = a; } if (h > maxH) { maxH = h; maxAz = a; } }
if (minH < 3) throw new Error(`wall too low (${minH.toFixed(1)} mm): raise S`);
const CIRC = 2 * Math.PI * RW, SEG = CIRC / PARTS, SEG_DEG = 360 / PARTS;
const sunEl = site.timeline.map(p => p.sunEl);
const f1 = v => v.toFixed(1);
const compass = a => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' })[a] || '';

// ------------------------------------------------------------------ SVG pieces
function wallPart(p) {
  const a0 = p * SEG_DEG, TAB = 10, PADT = 6, w = SEG + TAB, h = PADT + maxH + FLAP + 9;
  const base = PADT + maxH;                                  // y of the fold line (wall bottom)
  let top = '';
  for (let x = 0; x <= SEG + 1e-6; x += 0.5) {
    const az = a0 + (x / SEG) * SEG_DEG;
    top += `${top ? 'L' : 'M'}${f1(x)},${(base - wallH(az)).toFixed(2)} `;
  }
  // wall outline: top profile, right edge, flap, left edge
  const outline = `${top} L${f1(SEG)},${base + FLAP} L0,${base + FLAP} Z`;
  const tabTop = base - Math.min(wallH((a0 + SEG_DEG) % 360), wallH(a0 + SEG_DEG - 0.01)) + 2;
  const tab = `M${f1(SEG)},${f1(tabTop)} L${f1(SEG + TAB)},${f1(tabTop + 4)} L${f1(SEG + TAB)},${base - 2} L${f1(SEG)},${base} Z`;
  let ticks = '';
  for (let a = Math.ceil(a0); a <= a0 + SEG_DEG; a += 5) {
    const x = (a - a0) / SEG_DEG * SEG, big = a % 30 === 0;
    ticks += `<line x1="${f1(x)}" y1="${base}" x2="${f1(x)}" y2="${base - (big ? 5 : 2.5)}" class="tk"/>`;
    if (big) ticks += `<text x="${f1(x)}" y="${base + FLAP + 5}" class="lb" text-anchor="middle">${a % 360}°${compass(a % 360) ? ' ' + compass(a % 360) : ''}</text>`;
  }
  return `<figure class="part"><figcaption>Wall part ${p + 1} of ${PARTS} · azimuth ${a0}°–${a0 + SEG_DEG}° · printed side faces the lander</figcaption>
  <svg width="${f1(w + 12)}mm" height="${f1(h)}mm" viewBox="-6 0 ${f1(w + 12)} ${f1(h)}">
    <path d="${tab}" class="tab"/><text x="${f1(SEG + TAB / 2)}" y="${f1((tabTop + base) / 2)}" class="tiny" text-anchor="middle" transform="rotate(90 ${f1(SEG + TAB / 2)} ${f1((tabTop + base) / 2)})">glue under part ${(p + 1) % PARTS + 1}</text>
    <path d="${outline}" class="cut"/>
    <line x1="0" y1="${base}" x2="${f1(SEG)}" y2="${base}" class="fold"/>
    ${ticks}
    <text x="3" y="${base + FLAP - 2}" class="tiny">fold flap back, glue to the disc on the circle</text>
  </svg></figure>`;
}

function baseDisc() {
  const C = 92, size = C * 2;
  let ticks = '';
  for (let a = 0; a < 360; a += 5) {
    const big = a % 30 === 0, r1 = RW, r2 = RW + (big ? 6 : 3);
    const s = Math.sin(a * D2R), c = -Math.cos(a * D2R);   // azimuth clockwise from up (north)
    ticks += `<line x1="${f1(C + r1 * s)}" y1="${f1(C + r1 * c)}" x2="${f1(C + r2 * s)}" y2="${f1(C + r2 * c)}" class="tk"/>`;
    if (big) ticks += `<text x="${f1(C + (RW - 7) * s)}" y="${f1(C + (RW - 7) * c + 1.1)}" class="lb" text-anchor="middle">${a}°${compass(a) ? ' ' + compass(a) : ''}</text>`;
  }
  // exaggerated horizon as a ring, for orientation only
  let ring = '';
  for (let a = 0; a <= 360; a += 2) {
    const r = 18 + (wallH(a % 360) - minH) / (maxH - minH + 1e-6) * 26;
    ring += `${ring ? 'L' : 'M'}${f1(C + r * Math.sin(a * D2R))},${f1(C - r * Math.cos(a * D2R))} `;
  }
  return `<svg width="${size}mm" height="${size}mm" viewBox="0 0 ${size} ${size}">
    <circle cx="${C}" cy="${C}" r="${C - 0.5}" class="cutlight"/>
    <circle cx="${C}" cy="${C}" r="${RW}" class="wallline"/>
    ${ticks}
    <path d="${ring}Z" class="ring"/>
    <path d="M${C},${C - RW + 12} l-3,7 h6 Z" class="north"/>
    <line x1="${C - 6}" y1="${C}" x2="${C + 6}" y2="${C}" class="tk"/><line x1="${C}" y1="${C - 6}" x2="${C}" y2="${C + 6}" class="tk"/>
    <circle cx="${C}" cy="${C}" r="3" class="tk" fill="none"/>
    <text x="${C}" y="${C + 11}" class="lb" text-anchor="middle">lander sensor (${S / 10} cm high)</text>
    <text x="${C}" y="${C + 15.5}" class="tiny" text-anchor="middle">grey ring = horizon shape (higher = taller wall)</text>
  </svg>`;
}

// ------------------------------------------------------------------ page
const coords = `${Math.abs(site.lat).toFixed(2)}°S, ${site.lon.toFixed(2)}°E`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>${site.name} crater template</title><style>
@page { size: letter portrait; margin: 12mm; }
@page land { size: letter landscape; margin: 10mm; }
* { box-sizing: border-box; }
body { margin: 0; font: 10pt/1.45 Inter, "Segoe UI", Arial, sans-serif; color: #111; }
.page { break-after: page; } .page:last-child { break-after: auto; }
.land { page: land; }
h1 { font: 600 22pt/1.1 Georgia, serif; margin: 0 0 2mm; } h2 { font-size: 11pt; margin: 6mm 0 2mm; }
.meta { color: #555; margin: 0 0 5mm; }
table { border-collapse: collapse; } td { padding: 1mm 4mm 1mm 0; vertical-align: top; } td:first-child { color: #555; }
ol { padding-left: 5mm; margin: 0; } li { margin-bottom: 1.6mm; }
.scale { margin-top: 6mm; } .bar { width: 100mm; height: 4mm; border: .3mm solid #111; background: repeating-linear-gradient(90deg,#111 0 10mm,#fff 10mm 20mm); }
.center { display: flex; flex-direction: column; align-items: center; }
.cut { fill: #fafafa; stroke: #111; stroke-width: .35; } .cutlight { fill: none; stroke: #999; stroke-width: .25; stroke-dasharray: 2 1.5; }
.tab { fill: #fff; stroke: #111; stroke-width: .3; stroke-dasharray: 1.5 1; }
.fold { stroke: #111; stroke-width: .3; stroke-dasharray: 2.5 1.5; }
.wallline { fill: none; stroke: #111; stroke-width: .5; } .ring { fill: #e6e6e6; stroke: #999; stroke-width: .25; }
.north { fill: #111; } .tk { stroke: #111; stroke-width: .3; }
.lb { font-size: 3.2px; fill: #111; } .tiny { font-size: 2.4px; fill: #555; }
figure { margin: 0 0 5mm; } figcaption { font-size: 9pt; margin-bottom: 1mm; }
.foot { color: #777; font-size: 8pt; margin-top: 5mm; }
</style></head><body>

<section class="page">
  <h1>${site.name}: crater template</h1>
  <p class="meta">${coords} · ${site.elevationM} m · Lunar Landing Site Navigator, tabletop model</p>
  <p>This wall recreates the real horizon around ${site.name}, traced from NASA's LRO LOLA polar elevation model (240 m per pixel, out to 320 km). Wall heights are exaggerated ${K}× so a degree of horizon becomes visible on the table. With the Sun LED driven by the app, the lander's light sensor goes dark exactly when the real Sun would set behind the real terrain.</p>
  <h2>Model settings (enter these in the app: Menu → The Model → Model constants)</h2>
  <table>
    <tr><td>s: lander sensor height</td><td><b>${S / 10} cm</b> above the base disc</td></tr>
    <tr><td>k: elevation exaggeration</td><td><b>${K}</b></td></tr>
    <tr><td>Wall radius</td><td>${RW / 10} cm from the lander (the circle on the base disc)</td></tr>
    <tr><td>Wall height</td><td>${f1(minH / 10)} cm (at ${minAz.toFixed(0)}°) to ${f1(maxH / 10)} cm (at ${maxAz.toFixed(0)}°)</td></tr>
    <tr><td>Sun at this site</td><td>${Math.min(...sunEl).toFixed(1)}° to ${Math.max(...sunEl).toFixed(1)}° elevation, Dec 2026 – Jan 2027</td></tr>
  </table>
  <h2>Build it</h2>
  <ol>
    <li>Print at <b>100% / actual size</b> (not "fit to page"). Check the 10 cm bar below with a ruler.</li>
    <li>Glue the pages to card stock (about 300 gsm or cereal-box card). Cut out the base disc and the three wall parts.</li>
    <li>Fix the base disc to the turntable with its centre on the turntable axis.</li>
    <li>Fold each wall flap back along the dashed line. Join the parts in order 1 → 2 → 3 → 1 with the glue tabs, printed side facing the lander, azimuth labels increasing left to right as seen from the centre.</li>
    <li>Glue the flaps on the circle so the wall's 0° mark sits on the disc's N arrow.</li>
    <li>Mount the light sensor at the centre with its face ${S / 10} cm above the disc, looking out sideways.</li>
    <li>Power up with the N arrow pointing at the Sun arm (that is the turntable's 0°). Measure D, P and L for the Sun arm and enter them in the app.</li>
    <li>The Sun at this site dips up to ${Math.abs(Math.min(...sunEl)).toFixed(1)}° below level, so the Sun LED must be able to go lower than the disc top. Raise the disc on a riser (a box or cup about 6 cm tall) on the turntable.</li>
  </ol>
  <div class="scale"><div class="bar"></div><div class="tiny" style="font-size:8pt">10 cm. If this bar isn't 10 cm, the print was scaled.</div></div>
  <p class="foot">Horizon: NASA LRO LOLA LDEM_75S_240M (PDS Geosciences). Sun positions: JPL Horizons. Generated by tools/build-template.mjs from sites.json.</p>
</section>

<section class="page center">
  <h2 style="margin-top:0">Base disc (cut on the dashed circle; the wall stands on the solid circle)</h2>
  ${baseDisc()}
</section>

<section class="page land">
  ${wallPart(0)}
  ${wallPart(1)}
</section>
<section class="page land">
  ${wallPart(2)}
  <div class="scale"><div class="bar"></div><div class="tiny" style="font-size:8pt">10 cm check</div></div>
</section>
</body></html>`;

// ------------------------------------------------------------------ print
mkdirSync(dirname(out), { recursive: true });
const htmlPath = out.replace(/\.pdf$/i, '.html');
writeFileSync(htmlPath, html);
const browsers = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium'
].filter(Boolean);
const chrome = browsers.find(p => existsSync(p));
if (!chrome) { console.log(`no Chrome/Edge found; open ${htmlPath} and print it to PDF at 100%`); process.exit(0); }
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${out}`, pathToFileURL(htmlPath).href], { stdio: 'ignore' });
if (!process.env.KEEP_HTML) unlinkSync(htmlPath);
console.log(`${site.name}: wall ${f1(minH)}–${f1(maxH)} mm, ${PARTS} parts of ${f1(SEG)} mm\nwrote ${out}`);
