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
    inputCanvas = document.createElement('canvas');
    inputCanvas.width = size.width;
    inputCanvas.height = size.height;
    const context = inputCanvas.getContext('2d', { alpha: false });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(photoBitmap, 0, 0, size.width, size.height);
    renderer.resize(size.width, size.height);
    renderer.setPhoto(inputCanvas);
    renderer.setAdjustments(DEFAULTS);
    renderer.render(0);
    renderer.finish();
    return {
      width: size.width,
      height: size.height,
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

  window.spektrafilmHarness = {
    initialise,
    getRenderer() {
      return renderer;
    },
    loadPhoto,
    loadStock,
    render,
    renderSized,
    setPhotoData,
    thumbnail,
    timeStockSwitch,
    verifyLutContract,
  };
}());
