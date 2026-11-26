// The screenshots on the landing page ("Inside the workspace").
//
// Screenshots taken by hand go stale the day the product changes, and nobody
// notices until the page is showing a design that no longer exists. So they
// are not taken by hand: this runs the real built site in headless Chrome,
// works one example job through it the way a person would (the builder's own
// tools, the beam form's own buttons; see scripts/lib/shots-page.js), and
// photographs each stage.
//
//   npm run shots                build, then retake every picture
//   npm run shots -- --out DIR   write them somewhere else, to look first
//
// The job: a three-bay scaffold with three decks at 50 psf, its four front
// legs sent to a 20 ft beam. The beam carried in the bid is a W8X10, the
// "common guess" the landing page talks about; the check fails it and
// suggests a size, and that size is run and its record printed.
//
// Each picture is written twice, as WebP: at twice its layout size (sharp
// screens, and the larger view the page links to) and at its layout size.
// When it is done it prints the width and height of each, which is what the
// <img> tags in index.html need to be told if a picture changes shape.
//
// Nothing of the product is altered for the camera except three things that
// do not change what it says: corners are squared (the landing page rounds
// them itself), motion is switched off so nothing is caught half way, and
// the builder's canvas is drawn at the screen's full resolution, not the 1.5
// it holds itself to while it is being orbited.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Cdp, browserTargets } from './lib/cdp.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'dist');
const outFlag = process.argv.indexOf('--out');
const OUT = outFlag > -1 && process.argv[outFlag + 1] ? resolve(process.argv[outFlag + 1]) : join(ROOT, 'public', 'marketing', 'screenshots');

const EXAMPLE = {
  project: 'Dock 4 access scaffold',
  preparer: 'Example Contracting',
  guess: 'W8X10',
  spanFt: 20,
  scaffold: { bays: 3, bayFt: 6, depthFt: 7, heightFt: 21, levels: 3 },
  livePsf: 50,
  firstLegFt: 1,
};

// Device pixels per CSS pixel, for the larger of each pair.
const SCALE = 2;
// WebP quality. Type on flat color is unforgiving below about 80; above 90
// the files double for nothing the eye can find.
const QUALITY = 86;
// The builder: tall enough that the Send to beam card shows all four legs
// (its table is held to a share of the window's height).
const BUILDER = { width: 1600, height: 1080 };
// The beam page: the narrowest it lays the verdict and the suggested size
// side by side, which keeps the type as large as it can be in a small frame.
// Tall enough to hold everything that is photographed without scrolling.
const BEAM = { width: 1280, height: 1400 };
// From the model toward the camera: a little lower and squarer to the front
// than the Home view, so the row of legs on the beam faces the reader.
const BUILDER_VIEW = [0.66, -1, 0.6];

const SQUARE_CORNERS = '.sfw-dialog,.panel{border-radius:0!important}';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf',
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

// The calculator page and its bundles are kept out of dist/ so the deployed
// site can only serve them through the paid-access gate (as visual-check.mjs).
const PRIVATE_ASSETS = {
  '/calculator.html': join(ROOT, 'calculator.html'),
  '/app.js': join(ROOT, 'workspace-private', 'app.js'),
  '/scaffold-app.js': join(ROOT, 'workspace-private', 'scaffold-app.js'),
};

// The account the pictures are taken from: signed in, terms accepted, paid,
// and the builder's estimating-use notice already agreed to. Nothing is kept.
const ACCOUNT = {
  'GET /api/auth/session': { configured: true, authenticated: true, termsAccepted: true, profileComplete: true, isAdmin: false },
  'GET /api/billing/status': { canManageBilling: true },
  'GET /api/acknowledgments': { scaffoldNotice: { accepted: true } },
  'POST /api/acknowledgments': {},
  'POST /api/projects': {},
  'GET /api/workspace': { workspace: null },
  'PUT /api/workspace': {},
  'DELETE /api/workspace': {},
};

