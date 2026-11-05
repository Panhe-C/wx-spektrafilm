/* global SpektrafilmRenderer, SpektrafilmAdjustments, SpektrafilmEffects, SpektrafilmUiState, SpektrafilmBorder */
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
  async function loadPhotoSized(photo, width, height, cover) {
    if (photoBitmap) {
      photoBitmap.close();
      photoBitmap = null;
    }
    photoBitmap = await decode(`/testphotos/${photo}.jpg`);
    return installPhoto(width, height, cover);
  }

  // `cover` centre-crops the source to the target aspect ratio instead of
  // stretching it (only used to prepare odd-ratio sample photos).
  function installPhoto(width, height, cover) {
    inputCanvas = document.createElement('canvas');
    inputCanvas.width = width;
    inputCanvas.height = height;
    const context = inputCanvas.getContext('2d', { alpha: false });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    if (cover) {
      const scale = Math.max(width / photoBitmap.width, height / photoBitmap.height);
      const sw = width / scale;
      const sh = height / scale;
      context.drawImage(
        photoBitmap, (photoBitmap.width - sw) / 2, (photoBitmap.height - sh) / 2, sw, sh,
        0, 0, width, height
      );
    } else {
      context.drawImage(photoBitmap, 0, 0, width, height);
    }
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
    const geometry = SpektrafilmThumbnails.thumbnailGeometry(
      inputCanvas.width, inputCanvas.height
    );
    // Deliberately nonidentity live state proves the explicit thumbnail override.
    renderer.setAdjustments({ ev: 1, temperature: 50, contrast: 0.5, saturation: 1.5 });
    const started = performance.now();
    selectCachedStock(id, false);
    const result = renderer.renderToPixels({
      width: geometry.width,
      height: geometry.height,
      imageUvOffset: geometry.imageUvOffset,
      imageUvScale: geometry.imageUvScale,
      intensity: 1,
      adjustments: DEFAULTS,
      // The preset thumbnails never include the spatial effects.
      effects: SpektrafilmEffects.EFFECT_DEFAULTS,
    });
    const switchMs = performance.now() - started;
    const restored = renderer.gl.getParameter(renderer.gl.FRAMEBUFFER_BINDING) === null;
    const output = document.createElement('canvas');
    output.width = geometry.width;
    output.height = geometry.height;
    const context = output.getContext('2d', { alpha: false });
    context.putImageData(new ImageData(
      new Uint8ClampedArray(result.pixels), geometry.width, geometry.height
    ), 0, 0);
    return {
      stock: id,
      width: geometry.width,
      height: geometry.height,
      cropRect: geometry.cropRect,
      boxAspect: geometry.boxAspect,
      imageMode: geometry.imageMode,
      imageUvOffset: geometry.imageUvOffset,
      imageUvScale: geometry.imageUvScale,
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

  async function verifyPresentationGeometry() {
    const baseData = inputCanvas.toDataURL('image/png');
    const stock = stockById('portra400');
    const images = await ensureExtended(stock.id);

    async function rotateSource(clockwise) {
      const bitmap = await createImageBitmap(await (await fetch(baseData)).blob());
      const output = document.createElement('canvas');
      output.width = bitmap.height;
      output.height = bitmap.width;
      const context = output.getContext('2d', { alpha: false });
      if (clockwise) {
        context.translate(output.width, 0);
        context.rotate(Math.PI / 2);
      } else {
        context.translate(0, output.height);
        context.rotate(-Math.PI / 2);
      }
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return output.toDataURL('image/png');
    }

    const cases = [
      {
        name: 'portrait-3x4-dpr2', width: 480, height: 640,
        cssWidth: 320, cssHeight: 200, pixelRatio: 2, data: baseData,
      },
      {
        name: 'portrait-9x16-exif6-oriented', width: 360, height: 640,
        cssWidth: 360, cssHeight: 200, pixelRatio: 2, data: await rotateSource(true),
        exifOrientation: 6,
      },
      {
        name: 'portrait-9x16-exif8-clamped', width: 360, height: 640,
        cssWidth: 360, cssHeight: 200, pixelRatio: 2, data: await rotateSource(false),
        exifOrientation: 8,
        limits: { maxRenderbufferSize: 320, maxViewportDims: [320, 240] },
      },
    ];
    const results = [];
    for (const item of cases) {
      await setPhotoData(item.data, item.width, item.height);
      renderer.setLut(images.base, stock, images.extended);
      renderer.setAdjustments(DEFAULTS);
      renderer.setEffects({ grain: 1, halation: 1, vignette: 0.5 });
      canvas.style.width = `${item.cssWidth}px`;
      canvas.style.height = `${item.cssHeight}px`;
      const cssRect = canvas.getBoundingClientRect();
      const buffer = renderer.resizeToCssSize(
        item.cssWidth, item.cssHeight, item.pixelRatio, item.limits
      );
      renderer.render(1);
      const presentation = renderer.runDiagnostics().defaultFramebuffer;
      const thumbnailGeometry = SpektrafilmThumbnails.thumbnailGeometry(
        item.width, item.height
      );
      results.push({
        name: item.name,
        exifOrientation: item.exifOrientation || 1,
        photo: { width: item.width, height: item.height },
        css: {
          width: item.cssWidth,
          height: item.cssHeight,
          pixelRatio: item.pixelRatio,
          canvasStyleWidth: canvas.style.width,
          canvasStyleHeight: canvas.style.height,
          actualWidth: cssRect.width,
          actualHeight: cssRect.height,
        },
        buffer,
        presentation,
        thumbnail: thumbnailGeometry,
      });
    }
    // The bottom sheet insets the photo; the canvas buffer must not change.
    const insetCase = cases[0];
    await setPhotoData(insetCase.data, insetCase.width, insetCase.height);
    renderer.setLut(images.base, stock, images.extended);
    const insetBuffer = renderer.resizeToCssSize(
      insetCase.cssWidth, insetCase.cssHeight, insetCase.pixelRatio
    );
    renderer.render(1);
    const beforeInset = renderer.runDiagnostics().defaultFramebuffer;
    renderer.setPresentationInset({ bottom: 80 });
    renderer.render(1);
    const withInset = renderer.runDiagnostics().defaultFramebuffer;
    const insetBufferAfter = { width: canvas.width, height: canvas.height };
    renderer.setPresentationInset({ bottom: 0 });
    renderer.render(1);
    const afterInset = renderer.runDiagnostics().defaultFramebuffer;
    return {
      cases: results,
      inset: {
        buffer: insetBuffer,
        bufferAfter: insetBufferAfter,
        insetCssPx: 80,
        before: beforeInset,
        with: withInset,
        after: afterInset,
      },
    };
  }

  async function verifyUploadStrategiesAndDiagnostics() {
    const stock = stockById('portra400');
    const images = await ensureExtended(stock.id);
    renderer.setLut(images.base, stock, images.extended);
    renderer.setAdjustments(DEFAULTS);
    renderer.setEffects(SpektrafilmEffects.EFFECT_DEFAULTS);
    const renderOptions = {
      width: 96,
      height: 64,
      intensity: 1,
      adjustments: DEFAULTS,
      effects: SpektrafilmEffects.EFFECT_DEFAULTS,
    };

    renderer.setUploadStrategy('pixels');
    renderer.reuploadTextures();
    const pixelResult = renderer.renderToPixels(renderOptions);
    const pixelState = renderer.getDiagnostics();

    renderer.setUploadStrategy('direct');
    renderer.reuploadTextures();
    const directResult = renderer.renderToPixels(renderOptions);
    const directState = renderer.getDiagnostics();
    let maxDiff = 0;
    let differing = 0;
    for (let offset = 0; offset < pixelResult.pixels.length; offset += 4) {
      let pixelDiff = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = Math.abs(
          pixelResult.pixels[offset + channel] - directResult.pixels[offset + channel]
        );
        pixelDiff = Math.max(pixelDiff, difference);
        maxDiff = Math.max(maxDiff, difference);
      }
      if (pixelDiff > 0) {
        differing += 1;
      }
    }

    // Force the direct source overload to upload zeroes only for the photo
    // canvas. The CPU readback is deliberately untouched, so the self-check
    // must detect black and immediately retry through strategy P.
    renderer.setUploadStrategy('direct');
    const gl = renderer.gl;
    const originalTexImage2D = gl.texImage2D;
    let mockedZeroUploads = 0;
    gl.texImage2D = function mockedTexImage2D(...args) {
      if (args.length === 6 && args[5] === inputCanvas) {
        mockedZeroUploads += 1;
        return originalTexImage2D.call(
          gl, args[0], args[1], args[2], inputCanvas.width, inputCanvas.height, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(inputCanvas.width * inputCanvas.height * 4)
        );
      }
      return originalTexImage2D.apply(gl, args);
    };
    try {
      renderer.setPhoto(inputCanvas);
    } finally {
      gl.texImage2D = originalTexImage2D;
    }
    const fallbackState = renderer.getDiagnostics();
    const photo = fallbackState.textures.find((texture) => texture.name === 'photo');

    // Repeat the injected zero upload for the base LUT. Its white probe is
    // computed in the real b=N-1 tile, so an all-zero texture cannot pass.
    renderer.setUploadStrategy('direct');
    const originalLutTexImage2D = gl.texImage2D;
    let mockedZeroLutUploads = 0;
    gl.texImage2D = function mockedLutTexImage2D(...args) {
      if (args.length === 6 && args[5] === images.base) {
        mockedZeroLutUploads += 1;
        return originalLutTexImage2D.call(
          gl, args[0], args[1], args[2], images.base.width, images.base.height, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(images.base.width * images.base.height * 4)
        );
      }
      return originalLutTexImage2D.apply(gl, args);
    };
    try {
      renderer.setLut(images.base, stock, images.extended);
    } finally {
      gl.texImage2D = originalLutTexImage2D;
    }
    const lutFallbackState = renderer.getDiagnostics();
    const lutTexture = lutFallbackState.textures.find((texture) => texture.name === 'lut');

    // New regression: the CPU Canvas2D readback itself is zero, while the
    // direct upload still sees the real canvas. Zero==zero must not accept P.
    renderer.setUploadStrategy('pixels');
    const contextPrototype = CanvasRenderingContext2D.prototype;
    const originalGetImageData = contextPrototype.getImageData;
    contextPrototype.getImageData = function suspectPhotoReadback(...args) {
      if (this.canvas === inputCanvas) {
        return { data: new Uint8ClampedArray(inputCanvas.width * inputCanvas.height * 4) };
      }
      return originalGetImageData.apply(this, args);
    };
    let suspectPhotoStatus;
    try {
      suspectPhotoStatus = renderer.setPhoto(inputCanvas);
    } finally {
      contextPrototype.getImageData = originalGetImageData;
    }
    const suspectPhotoState = renderer.getDiagnostics();
    const suspectPhoto = suspectPhotoState.textures.find((texture) => texture.name === 'photo');

    // Both CPU readback and direct upload are zero. This is legal for a truly
    // black photo: accept P without throwing, but return/record photoAllBlack.
    renderer.setUploadStrategy('pixels');
    contextPrototype.getImageData = function blackPhotoReadback(...args) {
      if (this.canvas === inputCanvas) {
        return { data: new Uint8ClampedArray(inputCanvas.width * inputCanvas.height * 4) };
      }
      return originalGetImageData.apply(this, args);
    };
    const originalBlackTexImage2D = gl.texImage2D;
    let mockedBlackDirectUploads = 0;
    gl.texImage2D = function blackDirectUpload(...args) {
      if (args.length === 6 && args[5] === inputCanvas) {
        mockedBlackDirectUploads += 1;
        return originalBlackTexImage2D.call(
          gl, args[0], args[1], args[2], inputCanvas.width, inputCanvas.height, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(inputCanvas.width * inputCanvas.height * 4)
        );
      }
      return originalBlackTexImage2D.apply(gl, args);
    };
    let bothBlackStatus;
    try {
      bothBlackStatus = renderer.setPhoto(inputCanvas);
    } finally {
      contextPrototype.getImageData = originalGetImageData;
      gl.texImage2D = originalBlackTexImage2D;
    }
    const bothBlackState = renderer.getDiagnostics();
    const bothBlackPhoto = bothBlackState.textures.find((texture) => texture.name === 'photo');

    // LUT variant: the scratch decode of the ImageBitmap has a zero white
    // node, but direct upload is valid. D must win and become sticky.
    renderer.setUploadStrategy('pixels');
    contextPrototype.getImageData = function suspectLutReadback(...args) {
      if (this.canvas && this.canvas.width === images.base.width &&
        this.canvas.height === images.base.height) {
        return { data: new Uint8ClampedArray(images.base.width * images.base.height * 4) };
      }
      return originalGetImageData.apply(this, args);
    };
    try {
      renderer.setLut(images.base, stock);
    } finally {
      contextPrototype.getImageData = originalGetImageData;
    }
    const suspectLutState = renderer.getDiagnostics();
    const suspectLut = suspectLutState.textures.find((texture) => texture.name === 'lut');

    // Finish in the production-preferred state and run the exact same GL
    // diagnostic suite exposed by 关于 → 诊断 in the Mini Program.
    renderer.setUploadStrategy('pixels');
    renderer.reuploadTextures();
    const outcome = SpektrafilmDiagnostics.runDiagnostics({
      renderer,
      canvas,
      nodeSize: { width: canvas.width, height: canvas.height },
      pixelRatio: window.devicePixelRatio || 1,
      photo: {
        type: photo.sourceType,
        width: inputCanvas.width,
        height: inputCanvas.height,
      },
      app: { name: 'wx-spektrafilm', version: 'harness' },
    });
    return {
      comparison: {
        maxDiff,
        differing,
        pixels: pixelResult.width * pixelResult.height,
        pixelStrategies: pixelState.textures.map((texture) => ({
          name: texture.name, strategy: texture.strategy,
        })),
        directStrategies: directState.textures.map((texture) => ({
          name: texture.name, strategy: texture.strategy,
        })),
      },
      mockFallback: {
        mockedZeroUploads,
        finalStrategy: photo.strategy,
        recentChecks: photo.selfChecks.slice(-3),
        fallbacks: fallbackState.upload.fallbacks,
      },
      mockLutFallback: {
        mockedZeroUploads: mockedZeroLutUploads,
        finalStrategy: lutTexture.strategy,
        recentChecks: lutTexture.selfChecks.slice(-3),
        fallbacks: lutFallbackState.upload.fallbacks,
      },
      suspectPhoto: {
        status: suspectPhotoStatus,
        preferredStrategy: suspectPhotoState.upload.preferredStrategy,
        cpuDecodeSuspect: suspectPhoto.cpuDecodeSuspect,
        photoAllBlack: suspectPhoto.photoAllBlack,
        recentChecks: suspectPhoto.selfChecks.slice(-3),
      },
      bothBlack: {
        status: bothBlackStatus,
        mockedZeroUploads: mockedBlackDirectUploads,
        preferredStrategy: bothBlackState.upload.preferredStrategy,
        cpuDecodeSuspect: bothBlackPhoto.cpuDecodeSuspect,
        photoAllBlack: bothBlackPhoto.photoAllBlack,
        recentChecks: bothBlackPhoto.selfChecks.slice(-4),
      },
      suspectLut: {
        preferredStrategy: suspectLutState.upload.preferredStrategy,
        strategy: suspectLut.strategy,
        cpuDecodeSuspect: suspectLut.cpuDecodeSuspect,
        photoAllBlack: suspectLut.photoAllBlack,
        recentChecks: suspectLut.selfChecks.slice(-3),
      },
      diagnostics: outcome.report,
      diagnosticsText: outcome.text,
    };
  }

  // The framed export: the same planner and painter as the Mini Program. The
  // frame is painted first, the graded tiles are blitted inside the margins.
  async function exportFramed(id, width, height, options) {
    const settings = options || {};
    const state = { ...DEFAULTS, ...(settings.adjustments || {}) };
    const effectState = { ...SpektrafilmEffects.EFFECT_DEFAULTS, ...(settings.effects || {}) };
    const images = await cacheStock(id);
    const stock = stockById(id);
    renderer.setLut(images.base, stock, null);
    renderer.setAdjustments(state);
    renderer.setEffects(effectState);
    const plan = SpektrafilmExport.planExport({
      sourceWidth: width,
      sourceHeight: height,
      maxTextureSize: renderer.maxTextureSize,
      maxLongEdge: settings.maxLongEdge || 4096,
      tileSize: settings.tileSize || 1024,
      stockId: id,
      halationStrength: effectState.halation,
      border: settings.border,
    });
    const frame = plan.frame;
    const output = document.createElement('canvas');
    output.width = plan.outerWidth;
    output.height = plan.outerHeight;
    const context = output.getContext('2d');
    // A poisoned background proves that the frame and the tiles cover
    // everything they are responsible for.
    context.fillStyle = '#ff00ff';
    context.fillRect(0, 0, output.width, output.height);
    SpektrafilmBorder.drawBorder(context, frame, { stockName: stock.name });
    for (const tile of plan.tiles) {
      const result = renderer.renderRegionToPixels({
        width: tile.width,
        height: tile.height,
        target: tile.target,
        intensity: 1,
        adjustments: state,
        effects: effectState,
      });
      const imageData = context.createImageData(tile.width, tile.height);
      imageData.data.set(result.pixels);
      context.putImageData(imageData, tile.x + frame.left, tile.y + frame.top);
    }
    renderer.finish();
    const sample = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
    const photoData = context.getImageData(frame.left, frame.top, frame.photoW, frame.photoH).data;
    let checksum = 2166136261;
    for (let index = 0; index < photoData.length; index += 1) {
      checksum = Math.imul(checksum ^ photoData[index], 16777619) >>> 0;
    }
    // Count poisoned pixels (the poison must be fully overwritten).
    const whole = context.getImageData(0, 0, output.width, output.height).data;
    let poisoned = 0;
    for (let index = 0; index < whole.length; index += 4) {
      if (whole[index] === 255 && whole[index + 1] === 0 && whole[index + 2] === 255) {
        poisoned += 1;
      }
    }
    return {
      plan: {
        width: plan.width,
        height: plan.height,
        outerWidth: plan.outerWidth,
        outerHeight: plan.outerHeight,
        tileCount: plan.tiles.length,
        frame,
      },
      poisoned,
      photoChecksum: checksum,
      samples: {
        corner: sample(2, 2),
        photoCentre: sample(frame.left + Math.floor(frame.photoW / 2), frame.top + Math.floor(frame.photoH / 2)),
        photoFirst: sample(frame.left, frame.top),
        photoLast: sample(frame.left + frame.photoW - 1, frame.top + frame.photoH - 1),
      },
      dataUrl: output.toDataURL('image/png'),
    };
  }

  // The live preview with a frame: render into a buffer of bufferW x bufferH
  // and read the default framebuffer back.
  function previewFramed(style, bufferW, bufferH, inset) {
    renderer.resizeToCssSize(bufferW, bufferH, 1);
    renderer.setPresentationInset(inset || { bottom: 0 });
    renderer.setFrame(style);
    const presentation = renderer.render(1);
    const gl = renderer.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const at = (x, y) => Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 3));
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const context = out.getContext('2d');
    const image = context.createImageData(width, height);
    for (let row = 0; row < height; row += 1) {
      const source = (height - 1 - row) * width * 4;
      image.data.set(pixels.subarray(source, source + width * 4), row * width * 4);
    }
    context.putImageData(image, 0, 0);
    renderer.setFrame('none');
    return {
      width,
      height,
      presentation: JSON.parse(JSON.stringify(presentation)),
      at: Object.fromEntries(
        [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
          .map(([x, y]) => [`${x},${y}`, at(x, y)])
      ),
      dataUrl: out.toDataURL('image/png'),
    };
  }

  // The preview as the Mini Program shows it: the GL frame, then the overlay
  // canvas painted with the page's transform (utils/border.js drawBorder).
  function previewComposite(style, bufferW, bufferH, inset, stockName) {
    const preview = previewFramed(style, bufferW, bufferH, inset);
    const out = document.createElement('canvas');
    out.width = preview.width;
    out.height = preview.height;
    const context = out.getContext('2d');
    const image = new Image();
    return new Promise((resolve) => {
      image.onload = () => {
        context.drawImage(image, 0, 0);
        const frame = preview.presentation.frame;
        if (frame) {
          const rect = frame.cssRect;
          const layout = frame.layout;
          context.setTransform(
            rect.width / layout.outerW, 0, 0, rect.height / layout.outerH, rect.x, rect.y
          );
          SpektrafilmBorder.drawBorder(context, layout, { stockName });
          context.setTransform(1, 0, 0, 1, 0, 0);
        }
        resolve({ presentation: preview.presentation, dataUrl: out.toDataURL('image/png') });
      };
      image.src = preview.dataUrl;
    });
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
    exportFramed,
    previewFramed,
    previewComposite,
    compareCanvases,
    compareTiledVsSingle,
    setPhotoData,
    thumbnail,
    timeStockSwitch,
    verifyLutContract,
    verifyPresentationGeometry,
    verifyUploadStrategiesAndDiagnostics,
  };
}());
