// Builds samples/sample-questions.pdf and samples/sample-questions.xlsx.
// The PDF is printed by Edge/Chrome (via playwright-core) from simple HTML with SVG diagrams.
// Usage: node tests/make-samples.mjs

import { chromium } from 'playwright-core';
import XLSX from 'xlsx';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'samples');
fs.mkdirSync(out, { recursive: true });

// Diagram positions in mm on an A4 page (210 x 297). The e2e test uses the same numbers.
export const DIAGRAMS = {
  q1: { page: 1, x: 20, y: 35, w: 80, h: 60 },
  q3: { page: 1, x: 20, y: 160, w: 100, h: 60 },
  q4: { page: 2, x: 20, y: 30, w: 90, h: 60 },
  q5: { page: 2, x: 100, y: 125, w: 80, h: 60 },
  q6a: { page: 2, x: 20, y: 250, w: 120, h: 47 }, // continues on page 3
  q6b: { page: 3, x: 20, y: 0, w: 120, h: 40 },
  q7a: { page: 3, x: 20, y: 75, w: 70, h: 50 },
  q7b: { page: 3, x: 110, y: 75, w: 70, h: 50 },
  q8: { page: 3, x: 20, y: 165, w: 80, h: 50 },
};

const svg = {
  incline: `<svg viewBox="0 0 160 120"><polygon points="10,110 150,110 150,30" fill="#dde8f5" stroke="#123" stroke-width="2"/><rect x="85" y="52" width="26" height="18" transform="rotate(-30 98 61)" fill="#f4b183" stroke="#123" stroke-width="2"/><text x="120" y="104" font-size="12">30°</text><text x="12" y="20" font-size="12">Fig. 1</text></svg>`,
  circuit: `<svg viewBox="0 0 200 120"><rect x="20" y="20" width="160" height="80" fill="none" stroke="#111" stroke-width="2"/><rect x="80" y="12" width="40" height="16" fill="#fff" stroke="#111" stroke-width="2"/><text x="92" y="10" font-size="11">4 Ω</text><line x1="20" y1="50" x2="20" y2="70" stroke="#fff" stroke-width="4"/><line x1="12" y1="52" x2="28" y2="52" stroke="#111" stroke-width="3"/><line x1="16" y1="66" x2="24" y2="66" stroke="#111" stroke-width="3"/><text x="30" y="64" font-size="11">12 V</text><rect x="172" y="45" width="16" height="30" fill="#fff" stroke="#111" stroke-width="2"/><text x="150" y="112" font-size="11">6 Ω</text></svg>`,
  graph: `<svg viewBox="0 0 180 120"><line x1="20" y1="100" x2="170" y2="100" stroke="#111" stroke-width="2"/><line x1="20" y1="100" x2="20" y2="10" stroke="#111" stroke-width="2"/><polyline points="20,100 60,40 100,40 140,90" fill="none" stroke="#b42318" stroke-width="3"/><text x="150" y="114" font-size="11">t (s)</text><text x="24" y="16" font-size="11">v (m/s)</text></svg>`,
  lens: `<svg viewBox="0 0 180 120"><line x1="5" y1="60" x2="175" y2="60" stroke="#555" stroke-dasharray="4 3"/><ellipse cx="90" cy="60" rx="10" ry="50" fill="#cfe8ff" stroke="#123" stroke-width="2"/><line x1="30" y1="60" x2="30" y2="30" stroke="#17753a" stroke-width="3"/><polyline points="30,30 90,30 150,85" fill="none" stroke="#e08" stroke-width="1.5"/><text x="20" y="80" font-size="11">O</text><text x="138" y="100" font-size="11">I</text></svg>`,
  tall: `<svg viewBox="0 0 240 174" preserveAspectRatio="none"><rect x="2" y="2" width="236" height="170" fill="#fff7e0" stroke="#8a5a00" stroke-width="3"/><path d="M20 160 C 60 10, 120 10, 220 150" fill="none" stroke="#0b5cad" stroke-width="4"/><text x="12" y="24" font-size="14">Fig. 6 (part 1: top)</text></svg>`,
  tall2: `<svg viewBox="0 0 240 148" preserveAspectRatio="none"><rect x="2" y="2" width="236" height="144" fill="#fff7e0" stroke="#8a5a00" stroke-width="3"/><path d="M20 10 C 80 140, 160 140, 220 20" fill="none" stroke="#0b5cad" stroke-width="4"/><text x="12" y="138" font-size="14">Fig. 6 (part 2: bottom)</text></svg>`,
  pulley: `<svg viewBox="0 0 140 100"><circle cx="70" cy="22" r="16" fill="#eee" stroke="#111" stroke-width="2"/><line x1="54" y1="22" x2="54" y2="70" stroke="#111" stroke-width="2"/><line x1="86" y1="22" x2="86" y2="55" stroke="#111" stroke-width="2"/><rect x="42" y="70" width="24" height="22" fill="#9ecae1" stroke="#111" stroke-width="2"/><rect x="74" y="55" width="24" height="30" fill="#fdae6b" stroke="#111" stroke-width="2"/><text x="44" y="98" font-size="10">2 kg</text></svg>`,
  molecule: `<svg viewBox="0 0 140 100"><line x1="30" y1="50" x2="70" y2="30" stroke="#111" stroke-width="3"/><line x1="70" y1="30" x2="110" y2="50" stroke="#111" stroke-width="3"/><line x1="70" y1="30" x2="70" y2="5" stroke="#111" stroke-width="3"/><circle cx="30" cy="50" r="10" fill="#e34a33"/><circle cx="70" cy="30" r="12" fill="#444"/><circle cx="110" cy="50" r="10" fill="#e34a33"/><text x="45" y="90" font-size="12">Structure X</text></svg>`,
  prism: `<svg viewBox="0 0 160 100"><polygon points="80,8 140,92 20,92" fill="#e6f0e6" stroke="#123" stroke-width="2"/><polyline points="0,60 55,55 105,58 160,80" fill="none" stroke="#c00" stroke-width="2"/><text x="72" y="84" font-size="12">60°</text></svg>`,
};

