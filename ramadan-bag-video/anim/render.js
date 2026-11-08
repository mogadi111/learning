// Renders index.html to frames with Playwright and encodes with ffmpeg.
//   node render.js stills <outDir> 1.2 5.5 ...   -> PNG stills at given times
//   node render.js video <out.mp4> [workers]     -> full 60s, 30fps, 1080x1920 H.264
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FPS = 30, DURATION = 68, W = 1080, H = 1920;
const PAGE = 'file://' + path.resolve(__dirname, 'index.html');

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') console.log('[page]', m.text()); });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(PAGE);
  await page.evaluate(() => window.ready);
  return page;
}

async function stills(outDir, times) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const page = await openPage(browser);
  for (const t of times) {
    await page.evaluate(tt => window.render(tt), t);
    const f = path.join(outDir, `t${String(t.toFixed(2)).padStart(5, '0')}.png`);
    await page.locator('#stage').screenshot({ path: f });
    console.log(f);
  }
  await browser.close();
}

function encoder(out) {
  return spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(FPS), out], { stdio: ['pipe', 'inherit', 'inherit'] });
}

async function renderRange(browser, from, to, out, label) {
  const page = await openPage(browser);
  const ff = encoder(out);
  const t0 = Date.now();
  for (let f = from; f < to; f++) {
    await page.evaluate(tt => window.render(tt), f / FPS);
    const buf = await page.locator('#stage').screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if ((f - from) % 90 === 0) console.log(`${label}: frame ${f} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  await page.close();
}

async function video(out, workers = 3) {
  const total = FPS * DURATION;
  const chunk = Math.ceil(total / workers);
  const dir = path.join(path.dirname(path.resolve(out)), '.parts');
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const parts = [];
  await Promise.all(Array.from({ length: workers }, (_, i) => {
    const a = i * chunk, b = Math.min(total, a + chunk);
    const p = path.join(dir, `part${i}.mp4`); parts.push(p);
    return renderRange(browser, a, b, p, `w${i}`);
  }));
  await browser.close();
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, parts.map(p => `file '${p}'`).join('\n'));
  await new Promise((res, rej) => spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], { stdio: 'inherit' })
    .on('close', c => c === 0 ? res() : rej(new Error('concat failed'))));
  console.log('wrote', out);
}

(async () => {
  const [mode, out, ...rest] = process.argv.slice(2);
  if (mode === 'stills') await stills(out, rest.map(Number));
  else if (mode === 'video') await video(out, Number(rest[0] || 3));
  else console.log('usage: node render.js stills <dir> t1 t2 ... | video <out.mp4> [workers]');
})().catch(e => { console.error(e); process.exit(1); });
