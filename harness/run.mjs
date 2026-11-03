import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { PROJECT_ROOT, TEST_PHOTO_ROOT, startServer } from './server.mjs';

const OUT = path.join(PROJECT_ROOT, 'harness', 'out');
const smoke = process.argv.includes('--smoke');
const DEFAULTS = { ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1 };

// Detailed adjustment coverage on the first stock: every EV step, both WB axes,
// both post axes, and two mixed cases that also exercise intensity ordering.
const CORE_CASES = [
  ...[-2, -1, -0.5, 0.5, 1, 2].map((ev) => ({ id: `ev${ev}`, adjustments: { ...DEFAULTS, ev } })),
  { id: 'cool50', adjustments: { ...DEFAULTS, temperature: -50 } },
  { id: 'warm50', adjustments: { ...DEFAULTS, temperature: 50 } },
  { id: 'green50', adjustments: { ...DEFAULTS, tint: -50 } },
  { id: 'magenta50', adjustments: { ...DEFAULTS, tint: 50 } },
  { id: 'contrast-minus1', adjustments: { ...DEFAULTS, contrast: -1 } },
  { id: 'contrast-plus1', adjustments: { ...DEFAULTS, contrast: 1 } },
  { id: 'saturation-0', adjustments: { ...DEFAULTS, saturation: 0 } },
  { id: 'saturation-2', adjustments: { ...DEFAULTS, saturation: 2 } },
  {
    id: 'combined',
    adjustments: { ev: 1, temperature: 50, tint: -50, contrast: 0.25, saturation: 1.2 },
  },
  {
    id: 'mix-post-order', intensity: 0.5,
    adjustments: { ev: 0.5, temperature: -50, tint: 50, contrast: 0.5, saturation: 1.5 },
  },
  {
    id: 'compare-untouched', intensity: 0,
    adjustments: { ev: 2, temperature: 100, tint: 100, contrast: 1, saturation: 2 },
  },
];

// Every stock gets the extended-range camera path and the post-LUT path checked.
const PER_STOCK_CASES = [
  { id: 'asset-ev1', adjustments: { ...DEFAULTS, ev: 1 } },
  { id: 'asset-ev-1', adjustments: { ...DEFAULTS, ev: -1 } },
  { id: 'asset-wb', adjustments: { ...DEFAULTS, temperature: 50, tint: -50 } },
  { id: 'asset-post', adjustments: { ...DEFAULTS, contrast: 0.4, saturation: 1.4 } },
];

function writeDataUrl(filename, dataUrl) {
  const marker = 'data:image/png;base64,';
  if (!dataUrl.startsWith(marker)) {
    throw new Error(`Unexpected image data URL for ${filename}`);
  }
  return fs.writeFile(filename, Buffer.from(dataUrl.slice(marker.length), 'base64'));
}

