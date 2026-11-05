// Headless Chrome check of the film border with the real renderer and the
// real Canvas 2D painter:
//
//   * the framed EXPORT (same planner, frame painter and tile offsets as the
//     Mini Program) leaves the graded picture bit-identical to the unframed
//     export and covers every other pixel of the file;
//   * the live PREVIEW clears the margins and places the photo inside them for
//     portrait and landscape, with and without a sheet inset;
//   * sample images of every style are written to harness/out/border/ (and to
//     BORDER_SAMPLES_DIR when set) for visual review.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { PROJECT_ROOT, startServer } from './server.mjs';

const OUT = path.join(PROJECT_ROOT, 'harness', 'out', 'border');
const SAMPLES = process.env.BORDER_SAMPLES_DIR || '';
const STYLES = ['none', 'thin-white', 'polaroid', 'black', 'film35', 'film120'];
const CASES = [
  { key: 'landscape', photo: 'p1015', width: 1600, height: 1067, stock: 'portra400' },
  { key: 'portrait', photo: 'user-9x16-window', width: 1080, height: 1920, stock: 'vision3_500t' },
];
const COLORS = {
  'thin-white': [255, 255, 255],
  polaroid: [244, 241, 232],
  black: [0, 0, 0],
  film35: [12, 11, 10],
  film120: [10, 10, 10],
};

function writeDataUrl(filename, dataUrl) {
  return fs.writeFile(filename, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

function near(actual, expected, tolerance, message) {
  assert.ok(
    actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance),
    `${message}: ${actual} vs ${expected}`
  );
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  if (SAMPLES) {
    await fs.mkdir(SAMPLES, { recursive: true });
  }
  const host = await startServer();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome',
      headless: true,
      protocolTimeout: 600000,
      args: [
        '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist',
        '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--no-sandbox', '--headless=new',
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
    page.on('pageerror', (error) => console.error('Browser error:', error.message));
    await page.goto(`${host.url}/harness/index.html`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => window.spektrafilmHarness.initialise());

    for (const entry of CASES) {
      await page.evaluate(
        ({ photo, width, height }) => window.spektrafilmHarness.loadPhotoSized(photo, width, height),
        entry
      );
      let baseline = null;
      for (const style of STYLES) {
        const result = await page.evaluate(
          ({ stock, width, height, border }) => window.spektrafilmHarness.exportFramed(
            stock, width, height,
            { border, effects: { grain: 1, halation: 1, vignette: 0.3 }, tileSize: 700 }
          ),
          { stock: entry.stock, width: entry.width, height: entry.height, border: style }
        );
        const name = `${entry.key}-${style}`;
        await writeDataUrl(path.join(OUT, `export-${name}.png`), result.dataUrl);
        if (SAMPLES) {
          await writeDataUrl(path.join(SAMPLES, `export-${name}.png`), result.dataUrl);
        }
        const plan = result.plan;
        // Every pixel of the file is either the frame or the graded picture.
        assert.equal(result.poisoned, 0, `${name}: no pixel is left unpainted`);
        assert.equal(plan.width, entry.width, `${name}: the picture is not resampled`);
        assert.equal(plan.height, entry.height);
        assert.equal(plan.outerWidth, plan.width + plan.frame.left + plan.frame.right);
        if (style === 'none') {
          baseline = result;
          assert.equal(plan.outerWidth, plan.width);
          continue;
        }
        // The border is composited AFTER the film look: the graded pixels are
        // bit-identical with and without it.
        assert.equal(
          result.photoChecksum, baseline.photoChecksum,
          `${name}: the border must not change a single graded pixel`
        );
        near(result.samples.corner, COLORS[style], 1, `${name}: the margin colour`);
        console.log(`  ${name}: ${plan.outerWidth}x${plan.outerHeight}, picture unchanged`);

        // The live preview.
        for (const inset of [{ bottom: 0 }, { bottom: 330 }]) {
          const bufferW = 750;
          const bufferH = 1300;
          const preview = await page.evaluate(
            ({ border, bw, bh, inset: sheet }) => window.spektrafilmHarness.previewFramed(border, bw, bh, sheet),
            { border: style, bw: bufferW, bh: bufferH, inset }
          );
          const frame = preview.presentation.frame;
          assert.ok(frame, `${name}: the preview reports its frame`);
          const outer = frame.outerRect;
          const photo = preview.presentation.photoRect;
          assert.ok(outer.y >= inset.bottom - 1, `${name}: the frame stays above the sheet`);
          assert.ok(
            photo.x >= outer.x && photo.y >= outer.y &&
            photo.x + photo.width <= outer.x + outer.width &&
            photo.y + photo.height <= outer.y + outer.height,
            `${name}: the photo lies inside the frame`
          );
          // CSS rect = buffer rect at DPR 1, y flipped.
          assert.ok(Math.abs(frame.cssRect.x - outer.x) < 1e-6);
          assert.ok(Math.abs(frame.cssRect.y - (bufferH - outer.y - outer.height)) < 1e-6);
          if (inset.bottom === 0 && entry.key === 'landscape') {
            await writeDataUrl(path.join(OUT, `preview-gl-${name}.png`), preview.dataUrl);
          }
        }
        const composite = await page.evaluate(
          ({ border, stockName }) => window.spektrafilmHarness.previewComposite(
            border, 750, 1300, { bottom: 0 }, stockName
          ),
          { border: style, stockName: entry.stock === 'portra400' ? 'Kodak Portra 400' : 'Kodak Vision3 500T' }
        );
        await writeDataUrl(path.join(OUT, `preview-${name}.png`), composite.dataUrl);
        if (SAMPLES) {
          await writeDataUrl(path.join(SAMPLES, `preview-${name}.png`), composite.dataUrl);
        }
      }
      // A frame never changes the unframed preview.
      const plain = await page.evaluate(() => window.spektrafilmHarness.previewFramed('none', 750, 1300, { bottom: 0 }));
      assert.equal(plain.presentation.frame, null);
    }
    console.log('Border browser checks: PASS');
  } finally {
    if (browser) {
      await browser.close();
    }
    await host.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
