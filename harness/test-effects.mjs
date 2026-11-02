// Headless verification of the Phase 5a spatial effects.
//
// Checks, in the browser (SwiftShader WebGL1):
//   1. determinism       - the same seed and state render bit-identically;
//   2. identity          - effects at strength 0 reproduce the Phase-4 output
//                          (compared against tools/lut_apply.py in Python);
//   3. scale invariance  - the grain statistics are the same in frame units
//                          at two different output sizes;
//   4. timing            - the effect cost at 1280 px;
//   5. halation profile  - the radial profile around a synthetic bright disc.
//
// The statistics themselves are computed by harness/effects_compare.py, which
// also holds the NumPy mirror of the shader's grain maths.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { PROJECT_ROOT, TEST_PHOTO_ROOT, startServer } from './server.mjs';

const OUT = path.join(PROJECT_ROOT, 'harness', 'out', 'effects');
const DEFAULTS = { ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1 };
const NO_EFFECTS = { grain: 0, halation: 0, vignette: 0 };
const FULL_EFFECTS = { grain: 1, halation: 1, vignette: 0 };

function writeDataUrl(filename, dataUrl) {
  const marker = 'data:image/png;base64,';
  if (!dataUrl.startsWith(marker)) {
    throw new Error(`Unexpected image data URL for ${filename}`);
  }
  return fs.writeFile(filename, Buffer.from(dataUrl.slice(marker.length), 'base64'));
}