function runPython() {
  return new Promise((resolve, reject) => {
    const bundledPython = '/workspace/venv-sf/bin/python';
    const python = process.env.PYTHON || bundledPython;
    const child = spawn(python, [path.join(PROJECT_ROOT, 'harness', 'compare.py')], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Python comparison failed (code=${code}, signal=${signal})`));
      }
    });
  });
}

async function main() {
  const allPhotos = (await fs.readdir(TEST_PHOTO_ROOT))
    .filter((name) => /^p.*\.jpg$/i.test(name))
    .map((name) => path.basename(name, path.extname(name)))
    .sort();
  if (!smoke && allPhotos.length !== 6) {
    throw new Error(`Expected six phone JPEGs in ${TEST_PHOTO_ROOT}, found ${allPhotos.length}`);
  }
  if (!allPhotos.length) {
    throw new Error(`No phone JPEGs in ${TEST_PHOTO_ROOT}`);
  }
  const photos = smoke ? allPhotos.slice(0, 1) : allPhotos;
  const manifest = JSON.parse(await fs.readFile(
    path.join(PROJECT_ROOT, 'subpackages', 'luts', 'luts.json'), 'utf8'
  ));
  const stocks = smoke ? manifest.slice(0, 1) : manifest;
  if (!smoke && stocks.length !== 11) {
    throw new Error(`Expected 11 stocks, found ${stocks.length}`);
  }
  if (!smoke && stocks.some((stock) => !stock.extended)) {
    throw new Error('Every stock needs its Phase-4a extended LUT');
  }

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, 'inputs'), { recursive: true });
  await fs.mkdir(path.join(OUT, 'thumbs'), { recursive: true });
  for (const stock of stocks) {
    await fs.mkdir(path.join(OUT, stock.id), { recursive: true });
    await fs.mkdir(path.join(OUT, 'adjustments', stock.id), { recursive: true });
  }

  const host = await startServer();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome',
      headless: true,
      protocolTimeout: 180000,
      args: [
        '--use-gl=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--headless=new',
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
    page.on('pageerror', (error) => console.error('Browser error:', error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        console.error('Browser console:', message.text());
      }
    });
    await page.goto(`${host.url}/harness/index.html`, { waitUntil: 'networkidle0' });
    const webgl = await page.evaluate(() => window.spektrafilmHarness.initialise());
    console.log('WebGL:', JSON.stringify(webgl));

    const results = [];
    for (const photo of photos) {
      console.log(`Preparing ${photo}…`);
      const input = await page.evaluate((name) => window.spektrafilmHarness.loadPhoto(name), photo);
      const inputPath = path.join(OUT, 'inputs', `${photo}.png`);
      await writeDataUrl(inputPath, input.dataUrl);
      console.log(`  ${input.sourceWidth}×${input.sourceHeight} → ${input.width}×${input.height}`);

      for (const stock of stocks) {
        const prefix = path.join(OUT, stock.id, photo);
        const full = await page.evaluate(
          (id) => window.spektrafilmHarness.render(id, 1, {
            ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
          }),
          stock.id
        );
        const shaderPath = `${prefix}-shader.png`;
        await writeDataUrl(shaderPath, full.dataUrl);
        const result = {
          stock: stock.id,
          photo,
          input: path.relative(OUT, inputPath),
          shader: path.relative(OUT, shaderPath),
          python: path.relative(OUT, `${prefix}-python.png`),
          diff: path.relative(OUT, `${prefix}-diff.png`),
          renderMs: full.renderMs,
          width: full.width,
          height: full.height,
          intensityChecks: null,
        };

        if (photo === photos[0]) {
          // Intensity 0 must return the untouched original even with extreme
          // camera and post settings applied.
          const zero = await page.evaluate(
            (id) => window.spektrafilmHarness.render(id, 0, {
              ev: 2, temperature: 100, tint: 100, contrast: 1, saturation: 2,
            }),
            stock.id
          );
          const half = await page.evaluate(
            (id) => window.spektrafilmHarness.render(id, 0.5, {
              ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
            }),
            stock.id
          );
          const zeroPath = `${prefix}-intensity-0.png`;
          const halfPath = `${prefix}-intensity-0.5.png`;
          await writeDataUrl(zeroPath, zero.dataUrl);
          await writeDataUrl(halfPath, half.dataUrl);
          result.intensityChecks = {
            zero: path.relative(OUT, zeroPath),
            half: path.relative(OUT, halfPath),
          };
        }
        results.push(result);
        console.log(`  ${stock.id}: ${full.renderMs.toFixed(2)} ms`);
      }
    }

    // Reload the first photo at full preview size so the adjustment cases and
    // the thumbnails share exactly the exported reference input.
    const firstPhoto = photos[0];
    console.log(`Preparing ${firstPhoto} for adjustment and thumbnail paths…`);
    const adjustmentInput = await page.evaluate(
      (name) => window.spektrafilmHarness.loadPhoto(name), firstPhoto
    );
    const adjustmentInputPath = path.join(OUT, 'inputs', `${firstPhoto}.png`);

    const adjustmentPairs = [];
    const requested = [];
    for (const item of CORE_CASES) {
      requested.push({ ...item, stock: stocks[0].id });
    }
    for (const stock of stocks) {
      for (const item of PER_STOCK_CASES) {
        requested.push({ ...item, stock: stock.id });
      }
    }
    for (const item of requested) {
      const intensity = item.intensity === undefined ? 1 : item.intensity;
      const rendered = await page.evaluate(
        ({ stock, amount, adjustments }) => window.spektrafilmHarness.render(stock, amount, adjustments),
        { stock: item.stock, amount: intensity, adjustments: item.adjustments }
      );
      const prefix = path.join(OUT, 'adjustments', item.stock, `${firstPhoto}-${item.id}`);
      const shaderPath = `${prefix}-shader.png`;
      await writeDataUrl(shaderPath, rendered.dataUrl);
      adjustmentPairs.push({
        stock: item.stock,
        photo: firstPhoto,
        case: item.id,
        adjustments: item.adjustments,
        intensity,
        input: path.relative(OUT, adjustmentInputPath),
        shader: path.relative(OUT, shaderPath),
        python: path.relative(OUT, `${prefix}-python.png`),
        diff: path.relative(OUT, `${prefix}-diff.png`),
        renderMs: rendered.renderMs,
        width: rendered.width,
        height: rendered.height,
      });
    }
    console.log(`  adjustment pairs: ${adjustmentPairs.length}`);

    const thumbnails = [];
    const stockSwitches = [];
    for (const stock of stocks) {
      const thumbnail = await page.evaluate((id) => window.spektrafilmHarness.thumbnail(id), stock.id);
      const thumbnailPath = path.join(OUT, 'thumbs', `${stock.id}.png`);
      await writeDataUrl(thumbnailPath, thumbnail.dataUrl);
      thumbnails.push({
        stock: stock.id,
        file: path.relative(OUT, thumbnailPath),
        width: thumbnail.width,
        height: thumbnail.height,
        cropRect: thumbnail.cropRect,
        boxAspect: thumbnail.boxAspect,
        imageMode: thumbnail.imageMode,
        imageUvOffset: thumbnail.imageUvOffset,
        imageUvScale: thumbnail.imageUvScale,
        switchMs: thumbnail.switchMs,
        timing: thumbnail.timing,
        restored: thumbnail.restored,
        liveAdjustments: thumbnail.liveAdjustments,
      });
      stockSwitches.push(await page.evaluate(
        (id) => window.spektrafilmHarness.timeStockSwitch(id), stock.id
      ));
      console.log(
        `  thumbnail ${stock.id}: ${thumbnail.switchMs.toFixed(2)} ms; ` +
        `full switch ${stockSwitches[stockSwitches.length - 1].switchMs.toFixed(2)} ms`
      );
    }

    const lutContract = await page.evaluate(
      (id) => window.spektrafilmHarness.verifyLutContract(id), stocks[0].id
    );
    if (!lutContract.noExtended || !lutContract.drawWithoutExtendedThrows ||
      !lutContract.extendedAccepted) {
      throw new Error(`LUT upload contract failed: ${JSON.stringify(lutContract)}`);
    }

    const renderResults = {
      generatedAt: new Date().toISOString(),
      smoke,
      photos,
      stocks: stocks.map((stock) => stock.id),
      webgl,
      pairs: results,
      lutContract,
      adjustmentInput: path.relative(OUT, adjustmentInputPath),
      adjustmentInputSize: { width: adjustmentInput.width, height: adjustmentInput.height },
      adjustmentPairs,
      thumbnails,
      stockSwitches,
    };
    await fs.writeFile(
      path.join(OUT, 'render-results.json'), `${JSON.stringify(renderResults, null, 2)}\n`
    );
  } finally {
    if (browser) {
      await browser.close();
    }
    await host.close();
  }

  await runPython();
  console.log(`Harness report: ${path.join(OUT, 'report.md')}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
