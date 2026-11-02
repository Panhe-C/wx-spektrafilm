// Headless verification of the full-resolution export path.
//
// The export renders the picture in tiles; every tile is a sub-rectangle of
// the same global picture, so the grain, the halation and the vignette have
// to be continuous across the tile borders. The test renders the same
// picture in one pass and in tiles at 3000x2000 with every effect switched
// on and compares the two results pixel by pixel.
//
// The tile planner itself is checked in harness/test-export.mjs (coverage,
// margins, gaps).
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { PROJECT_ROOT, TEST_PHOTO_ROOT, startServer } from './server.mjs';

const OUT = path.join(PROJECT_ROOT, 'harness', 'out', 'export');
const WIDTH = 3000;
const HEIGHT = 2000;
const MAX_ABS_DIFF = 1;
const EFFECTS = { grain: 1, halation: 1, vignette: 0.5 };
const ADJUSTMENTS = { ev: 0, temperature: 0, tint: 0, contrast: 0, saturation: 1 };

function writeDataUrl(filename, dataUrl) {
  const marker = 'data:image/png;base64,';
  if (!dataUrl.startsWith(marker)) {
    throw new Error(`Unexpected image data URL for ${filename}`);
  }
  return fs.writeFile(filename, Buffer.from(dataUrl.slice(marker.length), 'base64'));
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
  const results = { photo, width: WIDTH, height: HEIGHT, cases: [] };
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
    results.webgl = webgl;

    const input = await page.evaluate(
      ({ name, width, height }) => window.spektrafilmHarness.loadPhotoSized(name, width, height),
      { name: photo, width: WIDTH, height: HEIGHT }
    );
    await writeDataUrl(path.join(OUT, 'input.png'), input.dataUrl);
    console.log(`  input: ${input.width}x${input.height} (source ${input.sourceWidth}x${input.sourceHeight})`);

    for (const [stockId, tileSize] of [['portra400', 1024], ['vision3_500t', 2048]]) {
      const comparison = await page.evaluate(
        ({ id, width, height, effects, adjustments, tile }) => (
          window.spektrafilmHarness.compareTiledVsSingle(id, width, height, {
            effects, adjustments, tileSize: tile,
          })
        ),
        {
          id: stockId,
          width: WIDTH,
          height: HEIGHT,
          effects: EFFECTS,
          adjustments: ADJUSTMENTS,
          tile: tileSize,
        }
      );
      const prefix = path.join(OUT, `${stockId}-${tileSize}`);
      await writeDataUrl(`${prefix}-single.png`, comparison.singleDataUrl);
      await writeDataUrl(`${prefix}-tiled.png`, comparison.tiledDataUrl);
      const entry = {
        stock: stockId,
        tileSize,
        margin: comparison.plan.margin,
        tileCount: comparison.plan.tileCount,
        maxAbsDiff: comparison.stats.maxDiff,
        meanAbsDiff: comparison.stats.meanDiff,
        differingPixels: comparison.stats.differingPixels,
        pixels: comparison.stats.pixels,
        borders: comparison.borders,
        singleRenderMs: comparison.singleRenderMs,
        tiledRenderMs: comparison.tiledRenderMs,
        single: `${stockId}-${tileSize}-single.png`,
        tiled: `${stockId}-${tileSize}-tiled.png`,
      };
      results.cases.push(entry);
      console.log(
        `  ${stockId} tiles of ${tileSize} px (${entry.tileCount} tiles, margin ${entry.margin} px): ` +
        `max ${entry.maxAbsDiff} code, mean ${entry.meanAbsDiff.toFixed(6)}, ` +
        `${entry.differingPixels}/${entry.pixels} pixels differ`
      );
      console.log(
        `    single pass ${entry.singleRenderMs.toFixed(1)} ms, tiled ${entry.tiledRenderMs.toFixed(1)} ms`
      );
    }

    // The difference on the tile borders must be as small as everywhere else:
    // a seam would show up as a bright line in the difference image.
    const borderFailures = results.cases.filter((entry) => entry.borders.some(
      (border) => border.maxDiff > MAX_ABS_DIFF
    ));

    await fs.writeFile(
      path.join(OUT, 'export-results.json'),
      `${JSON.stringify(results, null, 2)}\n`
    );

    const failures = results.cases.filter((entry) => entry.maxAbsDiff > MAX_ABS_DIFF);
    if (failures.length || borderFailures.length) {
      for (const failure of failures) {
        console.error(
          `FAIL: ${failure.stock} (tiles of ${failure.tileSize} px): max abs diff ` +
          `${failure.maxAbsDiff} > ${MAX_ABS_DIFF}`
        );
      }
      for (const failure of borderFailures) {
        console.error(
          `FAIL: ${failure.stock} (tiles of ${failure.tileSize} px): a tile border ` +
          `differs by more than ${MAX_ABS_DIFF} code`
        );
      }
      process.exitCode = 1;
      return;
    }
    console.log('Export tiling checks: PASS');
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