async function serve() {
  const held = new Map(); // files made during the run and read back by the page
  const send = (res, code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    const account = ACCOUNT[`${req.method} ${path}`];
    if (account) return send(res, 200, MIME['.json'], JSON.stringify(account));
    if (path.startsWith('/api/')) return send(res, 404, MIME['.json'], '{}');
    if (path === '/__shots/blank') return send(res, 200, MIME['.html'], '<!doctype html><meta charset="utf-8"><title>Shot</title><body style="margin:0;background:#fff">');
    if (held.has(path)) return send(res, 200, 'application/octet-stream', held.get(path));
    try {
      let full = PRIVATE_ASSETS[path] || join(DIST, ...path.split('/').filter(part => part && part !== '..'));
      if ((await stat(full)).isDirectory()) full = join(full, 'index.html');
      send(res, 200, MIME[extname(full).toLowerCase()] || 'application/octet-stream', await readFile(full));
    } catch {
      send(res, 404, 'text/plain', 'Not found');
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, held, origin: `http://127.0.0.1:${server.address().port}` };
}

function launchChrome() {
  const bin = CHROME_CANDIDATES.find(existsSync);
  if (!bin) throw new Error(`No Chrome or Edge found. Set CHROME_PATH.\nLooked in:\n  ${CHROME_CANDIDATES.join('\n  ')}`);
  const profile = join(tmpdir(), `scafmetric-shots-${process.pid}`);
  const port = 9800 + (process.pid % 500);
  const child = spawn(bin, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${BUILDER.width},${BUILDER.height}`,
    // Software GL, as the visual check: the same picture on any machine.
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-default-apps', '--disable-background-networking',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    'about:blank',
  ], { stdio: 'ignore' });
  const stop = () => {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  };
  return { bin, port, profile, stop };
}

/** The pixel size of a WebP file, from its header. */
function webpSize(buf) {
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
  if (kind === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  throw new Error('not a WebP file');
}

function must(condition, message) { if (!condition) throw new Error(message); }

async function main() {
  must(existsSync(PRIVATE_ASSETS['/scaffold-app.js']) && existsSync(join(DIST, 'index.html')),
    'The site is not built. Run `npm run build` first (or use `npm run shots`).');

  const { server, held, origin } = await serve();
  const chrome = launchChrome();
  const taken = [];
  let cdp = null;

  try {
    const targets = await browserTargets(chrome.port);
    cdp = await Cdp.attach(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const uncaught = [];
    cdp.on('Runtime.exceptionThrown', p => uncaught.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));

    const viewport = ({ width, height }) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: SCALE, mobile: false });
    const pause = ms => new Promise(done => setTimeout(done, ms));
    const goto = async path => {
      const loaded = new Promise(done => { cdp.on('Page.loadEventFired', done); setTimeout(done, 20000); });
      await cdp.send('Page.navigate', { url: origin + path });
      await loaded;
    };
    const step = (name, arg) => cdp.evaluate(`window.__shots.${name}(${arg === undefined ? '' : JSON.stringify(arg)})`);

    /** Photograph a rectangle of the page, twice: full size and half. */
    const shoot = async (name, rect) => {
      const clip = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      const files = [];
      for (const [scale, suffix] of [[1, '-2x'], [1 / SCALE, '']]) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'webp', quality: QUALITY, clip: { ...clip, scale }, captureBeyondViewport: false });
        const data = Buffer.from(shot.data, 'base64');
        files.push({ file: `${name}${suffix}.webp`, data, ...webpSize(data) });
      }
      taken.push({ name, files });
      console.log(`  ${name}  ${files[1].width} x ${files[1].height}`);
    };

    // Nothing caught half way through a fade or a sweep.
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

    // --- the builder ------------------------------------------------------
    await viewport(BUILDER);
    await goto('/calculator.html');
    await cdp.evaluate(`document.head.appendChild(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(SQUARE_CORNERS)} }))`, { awaitPromise: false });
    await cdp.evaluate(await readFile(join(ROOT, 'scripts', 'lib', 'shots-page.js'), 'utf8'), { awaitPromise: false });
    const page = await step('ready');
    if (!page.inter) console.log('  (Inter did not load, so the type is this machine\'s fallback: check the network and run again)');

    console.log(`Chrome: ${chrome.bin}\nTaking the pictures:`);
    await step('beamStart', { project: EXAMPLE.project, preparer: EXAMPLE.preparer, section: EXAMPLE.guess, spanFt: EXAMPLE.spanFt });
    await step('openBuilder');
    const { bays, bayFt } = EXAMPLE.scaffold;
    const scaffold = await step('buildScaffold', EXAMPLE.scaffold);
    must(scaffold.front.length === bays + 1, `the block should stand ${bays + 1} legs along the front, it stood ${scaffold.front.length}`);
    const decks = await step('loadDecks', { psf: EXAMPLE.livePsf, alongFt: bayFt * 1.5 });
    must(decks.loaded === bays * decks.levels.length, `every bay of every deck should be loaded: ${decks.loaded} of ${bays * decks.levels.length} are`);
    const sent = await step('sendLegs', { at: scaffold.front, firstLegFt: EXAMPLE.firstLegFt });
    must(sent.picked === scaffold.front.length && !sent.warning, `the front legs should all go on the beam: ${JSON.stringify(sent)}`);
    await shoot('01-scaffold-to-beam', await step('composeBuilder', { dir: BUILDER_VIEW, pixelRatio: SCALE }));

    // --- the beam ---------------------------------------------------------
    const guess = await step('importAndRun');
    must(!guess.error && !guess.passed && guess.suggested, `the ${EXAMPLE.guess} should fail and a size be suggested: ${JSON.stringify(guess)}`);
    must(guess.loads.length === sent.picked, `the beam should carry the ${sent.picked} legs sent, it has ${guess.loads.length} point loads`);
    await viewport(BEAM);
    await pause(400);
    let region = await step('regions');
    await shoot('02-loads-on-the-beam', region.model);
    await shoot('03-the-guess-checked', region.check);

    const chosen = await step('useSuggestion');
    must(!chosen.error && chosen.passed && chosen.section === guess.suggested, `the suggested ${guess.suggested} should pass: ${JSON.stringify(chosen)}`);
    await pause(400);
    region = await step('regions');
    await shoot('04-the-size-that-holds', region.results);

    // --- the record -------------------------------------------------------
    // Exported as it is from the page (Export PDF prints it), then its first
    // sheet drawn with the pdf.js the site already ships.
    const pdf = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    held.set('/__shots/record.pdf', Buffer.from(pdf.data, 'base64'));
    await goto('/__shots/blank');
    const sheet = await cdp.evaluate(`(async () => {
      const lib = await import('/pdfjs/pdf.min.mjs');
      lib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
      const data = new Uint8Array(await (await fetch('/__shots/record.pdf')).arrayBuffer());
      const doc = await lib.getDocument({ data, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/' }).promise;
      const first = await doc.getPage(1);
      const size = first.getViewport({ scale: 96 / 72 }); // PDF points to CSS pixels
      const drawn = first.getViewport({ scale: (96 / 72) * ${SCALE} });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(drawn.width); canvas.height = Math.round(drawn.height);
      await first.render({ canvasContext: canvas.getContext('2d'), viewport: drawn }).promise;
      canvas.style.cssText = 'display:block;width:' + size.width + 'px;height:' + size.height + 'px';
      document.body.replaceChildren(canvas);
      return { width: size.width, height: size.height, sheets: doc.numPages };
    })()`);
    await viewport({ width: Math.ceil(sheet.width), height: Math.ceil(sheet.height) });
    await pause(300);
    await shoot('05-calculation-record', { x: 0, y: 0, width: sheet.width, height: sheet.height });

    must(!uncaught.length, `the page threw while it was being photographed:\n  ${uncaught.join('\n  ')}`);

    // Only now, with every picture taken, is anything written.
    await mkdir(OUT, { recursive: true });
    for (const shot of taken) for (const f of shot.files) await writeFile(join(OUT, f.file), f.data);

    const lb = n => Math.round(n).toLocaleString('en-US');
    console.log(`\nThe job in the pictures:`);
    console.log(`  ${bays} bays of ${bayFt} ft, ${decks.levels.length} decks at ${EXAMPLE.livePsf} psf; ${sent.picked} legs on a ${EXAMPLE.spanFt} ft beam`);
    for (const l of guess.loads) console.log(`  ${l.id} at ${l.atFt} ft: ${lb(l.deadLb)} lb dead, ${lb(l.liveLb)} lb live`);
    console.log(`  ${EXAMPLE.guess} fails; ${guess.suggested} is suggested and passes; the record runs to ${sheet.sheets} sheets`);
    console.log(`\nWritten to ${OUT}:`);
    for (const shot of taken) {
      const [large, small] = shot.files;
      console.log(`  ${small.file}  width="${small.width}" height="${small.height}"  ${Math.round(small.data.length / 1024)} KB`);
      console.log(`  ${large.file}  ${large.width}w  ${Math.round(large.data.length / 1024)} KB`);
    }
  } finally {
    if (cdp) cdp.close();
    chrome.stop();
    server.close();
    // Chrome lets go of its profile a moment after it is killed.
    setTimeout(() => rm(chrome.profile, { recursive: true, force: true }).catch(() => {}), 1500);
  }
}

main().catch(err => {
  console.error(`\nNo pictures were written: ${err.message}`);
  process.exitCode = 1;
});
