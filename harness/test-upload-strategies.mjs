// Browser verification of both texture upload strategies, automatic recovery
// from a zero-filled direct upload, and the on-device GL diagnostic numbers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { PROJECT_ROOT, TEST_PHOTO_ROOT, startServer } from './server.mjs';

const OUT = path.join(PROJECT_ROOT, 'harness', 'out', 'diagnostics');

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
      protocolTimeout: 180000,
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
      () => window.spektrafilmHarness.verifyUploadStrategiesAndDiagnostics()
    );

    assert.ok(result.comparison.maxDiff <= 1,
      `P versus D differs by ${result.comparison.maxDiff} code(s)`);
    for (const name of ['photo', 'lut', 'lutExtended']) {
      assert.equal(result.comparison.pixelStrategies.find((item) => item.name === name).strategy,
        'pixels', `${name} must exercise P`);
      assert.equal(result.comparison.directStrategies.find((item) => item.name === name).strategy,
        'direct', `${name} must exercise D`);
    }
    assert.equal(result.mockFallback.mockedZeroUploads, 1);
    assert.equal(result.mockFallback.finalStrategy, 'pixels');
    assert.ok(result.mockFallback.recentChecks.some((attempt) => (
      attempt.strategy === 'direct' && !attempt.ok &&
      attempt.selfCheck && attempt.selfCheck.blackFailure
    )), 'the zero-filled direct upload must fail its black self-check');
    assert.ok(result.mockFallback.recentChecks.some((attempt) => (
      attempt.strategy === 'pixels' && attempt.ok
    )), 'strategy P must recover after the injected direct failure');
    assert.ok(result.mockFallback.fallbacks.some((entry) => (
      entry.texture === 'photo' && entry.from === 'direct' && entry.to === 'pixels'
    )));
    assert.equal(result.mockLutFallback.mockedZeroUploads, 1);
    assert.equal(result.mockLutFallback.finalStrategy, 'pixels');
    assert.ok(result.mockLutFallback.recentChecks.some((attempt) => (
      attempt.strategy === 'direct' && !attempt.ok &&
      attempt.selfCheck && attempt.selfCheck.blackFailure &&
      attempt.selfCheck.whiteCorner.cpu.slice(0, 3).some((channel) => channel > 2)
    )), 'the zero-filled LUT must fail against the non-black b=N-1 white tile');
    assert.ok(result.mockLutFallback.recentChecks.some((attempt) => (
      attempt.strategy === 'pixels' && attempt.ok
    )));

    assert.deepEqual(result.suspectPhoto.status, {
      strategy: 'direct', cpuDecodeSuspect: true, photoAllBlack: false, decodeRetried: false,
    });
    assert.equal(result.suspectPhoto.preferredStrategy, 'direct', 'D recovery must be sticky');
    assert.equal(result.suspectPhoto.cpuDecodeSuspect, true);
    assert.equal(result.suspectPhoto.photoAllBlack, false);
    assert.ok(result.suspectPhoto.recentChecks.some((attempt) => (
      attempt.strategy === 'pixels' && !attempt.ok && attempt.cpuDecodeSuspect
    )), 'zero CPU readback must not let P pass zero==zero');
    assert.ok(result.suspectPhoto.recentChecks.some((attempt) => (
      attempt.strategy === 'direct' && attempt.ok && attempt.selfCheck.gpuNonBlack
    )));

    // Reaching this return value proves the both-zero photo path did not throw.
    assert.deepEqual(result.bothBlack.status, {
      strategy: 'pixels', cpuDecodeSuspect: true, photoAllBlack: true, decodeRetried: false,
    });
    assert.equal(result.bothBlack.mockedZeroUploads, 1);
    assert.equal(result.bothBlack.cpuDecodeSuspect, true);
    assert.equal(result.bothBlack.photoAllBlack, true);
    assert.equal(result.bothBlack.preferredStrategy, 'pixels');
    assert.ok(result.bothBlack.recentChecks.some((attempt) => (
      attempt.strategy === 'pixels' && attempt.ok && attempt.acceptedAsAllBlack
    )));

    assert.equal(result.suspectLut.strategy, 'direct');
    assert.equal(result.suspectLut.preferredStrategy, 'direct');
    assert.equal(result.suspectLut.cpuDecodeSuspect, true);
    assert.equal(result.suspectLut.photoAllBlack, false, 'LUTs never use the photo warning');
    assert.ok(result.suspectLut.recentChecks.some((attempt) => (
      attempt.strategy === 'direct' && attempt.ok && attempt.selfCheck.gpuNonBlack
    )));

    const report = result.diagnostics;
    assert.deepEqual(report.tests.solidColour.pixel, [255, 0, 128, 255]);
    assert.equal(report.tests.solidColour.exact, true, 'solid colour must be code-exact');
    assert.equal(report.tests.photoTexture.samples.length, 5);
    assert.ok(report.tests.photoTexture.maxDiff <= 1,
      `photo probes differ by ${report.tests.photoTexture.maxDiff}`);
    assert.equal(report.tests.lutTexture.samples.length, 2);
    assert.ok(report.tests.lutTexture.maxDiff <= 1,
      `LUT probes differ by ${report.tests.lutTexture.maxDiff}`);
    assert.ok(report.tests.fullShader.intensity0MaxDiff <= 1,
      `full shader intensity=0 differs by ${report.tests.fullShader.intensity0MaxDiff}`);
    assert.equal(report.tests.fullShader.intensity1.length, 4);
    assert.equal(report.summary.ok, true, JSON.stringify(report.summary));
    assert.ok(report.gl.maxTextureSize > 0);
    assert.ok(report.gl.maxTextureImageUnits >= 4);
    assert.ok(report.gl.fragmentHighpFloat.precision > 0);
    assert.ok(result.diagnosticsText.includes('[PHOTO TEXTURE: corners + centre]'));

    await fs.writeFile(path.join(OUT, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
    await fs.writeFile(path.join(OUT, 'report.txt'), result.diagnosticsText);
    console.log(
      `Upload strategies: PASS (P/D max ${result.comparison.maxDiff} code over ` +
      `${result.comparison.pixels} pixels; zero-upload fallback recovered via P)`
    );
    console.log(
      `GL diagnostics: PASS (solid exact; photo max ${report.tests.photoTexture.maxDiff}; ` +
      `LUT max ${report.tests.lutTexture.maxDiff}; full intensity=0 max ` +
      `${report.tests.fullShader.intensity0MaxDiff})`
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