const text = (y, t) => `<p class="q" style="top:${y}mm">${t}</p>`;
const fig = (d, s) => `<div class="fig" style="left:${d.x}mm;top:${d.y}mm;width:${d.w}mm;height:${d.h}mm">${s}</div>`;
const D = DIAGRAMS;

const html = `<!doctype html><html><head><style>
@page { size: A4; margin: 0; }
body { margin: 0; font: 11pt Georgia, serif; }
.page { position: relative; width: 210mm; height: 297mm; overflow: hidden; page-break-after: always; }
.page:last-child { page-break-after: auto; }
.q { position: absolute; left: 20mm; right: 20mm; margin: 0; }
.fig { position: absolute; }
.fig svg { width: 100%; height: 100%; display: block; }
.foot { position: absolute; bottom: 6mm; width: 100%; text-align: center; font-size: 9pt; color: #666; }
</style></head><body>
<div class="page">
  ${text(15, '<b>Q1.</b> A block of mass 2 kg rests on a smooth incline of 30° as shown in the figure. Find its acceleration.')}
  ${fig(D.q1, svg.incline)}
  ${text(110, '<b>Q2.</b> The dimensional formula of Planck\'s constant is (A) ML²T⁻¹ (B) MLT⁻² (C) ML²T⁻² (D) MLT⁻¹')}
  ${text(140, '<b>Q3.</b> In the circuit shown, find the current through the 4 Ω resistor.')}
  ${fig(D.q3, svg.circuit)}
  <div class="foot">Page 1</div>
</div>
<div class="page">
  ${text(15, '<b>Q4.</b> The velocity–time graph of a particle is shown. Find the distance travelled.')}
  ${fig(D.q4, svg.graph)}
  ${text(110, '<b>Q5.</b> An object is placed in front of a convex lens as shown. Locate the image.')}
  ${fig(D.q5, svg.lens)}
  ${text(235, '<b>Q6.</b> The curve below continues on the next page. Find the maximum.')}
  ${fig(D.q6a, svg.tall)}
</div>
<div class="page">
  ${fig(D.q6b, svg.tall2)}
  ${text(60, '<b>Q7.</b> Two arrangements are shown: (a) a pulley system and (b) a molecule.')}
  ${fig(D.q7a, svg.pulley)}
  ${fig(D.q7b, svg.molecule)}
  ${text(150, '<b>Q8.</b> A ray passes through the prism shown. Find the angle of deviation.')}
  ${fig(D.q8, svg.prism)}
  <div class="foot">Page 3</div>
</div>
</body></html>`;