function runPython(script, args) {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON || '/workspace/venv-sf/bin/python';
    const child = spawn(python, [path.join(PROJECT_ROOT, 'harness', script), ...args], {
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
  const photos = (await fs.readdir(TEST_PHOTO_ROOT))
    .filter((name) => /^p.*\.jpg$/i.test(name))
    .map((name) => path.basename(name, path.extname(name)))
    .sort();
  if (!photos.length) {
    throw new Error(`No phone JPEGs in ${TEST_PHOTO_ROOT}`);
  }
  const photo = photos[0];

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const host = await startServer();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome',
      headless: true,
      protocolTimeout: 600000,
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

    const results = { webgl, photo, cases: {} };

    // --- 1/2: identity and determinism on a real photo --------------------
    const input = await page.evaluate((name) => window.spektrafilmHarness.loadPhoto(name), photo);
    await writeDataUrl(path.join(OUT, 'effects-input.png'), input.dataUrl);
    const identity = await page.evaluate(
      (id) => window.spektrafilmHarness.render(id, 1, {
        ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
      }, { grain: 0, halation: 0, vignette: 0 }),
      'portra400'
    );
    await writeDataUrl(path.join(OUT, 'identity-off.png'), identity.dataUrl);
    const identityAgain = await page.evaluate(
      (id) => window.spektrafilmHarness.render(id, 1, {
        ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
      }, { grain: 0, halation: 0, vignette: 0 }),
      'portra400'
    );
    await writeDataUrl(path.join(OUT, 'identity-off-again.png'), identityAgain.dataUrl);
    const withEffects = await page.evaluate(
      (id) => window.spektrafilmHarness.render(id, 1, {
        ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
      }, { grain: 1, halation: 1, vignette: 0.5 }),
      'portra400'
    );
    await writeDataUrl(path.join(OUT, 'effects-on.png'), withEffects.dataUrl);
    // The halation only, so that the physical reference can be compared on
    // a real picture instead of a synthetic disc.
    const halationOnly = await page.evaluate(
      (id) => window.spektrafilmHarness.render(id, 1, {
        ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
      }, { grain: 0, halation: 1, vignette: 0 }),
      'portra400'
    );
    await writeDataUrl(path.join(OUT, 'photo-halation.png'), halationOnly.dataUrl);
    const withEffectsAgain = await page.evaluate(
      (id) => window.spektrafilmHarness.render(id, 1, {
        ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
      }, { grain: 1, halation: 1, vignette: 0.5 }),
      'portra400'
    );
    await writeDataUrl(path.join(OUT, 'effects-on-again.png'), withEffectsAgain.dataUrl);
    results.cases.identity = {
      off: 'identity-off.png',
      offAgain: 'identity-off-again.png',
      on: 'effects-on.png',
      onAgain: 'effects-on-again.png',
      halationOnly: 'photo-halation.png',
    };

    // --- 3: scale invariance of the grain ---------------------------------
    // A flat mid-grey field rendered at two sizes. The grain difference
    // (effects on minus effects off) must have the same statistics per unit
    // of frame width.
    const flat = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = 'rgb(128,128,128)';
      context.fillRect(0, 0, 16, 16);
      return canvas.toDataURL('image/png');
    });
    const scaleSizes = [[640, 480], [1280, 960]];
    results.cases.scale = [];
    for (const [width, height] of scaleSizes) {
      await page.evaluate(
        ({ dataUrl, w, h }) => window.spektrafilmHarness.setPhotoData(dataUrl, w, h),
        { dataUrl: flat, w: width, h: height }
      );
      const off = await page.evaluate(
        (id) => window.spektrafilmHarness.render(id, 1, {
          ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
        }, { grain: 0, halation: 0, vignette: 0 }),
        'portra400'
      );
      await writeDataUrl(path.join(OUT, `scale-${width}-off.png`), off.dataUrl);
      const on = await page.evaluate(
        (id) => window.spektrafilmHarness.render(id, 1, {
          ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
        }, { grain: 1, halation: 0, vignette: 0 }),
        'portra400'
      );
      await writeDataUrl(path.join(OUT, `scale-${width}-on.png`), on.dataUrl);
      results.cases.scale.push({ width, height, off: `scale-${width}-off.png`, on: `scale-${width}-on.png` });
    }

    // --- 3b: the same flat field at the physics reference size ------------
    await page.evaluate(
      ({ dataUrl, w, h }) => window.spektrafilmHarness.setPhotoData(dataUrl, w, h),
      { dataUrl: flat, w: 1280, h: 192 }
    );
    for (const [name, effects] of Object.entries({
      off: NO_EFFECTS,
      on: { grain: 1, halation: 0, vignette: 0 },
    })) {
      const rendered = await page.evaluate(
        (id, state) => window.spektrafilmHarness.render(id, 1, {
          ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
        }, state),
        'portra400', effects
      );
      await writeDataUrl(path.join(OUT, `grain-compare-${name}.png`), rendered.dataUrl);
    }
    results.cases.grainCompare = {
      off: 'grain-compare-off.png',
      on: 'grain-compare-on.png',
      /* the physics reference of the same field is written by effects_compare.py */
      width: 1280,
      height: 192,
    };

    // --- 3c: contact sheet crops for three stocks -------------------------
    await page.evaluate((name) => window.spektrafilmHarness.loadPhoto(name), photo);
    for (const stockId of ['portra400', 'gold200', 'vision3_500t']) {
      for (const [name, effects] of Object.entries({
        off: NO_EFFECTS,
        on: FULL_EFFECTS,
      })) {
        const rendered = await page.evaluate(
          (id, state) => window.spektrafilmHarness.render(id, 1, {
            ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
          }, state),
          stockId, effects
        );
        await writeDataUrl(
          path.join(OUT, `contact-${stockId}-${name}.png`), rendered.dataUrl
        );
      }
    }

    // --- 4: timing at 1280 px --------------------------------------------
    await page.evaluate((name) => window.spektrafilmHarness.loadPhoto(name), photo);
    const timings = {};
    for (const [name, effects] of Object.entries({
      none: NO_EFFECTS,
      grain: { grain: 1, halation: 0, vignette: 0 },
      halation: { grain: 0, halation: 1, vignette: 0 },
      all: FULL_EFFECTS,
    })) {
      const samples = [];
      for (let index = 0; index < 5; index += 1) {
        const rendered = await page.evaluate(
          (id, state) => window.spektrafilmHarness.render(id, 1, {
            ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
          }, state),
          'portra400', effects
        );
        samples.push(rendered.renderMs);
      }
      samples.sort((a, b) => a - b);
      timings[name] = { medianMs: samples[Math.floor(samples.length / 2)], samples };
      console.log(`  timing ${name}: ${timings[name].medianMs.toFixed(2)} ms`);
    }
    results.cases.timings = timings;

    // --- 5: halation radial profile ---------------------------------------
    // The same synthetic disc the physics study used: a bright disc of radius
    // 40 px on a dark background, 1280 x 640.
    const disc = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 640;
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = 'rgb(5,5,5)';
      context.fillRect(0, 0, 1280, 640);
      context.fillStyle = 'rgb(255,255,255)';
      context.beginPath();
      context.arc(640, 320, 40, 0, Math.PI * 2);
      context.fill();
      return canvas.toDataURL('image/png');
    });
    await page.evaluate(
      (dataUrl) => window.spektrafilmHarness.setPhotoData(dataUrl, 1280, 640),
      disc
    );
    for (const [name, effects] of Object.entries({
      off: NO_EFFECTS,
      halation: { grain: 0, halation: 1, vignette: 0 },
      grain: { grain: 1, halation: 0, vignette: 0 },
    })) {
      const rendered = await page.evaluate(
        (id, state) => window.spektrafilmHarness.render(id, 1, {
          ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
        }, state),
        'portra400', effects
      );
      await writeDataUrl(path.join(OUT, `disc-${name}.png`), rendered.dataUrl);
    }
    results.cases.disc = {
      off: 'disc-off.png',
      halation: 'disc-halation.png',
      grain: 'disc-grain.png',
      width: 1280,
      height: 640,
      discRadius: 40,
    };

    // --- 6: the same disc for a weak anti-halation stock ------------------
    const gold = await page.evaluate(
      (id, state) => window.spektrafilmHarness.render(id, 1, {
        ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
      }, state),
      'gold200', { grain: 0, halation: 1, vignette: 0 }
    );
    await writeDataUrl(path.join(OUT, 'disc-halation-gold200.png'), gold.dataUrl);
    results.cases.discGold200 = 'disc-halation-gold200.png';

    // --- 7: the halation must not be mirrored ----------------------------
    // A bright patch in the top left corner of a mid grey field: the halo
    // has to grow around the patch, not around its mirror image in the bottom
    // right corner. A vertical flip of the halo buffer would show up here.
    // (The field is mid grey and not black, because the film LUT crushes the
    // deep shadows, where a bloom of a few codes would be invisible.)
    const patch = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 640;
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = 'rgb(120,120,120)';
      context.fillRect(0, 0, 1280, 640);
      context.fillStyle = 'rgb(255,255,255)';
      context.fillRect(180, 90, 220, 220);
      return canvas.toDataURL('image/png');
    });
    await page.evaluate(
      (dataUrl) => window.spektrafilmHarness.setPhotoData(dataUrl, 1280, 640),
      patch
    );
    for (const [name, effects] of Object.entries({
      off: NO_EFFECTS,
      halation: { grain: 0, halation: 1, vignette: 0 },
    })) {
      const rendered = await page.evaluate(
        (id, state) => window.spektrafilmHarness.render(id, 1, {
          ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1,
        }, state),
        'portra400', effects
      );
      await writeDataUrl(path.join(OUT, `patch-${name}.png`), rendered.dataUrl);
    }
    results.cases.patch = {
      off: 'patch-off.png',
      halation: 'patch-halation.png',
      width: 1280,
      height: 640,
      patch: { x: 180, y: 90, size: 220 },
    };

    await fs.writeFile(
      path.join(OUT, 'effects-cases.json'), `${JSON.stringify(results, null, 2)}\n`
    );

    // The shared effect constants, so that the Python analysis uses exactly
    // the numbers the shader used.
    const constants = await page.evaluate(() => ({
      frameWidthUm: SpektrafilmEffects.FRAME_WIDTH_UM,
      referenceLongEdge: SpektrafilmEffects.REFERENCE_LONG_EDGE,
      grainLatticePx: SpektrafilmEffects.GRAIN_LATTICE_PX,
      grainLatticeFrame: SpektrafilmEffects.GRAIN_LATTICE_FRAME,
      grainAutocorrelation: SpektrafilmEffects.GRAIN_AUTOCORRELATION,
      stocks: SpektrafilmEffects.STOCK_EFFECTS,
    }));
    await fs.writeFile(
      path.join(OUT, 'effects-constants.json'), `${JSON.stringify(constants, null, 2)}\n`
    );
  } finally {
    if (browser) {
      await browser.close();
    }
    await host.close();
  }

  await runPython('effects_compare.py', []);
  console.log(`Effects report: ${path.join(OUT, 'effects-report.md')}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
