// Real-Canvas2D verification of the photo decode path (utils/photo.js).
//
// The production photo module is loaded in a real browser and driven with
// genuine Image/Canvas objects. Every EXIF orientation is combined with every
// getImageInfo/Image dimension combination, at a downscale, at 1:1 and at an
// export size, and the produced pixels are compared with an independently
// computed whole-image reference.
//
// The optional real user photo is used when the fixture is present.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { PROJECT_ROOT, TEST_PHOTO_ROOT, startServer } from './server.mjs';

const OUT = path.join(PROJECT_ROOT, 'harness', 'out', 'photo-real');
const USER_PHOTO = path.join(TEST_PHOTO_ROOT, 'user-9x16-window.jpg');

async function main() {
  let userPhotoUrl = null;
  try {
    await fs.access(USER_PHOTO);
    userPhotoUrl = '/testphotos/user-9x16-window.jpg';
  } catch (error) {
    userPhotoUrl = null;
  }

  await fs.mkdir(OUT, { recursive: true });
  const host = await startServer();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome',
      headless: true,
      protocolTimeout: 600000,
      args: [
        '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist',
        '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--no-sandbox',
        '--headless=new',
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
    page.on('pageerror', (error) => console.error('Browser error:', error.message));
    await page.goto(`${host.url}/harness/index.html`, { waitUntil: 'networkidle0' });
    await page.addScriptTag({ url: '/harness/photo-real.js' });
    const result = await page.evaluate(
      (userUrl) => window.runRealPhotoTests({ userPhotoUrl: userUrl }),
      userPhotoUrl
    );

    // 8 orientations x 4 dimension combinations x 3 output sizes.
    assert.equal(result.cases.length, 96, 'every orientation/combination/size must run');
    assert.deepEqual(result.failures, [], `photo failures: ${JSON.stringify(result.failures)}`);

    // The decision rows for EXIF 6 ('right') must match the documented table.
    const right = result.cases.filter((item) => item.orientation === 'right');
    const rows = {};
    right.forEach((item) => {
      rows[item.name] = item.decisionRow;
    });
    assert.deepEqual(rows, {
      'raw-image-raw-info': 'B',
      'engine-image-raw-info': 'A',
      'raw-image-upright-info': 'C',
      'engine-image-upright-info': 'D',
    });

    // Every case must reproduce the reference pixels (no crop, no stretch).
    result.cases.forEach((item) => {
      assert.ok(item.meanAbsDiff <= 2,
        `${item.orientation}/${item.name}/${item.mode}: mean ${item.meanAbsDiff}`);
      assert.ok(item.maxAbsDiff <= 8,
        `${item.orientation}/${item.name}/${item.mode}: max ${item.maxAbsDiff}`);
      assert.ok(item.aspectError < 0.02,
        `${item.orientation}/${item.name}/${item.mode}: aspect ${item.aspectError}`);
      assert.ok(item.scaleX > 0 && item.scaleY > 0, 'scale factors must be positive');
    });

    // The old 5-argument draw produced a magnified top-left crop.
    assert.equal(result.regression.bottomRightIsCyan, true,
      'the decode canvas must contain the whole source, not its top-left crop');
    assert.deepEqual(result.regression.outputSize, [200, 150]);

    if (userPhotoUrl) {
      assert.ok(result.userPhoto, 'the user photo case must run when the fixture exists');
      assert.deepEqual(result.userPhoto.sourceSize, [3213, 5712]);
      assert.deepEqual(result.userPhoto.outputSize, [720, 1280]);
      assert.ok(result.userPhoto.wholeImage,
        `user photo must decode as the whole image (mean ${result.userPhoto.meanAbsDiff})`);
      assert.ok(result.userPhoto.meanAbsDiff <= 2);
    }

    await fs.writeFile(
      path.join(OUT, 'report.json'), `${JSON.stringify(result, null, 2)}\n`
    );
    console.log(
      `Real photo geometry: PASS (${result.cases.length} orientation/combination/size cases; ` +
      'whole-image reference matched; top-left-crop regression caught)'
    );
    if (result.userPhoto) {
      console.log(
        `Real user photo: PASS (3213x5712 -> 720x1280, mean abs diff ` +
        `${result.userPhoto.meanAbsDiff})`
      );
    } else {
      console.log('Real user photo: SKIPPED (fixture not present)');
    }
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