async function main() {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage();
  await page.setContent(html);
  await page.pdf({ path: path.join(out, 'sample-questions.pdf'), format: 'A4', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
  await makePhonePdf(browser);
  await browser.close();

  const rows = [
    ['qno', 'text', 'imagePath', 'subject'],
    [1, 'A block of mass 2 kg rests on a smooth incline of 30° as shown in the figure. Find its acceleration. Take g = 10 m/s² and ignore friction everywhere. Give the answer to two decimal places, showing all your working.', 'q1_fig1.png', 'Physics'],
    [2, 'The dimensional formula of Planck\'s constant is', '', 'Physics'],
    [3, 'In the circuit shown, find the current through the 4 Ω resistor.', 'q3_fig1.png', 'Physics'],
    [4, 'The velocity–time graph of a particle is shown. Find the distance travelled.', 'Q4 Fig 1.PNG', 'Physics'],
    [5, 'An object is placed in front of a convex lens as shown. Locate the image.', 'images/q5_fig1.png', 'Physics'],
    [6, 'The curve below continues on the next page. Find the maximum.', 'q6_fig1', 'Maths'],
    [7, 'Two arrangements are shown: (a) a pulley system and (b) a molecule.', 'q7_fig1.png, q7_fig2.png', 'Physics'],
    [8, 'A ray passes through the prism shown. Find the angle of deviation.', 'q8_fig1.png', 'Physics'],
    [9, 'Same prism as Q8. Find the refractive index.', 'q8_fig1.png', 'Physics'],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Questions');
  XLSX.writeFile(wb, path.join(out, 'sample-questions.xlsx'));
  console.log('Wrote samples/sample-questions.pdf and samples/sample-questions.xlsx');
}

/**
 * "Phone photo" version: pages 1 and 3 on yellowish paper, with an uneven shadow, camera grain, slight blur
 * and a tilt. Page n of the phone PDF shows original page PHONE[n-1].src rotated by PHONE[n-1].angle degrees
 * around the page centre.
 */
export const PHONE = [{ src: 1, angle: 3 }, { src: 3, angle: -2 }];

async function makePhonePdf(browser) {
  const shotPage = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
  const pagesHtml = html.split('<div class="page">').slice(1).map((p) => `<div class="page">${p}`);
  const head = html.slice(0, html.indexOf('<div class="page">'));
  const images = [];
  for (const ph of PHONE) {
    await shotPage.setContent(`${head}${pagesHtml[ph.src - 1].replace(/<\/body><\/html>$/, '')}</body></html>`);
    images.push((await shotPage.screenshot({ type: 'png' })).toString('base64'));
  }
  await shotPage.setContent('<canvas id="c"></canvas>');
  const jpgs = await shotPage.evaluate(async ({ images, phone }) => {
    const out = [];
    for (let k = 0; k < images.length; k++) {
      const im = new Image();
      im.src = `data:image/png;base64,${images[k]}`;
      await im.decode();
      const W = im.width, H = im.height;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#e8dfc4'; // yellowish paper
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate((phone[k].angle * Math.PI) / 180);
      ctx.filter = 'blur(0.9px)';
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(im, -W / 2, -H / 2);
      ctx.restore();
      // uneven light: dark shadow from one corner, bright spot elsewhere
      ctx.globalCompositeOperation = 'multiply';
      const g = ctx.createLinearGradient(0, 0, W, H * 0.7);
      g.addColorStop(0, 'rgba(90,90,100,0.75)');
      g.addColorStop(0.45, 'rgba(200,200,205,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
      // camera grain
      const id = ctx.getImageData(0, 0, W, H);
      let seed = 12345 + k;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let i = 0; i < id.data.length; i += 4) {
        const n = (rnd() - 0.5) * 26;
        id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n;
      }
      ctx.putImageData(id, 0, 0);
      out.push(c.toDataURL('image/jpeg', 0.85));
    }
    return out;
  }, { images, phone: PHONE });
  const doc = `<!doctype html><html><head><style>@page{size:A4;margin:0}body{margin:0}
    img{display:block;width:210mm;height:297mm;page-break-after:always}img:last-child{page-break-after:auto}</style></head>
    <body>${jpgs.map((j) => `<img src="${j}">`).join('')}</body></html>`;
  await shotPage.setContent(doc);
  await shotPage.pdf({ path: path.join(out, 'phone-questions.pdf'), format: 'A4', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
  await shotPage.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
