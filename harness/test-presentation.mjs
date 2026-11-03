// Native-preview geometry and default-framebuffer presentation checks.
// EXIF policy is tested in Node; the browser feeds equivalent already-oriented
// portrait pixels through DPR-mismatched and clamped native-canvas geometry.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
import { PROJECT_ROOT, TEST_PHOTO_ROOT, startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const Renderer = require('../utils/lut-renderer.js');
const Photo = require('../utils/photo.js');
const OUT = path.join(PROJECT_ROOT, 'harness', 'out', 'presentation');

assert.deepEqual(
  Renderer.computeAspectFitRect(640, 400, 480, 640),
  { x: 170, y: 0, width: 300, height: 400 }
);
// The bottom sheet insets the presentation; the buffer itself never changes.
assert.deepEqual(
  Renderer.computePresentationRect(640, 400, 480, 640, { bottom: 0 }),
  Renderer.computeAspectFitRect(640, 400, 480, 640),
  'a zero inset is the plain aspect fit'
);
{
  // 640x800 buffer, 300 px of the bottom covered: a 3:2 landscape photo is
  // fitted into 640x500 and sits above the sheet (GL y is bottom-up).
  const rect = Renderer.computePresentationRect(640, 800, 1500, 1000, { bottom: 300 });
  assert.deepEqual(rect, { x: 0, y: 300 + Math.floor((500 - 427) / 2), width: 640, height: 427 });
  assert.ok(rect.y >= 300, 'the photo never reaches into the covered band');
  // A portrait photo is limited by the visible height, not by the buffer.
  const portrait = Renderer.computePresentationRect(640, 800, 1000, 1500, { bottom: 300 });
  assert.equal(portrait.height, 500);
  assert.equal(portrait.width, 333);
  assert.equal(portrait.x, Math.floor((640 - 333) / 2));
  assert.ok(Math.abs(portrait.width / portrait.height - 1000 / 1500) < 0.01, 'no squeeze');
  // Absurd insets are limited so the photo keeps a quarter of the buffer.
  const huge = Renderer.computePresentationRect(640, 800, 1000, 1000, { bottom: 5000 });
  assert.ok(huge.height >= 200 && huge.y >= 0 && huge.y + huge.height <= 800);
}

const clamped = Renderer.computeDrawingBufferSize(360, 200, 2, {
  maxRenderbufferSize: 320, maxViewportDims: [320, 240],
});
assert.deepEqual(
  { width: clamped.width, height: clamped.height, clamped: clamped.clamped },
  { width: 320, height: 177, clamped: true }
);
for (const orientation of [6, 8]) {
  const decision = Photo.decideExifOrientation({
    orientation, infoWidth: 1600, infoHeight: 1067,
    decodedWidth: 1600, decodedHeight: 1067, mode: 'manual',
  });
  assert.equal(decision.outputWidth, 1067);
  assert.equal(decision.outputHeight, 1600);
}

async function main() {
  const photos = (await fs.readdir(TEST_PHOTO_ROOT))
    .filter((name) => /^p.*\.jpg$/i.test(name))
    .map((name) => path.basename(name, path.extname(name)))
    .sort();
  if (!photos.length) {
    throw new Error(`No phone JPEGs in ${TEST_PHOTO_ROOT}`);
  }
  await fs.mkdir(OUT, { recursive: true });
  const host = await startServer();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome',
      headless: true,
      protocolTimeout: 240000,
      args: [
        '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist',
        '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--no-sandbox',
        '--headless=new',
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 1 });
    page.on('pageerror', (error) => console.error('Browser error:', error.message));
    await page.goto(`${host.url}/harness/index.html`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => window.spektrafilmHarness.initialise());
    await page.evaluate((name) => window.spektrafilmHarness.loadPhoto(name), photos[0]);
    const result = await page.evaluate(
      () => window.spektrafilmHarness.verifyPresentationGeometry()
    );

    assert.equal(result.cases.length, 3);
    result.cases.forEach((item, index) => {
      const probe = item.presentation;
      assert.equal(probe.available, true, `${item.name}: ${JSON.stringify(probe)}`);
      assert.equal(probe.samples.length, 5, item.name);
      assert.ok(probe.maxDiff <= 1,
        `${item.name}: default/FBO max ${probe.maxDiff} code`);
      assert.equal(probe.letterbox.exact, true,
        `${item.name}: letterbox ${JSON.stringify(probe.letterbox)}`);
      const rect = probe.photoRect;
      assert.ok(Math.abs(rect.x * 2 + rect.width - item.buffer.actualWidth) <= 1,
        `${item.name}: horizontal centring`);
      assert.ok(Math.abs(rect.y * 2 + rect.height - item.buffer.actualHeight) <= 1,
        `${item.name}: vertical centring`);
      assert.ok(Math.abs(
        rect.width / rect.height - item.photo.width / item.photo.height
      ) < 0.01, `${item.name}: photo aspect`);
      assert.equal(item.css.canvasStyleWidth, `${item.css.width}px`);
      assert.equal(item.css.canvasStyleHeight, `${item.css.height}px`);
      assert.equal(item.css.actualWidth, item.css.width);
      assert.equal(item.css.actualHeight, item.css.height);
      assert.equal(item.thumbnail.width, 240);
      assert.equal(item.thumbnail.height, 135);
      assert.equal(item.thumbnail.imageMode, 'aspectFill');
      assert.ok(Math.abs(
        item.thumbnail.cropRect.width / item.thumbnail.cropRect.height - 16 / 9
      ) < 1e-9);
      if (index === 2) {
        assert.equal(item.exifOrientation, 8);
        assert.equal(item.buffer.clamped, true);
        assert.equal(item.buffer.requestedWidth, 720);
        assert.equal(item.buffer.requestedHeight, 400);
        assert.equal(item.buffer.actualWidth, 320);
        assert.equal(item.buffer.actualHeight, 177);
      }
    });
    // The sheet inset: same canvas buffer, the photo is raised above the covered band,
    // still pixel-exact (default framebuffer == FBO) and never squeezed.
    {
      const inset = result.inset;
      assert.equal(inset.bufferAfter.width, inset.buffer.actualWidth, 'the buffer width is unchanged');
      assert.equal(inset.bufferAfter.height, inset.buffer.actualHeight, 'the buffer height is unchanged');
      const band = Math.round(inset.insetCssPx * (inset.buffer.actualHeight / inset.buffer.cssHeight));
      assert.equal(inset.with.available, true);
      assert.ok(inset.with.maxDiff <= 1, `inset: default/FBO max ${inset.with.maxDiff}`);
      assert.ok(inset.with.photoRect.y >= band, `the photo stays above the covered band (${inset.with.photoRect.y} < ${band})`);
      assert.ok(inset.with.photoRect.y + inset.with.photoRect.height <= inset.buffer.actualHeight);
      assert.ok(inset.with.photoRect.height < inset.before.photoRect.height, 'the photo shrinks');
      assert.ok(Math.abs(
        inset.with.photoRect.width / inset.with.photoRect.height -
        inset.before.photoRect.width / inset.before.photoRect.height
      ) < 0.01, 'no squeeze');
      assert.deepEqual(inset.after.photoRect, inset.before.photoRect, 'closing the sheet restores the full fit');
    }
    await fs.writeFile(path.join(OUT, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(
      'Presentation checks: PASS (portrait 3:4, oriented EXIF 6/8 fixtures, DPR 2, ' +
      'clamped buffer; default/FBO <= 1 code; letterbox #080808; 16:9 centre crop; sheet inset)'
    );
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
