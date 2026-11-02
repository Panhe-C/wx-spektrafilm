import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { PROJECT_ROOT, TEST_PHOTO_ROOT, startServer } from './server.mjs';

const OUT = path.join(PROJECT_ROOT, 'harness', 'out');
const smoke = process.argv.includes('--smoke');

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

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, 'inputs'), { recursive: true });
  for (const stock of stocks) {
    await fs.mkdir(path.join(OUT, stock.id), { recursive: true });
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
          (id) => window.spektrafilmHarness.render(id, 1),
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
          const zero = await page.evaluate(
            (id) => window.spektrafilmHarness.render(id, 0),
            stock.id
          );
          const half = await page.evaluate(
            (id) => window.spektrafilmHarness.render(id, 0.5),
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

    const renderResults = {
      generatedAt: new Date().toISOString(),
      smoke,
      photos,
      stocks: stocks.map((stock) => stock.id),
      webgl,
      pairs: results,
    };
    await fs.writeFile(path.join(OUT, 'render-results.json'), `${JSON.stringify(renderResults, null, 2)}\n`);
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
