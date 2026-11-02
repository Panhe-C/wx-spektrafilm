/* global SpektrafilmRenderer, SpektrafilmAdjustments, SpektrafilmEffects, SpektrafilmUiState */
(function initialiseHarness() {
  let renderer = null;
  let manifest = null;
  let inputCanvas = null;
  let photoBitmap = null;
  const lutBitmaps = new Map();
  const syncPixel = new Uint8Array(4);
  const canvas = document.getElementById('webgl');
  const DEFAULTS = SpektrafilmAdjustments.DEFAULTS;

  async function fetchBlob(path) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`${path}: HTTP ${response.status}`);
    }
    return response.blob();
  }

  async function decode(path) {
    const blob = await fetchBlob(path);
    return createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      imageOrientation: 'from-image',
      premultiplyAlpha: 'none',
    });
  }

  async function initialise() {
    const [manifestResponse, vertexResponse, fragmentResponse, haloResponse] = await Promise.all([
      fetch('/subpackages/luts/luts.json'),
      fetch('/shaders/lut.vert.glsl'),
      fetch('/shaders/lut.frag.glsl'),
      fetch('/shaders/halo.frag.glsl'),
    ]);
    manifest = await manifestResponse.json();
    renderer = SpektrafilmRenderer.createRenderer(canvas, {
      vertexSource: await vertexResponse.text(),
      fragmentSource: await fragmentResponse.text(),
      haloFragmentSource: await haloResponse.text(),
    });
    const debug = renderer.gl.getExtension('WEBGL_debug_renderer_info');
    return {
      stocks: manifest.length,
      extendedStocks: manifest.filter((stock) => stock.extended).length,
      maxTextureSize: renderer.maxTextureSize,
      renderer: debug
        ? renderer.gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : renderer.gl.getParameter(renderer.gl.RENDERER),
    };
  }

  async function loadPhoto(photo, longEdge) {
    if (photoBitmap) {
      photoBitmap.close();
      photoBitmap = null;
    }
    photoBitmap = await decode(`/testphotos/${photo}.jpg`);
    const size = SpektrafilmRenderer.computePreviewSize(
      photoBitmap.width,
      photoBitmap.height,
      window.devicePixelRatio || 1,
      renderer.maxTextureSize,
      longEdge || 1280
    );
    return installPhoto(size.width, size.height);
  }

  // Load the picture at an exact size (the export test needs a fixed
  // 3000x2000 canvas).
  async function loadPhotoSized(photo, width, height) {
    if (photoBitmap) {
      photoBitmap.close();
      photoBitmap = null;
    }
    photoBitmap = await decode(`/testphotos/${photo}.jpg`);
    return installPhoto(width, height);
  }

  function installPhoto(width, height) {
    inputCanvas = document.createElement('canvas');
    inputCanvas.width = width;
    inputCanvas.height = height;
    const context = inputCanvas.getContext('2d', { alpha: false });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(photoBitmap, 0, 0, width, height);
    renderer.resize(width, height);
    renderer.setPhoto(inputCanvas);
    renderer.setAdjustments(DEFAULTS);
    renderer.render(0);
    renderer.finish();
    return {
      width: inputCanvas.width,
      height: inputCanvas.height,
      sourceWidth: photoBitmap.width,
      sourceHeight: photoBitmap.height,
      dataUrl: inputCanvas.toDataURL('image/png'),
    };
  }

  function stockById(id) {
    const stock = manifest.find((item) => item.id === id);
    if (!stock) {
      throw new Error(`Unknown stock ${id}`);
    }
    return stock;
  }

  // The base cube is cached immediately; the extended cube is fetched the
  // first time a positive EV or a nonidentity white balance needs it. This
  // mirrors the Mini Program page.
  async function cacheStock(id) {
    if (!lutBitmaps.has(id)) {
      const stock = stockById(id);
      const base = await decode(`/subpackages/luts/${stock.file}`);
      lutBitmaps.set(id, { base, extended: null, extendedPromise: null });
    }
    return lutBitmaps.get(id);
  }

  async function ensureExtended(id) {
    const images = await cacheStock(id);
    if (!images.extended && !images.extendedPromise) {
      const stock = stockById(id);
      images.extendedPromise = decode(`/subpackages/luts/${stock.extended.file}`)
        .then((bitmap) => {
          images.extended = bitmap;
          images.extendedPromise = null;
          return bitmap;
        })
        .catch((error) => {
          images.extendedPromise = null;
          throw error;
        });
    }
    if (images.extendedPromise) {
      await images.extendedPromise;
    }
    return images;
  }

  function selectCachedStock(id, withExtended) {
    const stock = stockById(id);
    const images = lutBitmaps.get(id);
    if (!images) {
      throw new Error(`Stock ${id} is not decoded`);
    }
    renderer.setLut(images.base, stock, withExtended ? images.extended : null);
  }

  async function loadStock(id) {
    await cacheStock(id);
    selectCachedStock(id, false);
  }

  async function render(id, intensity, adjustments, effects) {
    const state = { ...DEFAULTS, ...(adjustments || {}) };
    const effectState = { ...SpektrafilmEffects.EFFECT_DEFAULTS, ...(effects || {}) };
    const needsExtended = state.ev > 0 || state.temperature !== 0 || state.tint !== 0;
    const images = needsExtended ? await ensureExtended(id) : await cacheStock(id);
    renderer.setLut(images.base, stockById(id), needsExtended ? images.extended : null);
    renderer.setAdjustments(state);
    renderer.setEffects(effectState);
    const start = performance.now();
    renderer.render(intensity);
    renderer.finish();
    renderer.gl.readPixels(0, 0, 1, 1, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, syncPixel);
    const renderMs = performance.now() - start;
    return {
      renderMs,
      width: canvas.width,
      height: canvas.height,
      adjustments: renderer.getAdjustments(),
      effects: renderer.getEffects(),
      dataUrl: canvas.toDataURL('image/png'),
    };
  }

  // Render into an offscreen buffer of an explicit size, so that the
  // resolution independence of the effects can be measured.
  async function renderSized(id, width, height, adjustments, effects) {
    const state = { ...DEFAULTS, ...(adjustments || {}) };
    const effectState = { ...SpektrafilmEffects.EFFECT_DEFAULTS, ...(effects || {}) };
    const images = await cacheStock(id);
    renderer.setLut(images.base, stockById(id), null);
    renderer.setAdjustments(state);
    renderer.setEffects(effectState);
    const start = performance.now();
    const result = renderer.renderToPixels({
      width,
      height,
      intensity: 1,
      adjustments: state,
      effects: effectState,
    });
    renderer.finish();
    const renderMs = performance.now() - start;
    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const context = output.getContext('2d', { alpha: false });
    context.putImageData(new ImageData(new Uint8ClampedArray(result.pixels), width, height), 0, 0);
    return {
      renderMs,
      timing: result.timing,
      width,
      height,
      dataUrl: output.toDataURL('image/png'),
    };
  }

  // Upload an arbitrary PNG data URL as the photo, so that synthetic
  // patches (flat grey fields, a bright disc) can be measured.
  async function setPhotoData(dataUrl, width, height) {
    if (photoBitmap) {
      photoBitmap.close();
      photoBitmap = null;
    }
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    photoBitmap = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      imageOrientation: 'from-image',
      premultiplyAlpha: 'none',
    });
    inputCanvas = document.createElement('canvas');
    inputCanvas.width = width || photoBitmap.width;
    inputCanvas.height = height || photoBitmap.height;
    const context = inputCanvas.getContext('2d', { alpha: false });
    context.imageSmoothingEnabled = false;
    context.drawImage(photoBitmap, 0, 0, inputCanvas.width, inputCanvas.height);
    renderer.resize(inputCanvas.width, inputCanvas.height);
    renderer.setPhoto(inputCanvas);
    renderer.setAdjustments(DEFAULTS);
    renderer.setEffects(SpektrafilmEffects.EFFECT_DEFAULTS);
    renderer.render(0);
    renderer.finish();
    return {
      width: inputCanvas.width,
      height: inputCanvas.height,
    };
  }

  async function thumbnail(id) {
    await cacheStock(id);
    const size = SpektrafilmUiState.thumbnailSize(inputCanvas.width, inputCanvas.height);
    // Deliberately nonidentity live state proves the explicit thumbnail override.
    renderer.setAdjustments({ ev: 1, temperature: 50, contrast: 0.5, saturation: 1.5 });
    const started = performance.now();
    selectCachedStock(id, false);
    const result = renderer.renderToPixels({
      width: size.width,
      height: size.height,
      intensity: 1,
      adjustments: DEFAULTS,
      // The preset thumbnails never include the spatial effects.
      effects: SpektrafilmEffects.EFFECT_DEFAULTS,
    });
    const switchMs = performance.now() - started;
    const restored = renderer.gl.getParameter(renderer.gl.FRAMEBUFFER_BINDING) === null;
    const output = document.createElement('canvas');
    output.width = size.width;
    output.height = size.height;
    const context = output.getContext('2d', { alpha: false });
    context.putImageData(new ImageData(new Uint8ClampedArray(result.pixels), size.width, size.height), 0, 0);
    return {
      stock: id,
      width: size.width,
      height: size.height,
      switchMs,
      timing: result.timing,
      restored,
      liveAdjustments: renderer.getAdjustments(),
      dataUrl: output.toDataURL('image/png'),
    };
  }

  async function timeStockSwitch(id) {
    await cacheStock(id);
    renderer.setAdjustments(DEFAULTS);
    const started = performance.now();
    selectCachedStock(id, false);
    renderer.render(1);
    renderer.finish();
    renderer.gl.readPixels(0, 0, 1, 1, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, syncPixel);
    return { stock: id, switchMs: performance.now() - started };
  }

  // Contract: the extended cube may be absent until it is needed. Selecting a
  // stock must succeed, drawing with a positive EV without it must fail with a
  // clear message, and uploading it later must fix the draw.
  async function verifyLutContract(id) {
    const stock = stockById(id);
    const images = await cacheStock(id);
    renderer.setLut(images.base, stock);
    const noExtended = !renderer.hasExtendedLut();
    let drawWithoutExtendedThrows = false;
    try {
      renderer.setAdjustments({ ev: 1 });
      renderer.render(1);
      renderer.finish();
    } catch (error) {
      drawWithoutExtendedThrows = /no extended-range LUT/.test(error.message);
    }
    renderer.setAdjustments(DEFAULTS);
    renderer.setExtendedLut(images.extended, stock.extended);
    const extendedAccepted = renderer.hasExtendedLut();
    renderer.setAdjustments({ ev: 1 });
    renderer.render(1);
    renderer.finish();
    renderer.setAdjustments(DEFAULTS);
    return {
      stock: id,
      noExtended,
      drawWithoutExtendedThrows,
      extendedAccepted,
    };
  }

  /**
   * Render the picture in tiles, exactly like the export does: the plan
   * comes from utils/export.js and every tile is rendered as a sub-rectangle
   * of the same global picture.
   */
  async function renderTiled(id, width, height, options) {
    const settings = options || {};
    const state = { ...DEFAULTS, ...(settings.adjustments || {}) };
    const effectState = { ...SpektrafilmEffects.EFFECT_DEFAULTS, ...(settings.effects || {}) };
    const images = await cacheStock(id);
    renderer.setLut(images.base, stockById(id), null);
    renderer.setAdjustments(state);
    renderer.setEffects(effectState);
    const plan = SpektrafilmExport.planExport({
      sourceWidth: width,
      sourceHeight: height,
      maxTextureSize: renderer.maxTextureSize,
      maxLongEdge: 4096,
      tileSize: settings.tileSize || 1024,
      stockId: id,
      halationStrength: effectState.halation,
    });
    const output = document.createElement('canvas');
    output.width = plan.width;
    output.height = plan.height;
    const context = output.getContext('2d', { alpha: false });
    const tiles = [];
    const started = performance.now();
    for (const tile of plan.tiles) {
      const result = renderer.renderRegionToPixels({
        width: tile.width,
        height: tile.height,
        target: tile.target,
        intensity: settings.intensity === undefined ? 1 : settings.intensity,
        adjustments: state,
        effects: effectState,
      });
      const imageData = context.createImageData(tile.width, tile.height);
      imageData.data.set(result.pixels);
      context.putImageData(imageData, tile.x, tile.y);
      tiles.push({
        index: tile.index,
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
        margin: tile.margin,
        renderMs: result.timing.totalMs,
      });
    }
    renderer.finish();
    return {
      plan: {
        width: plan.width,
        height: plan.height,
        margin: plan.margin,
        tileSize: plan.tileSize,
        tileCount: plan.tiles.length,
      },
      tiles,
      renderMs: performance.now() - started,
      dataUrl: output.toDataURL('image/png'),
    };
  }

  // The pixel-wise comparison of two canvases of the same size.
  function compareCanvases(first, second) {
    const width = first.width;
    const height = first.height;
    if (second.width !== width || second.height !== height) {
      throw new Error('The two renders have different sizes');
    }
    const a = first.getContext('2d').getImageData(0, 0, width, height).data;
    const b = second.getContext('2d').getImageData(0, 0, width, height).data;
    let maxDiff = 0;
    let sum = 0;
    let differing = 0;
    const columnMax = new Int32Array(width);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        let pixelMax = 0;
        for (let channel = 0; channel < 3; channel += 1) {
          const difference = Math.abs(a[offset + channel] - b[offset + channel]);
          sum += difference;
          if (difference > pixelMax) {
            pixelMax = difference;
          }
        }
        if (pixelMax > 0) {
          differing += 1;
        }
        if (pixelMax > maxDiff) {
          maxDiff = pixelMax;
        }
        if (pixelMax > columnMax[x]) {
          columnMax[x] = pixelMax;
        }
      }
    }
    return {
      width,
      height,
      maxDiff,
      meanDiff: sum / (width * height * 3),
      differingPixels: differing,
      columnMax: Array.from(columnMax),
    };
  }

  /**
   * Render the same picture in one pass and in tiles and compare the two
   * results pixel by pixel. The comparison also reports the worst
   * difference on the tile borders, which is where a seam would show up.
   */
  async function compareTiledVsSingle(id, width, height, options) {
    const settings = options || {};
    const state = { ...DEFAULTS, ...(settings.adjustments || {}) };
    const effectState = { ...SpektrafilmEffects.EFFECT_DEFAULTS, ...(settings.effects || {}) };
    const images = await cacheStock(id);
    renderer.setLut(images.base, stockById(id), null);
    renderer.setAdjustments(state);
    renderer.setEffects(effectState);

    const singleCanvas = document.createElement('canvas');
    singleCanvas.width = width;
    singleCanvas.height = height;
    const singleStarted = performance.now();
    const single = renderer.renderToPixels({
      width,
      height,
      intensity: settings.intensity === undefined ? 1 : settings.intensity,
      adjustments: state,
      effects: effectState,
    });
    renderer.finish();
    const singleMs = performance.now() - singleStarted;
    const singleContext = singleCanvas.getContext('2d', { alpha: false });
    const singleImage = singleContext.createImageData(width, height);
    singleImage.data.set(single.pixels);
    singleContext.putImageData(singleImage, 0, 0);

    const tiled = await renderTiled(id, width, height, settings);
    const tiledImage = await createImageBitmap(
      await (await fetch(tiled.dataUrl)).blob()
    );
    const tiledCanvas = document.createElement('canvas');
    tiledCanvas.width = width;
    tiledCanvas.height = height;
    const tiledContext = tiledCanvas.getContext('2d', { alpha: false });
    tiledContext.drawImage(tiledImage, 0, 0);
    tiledImage.close();

    const comparison = compareCanvases(singleCanvas, tiledCanvas);
    // The worst difference on the tile borders.
    const borders = [];
    tiled.tiles.forEach((tile) => {
      if (tile.x > 0) {
        borders.push(tile.x);
      }
      if (tile.y > 0) {
        borders.push(tile.y);
      }
    });
    const borderMax = [];
    borders.forEach((border) => {
      let worst = 0;
      for (let offset = -1; offset <= 1; offset += 1) {
        const column = border + offset;
        if (column >= 0 && column < comparison.width) {
          worst = Math.max(worst, comparison.columnMax[column]);
        }
      }
      borderMax.push({ border, maxDiff: worst });
    });
    return {
      stats: {
        maxDiff: comparison.maxDiff,
        meanDiff: comparison.meanDiff,
        differingPixels: comparison.differingPixels,
        pixels: comparison.width * comparison.height,
      },
      borders: borderMax,
      tiles: tiled.tiles,
      plan: tiled.plan,
      singleRenderMs: singleMs,
      tiledRenderMs: tiled.renderMs,
      singleDataUrl: singleCanvas.toDataURL('image/png'),
      tiledDataUrl: tiledCanvas.toDataURL('image/png'),
    };
  }

  window.spektrafilmHarness = {
    initialise,
    getRenderer() {
      return renderer;
    },
    loadPhoto,
    loadPhotoSized,
    loadStock,
    render,
    renderSized,
    renderTiled,
    compareCanvases,
    compareTiledVsSingle,
    setPhotoData,
    thumbnail,
    timeStockSwitch,
    verifyLutContract,
  };
}());
