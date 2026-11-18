// Teste ponta a ponta com um print REAL da tela de cartas (test/fixtures/cartas-warwick-1080p.webp):
// recorta a faixa padrão dos títulos, roda o OCR e confere as 3 cartas. Uso: npm run test:e2e
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { DataStore } = require('../src/data');
const { AugmentMatcher, normalize } = require('../src/matcher');
const { createOcrWorker, recognize, upscaleFor, DEFAULT_REGION } = require('../src/ocr');

const FIXTURE = path.join(__dirname, 'fixtures', 'cartas-warwick-1080p.webp');
const EXPECTED = ['Transmutar: Prismático', 'Corpo Celestial', 'Recursão'];

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // não sair ao fechar a janela auxiliar
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(path.join(os.tmpdir(), 'mayhem-e2e.log'), s + '\n'); };
async function loadImage(file) {
  const win = new BrowserWindow({ width: 1920, height: 1080, show: false, useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true } });
  win.setContentSize(1920, 1080);
  const b64 = fs.readFileSync(file).toString('base64');
  await win.loadURL(`data:text/html,<body style="margin:0;overflow:hidden"><img style="display:block;width:1920px;height:1080px" src="data:image/webp;base64,${b64}"></body>`);
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.capturePage();
  win.destroy();
  return img;
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    const tmp = path.join(os.tmpdir(), 'mayhem-e2e');
    const store = new DataStore(path.join(tmp, 'cache'));
    await store.init();
    const matcher = new AugmentMatcher(store.augments);
    const img = await loadImage(FIXTURE);
    const sz = img.getSize();
    const r = DEFAULT_REGION;
    const crop = img.crop({ x: Math.round(sz.width * r.x), y: Math.round(sz.height * r.y), width: Math.round(sz.width * r.w), height: Math.round(sz.height * r.h) });
    const worker = await createOcrWorker(path.join(tmp, 'tessdata'));
    await recognize(worker, crop, { scale: upscaleFor(sz.height) }); // aquecimento
    const times = [];
    let matches = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      const { lines } = await recognize(worker, crop, { scale: upscaleFor(sz.height) });
      times.push(Date.now() - t);
      matches = matcher.match(lines, { frameHeight: sz.height });
    }
    await worker.terminate();

    // Custo da captura de tela (só em memória, nada é salvo).
    const d = screen.getPrimaryDisplay();
    const t0 = Date.now();
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: d.size.width * d.scaleFactor, height: d.size.height * d.scaleFactor } });
    const capMs = Date.now() - t0;

    const got = matches.map((m) => store.augments[m.id].namePt);
    log(`OCR: ${times.join(' / ')} ms · captura de tela: ${capMs} ms`);
    log('Cartas:', got.join(' | '));
    if (JSON.stringify(got.map(normalize)) !== JSON.stringify(EXPECTED.map(normalize))) {
      log('FALHOU: esperado', EXPECTED.join(' | '));
      code = 1;
    } else log('E2E OK');
  } catch (e) {
    log('ERRO', e.stack);
    code = 1;
  }
  app.exit(code);
});
