/* global SpektrafilmRenderer, SpektrafilmAdjustments */
(function initialiseHarness() {
  let renderer = null;
  let manifest = null;
  let inputCanvas = null;
  let photoBitmap = null;
  const lutBitmaps = new Map();
  const syncPixel = new Uint8Array(4);
  const canvas = document.getElementById('webgl');

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
    const [manifestResponse, vertexResponse, fragmentResponse] = await Promise.all([
      fetch('/subpackages/luts/luts.json'),
      fetch('/shaders/lut.vert.glsl'),
      fetch('/shaders/lut.frag.glsl'),
    ]);
    manifest = await manifestResponse.json();
    renderer = SpektrafilmRenderer.createRenderer(canvas, {
      vertexSource: await vertexResponse.text(),
      fragmentSource: await fragmentResponse.text(),
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
    renderer.setAdjustments(SpektrafilmAdjustments.DEFAULTS);
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

  async function cacheStock(id) {
    if (!lutBitmaps.has(id)) {
      const stock = stockById(id);
      const requests = [decode(`/subpackages/luts/${stock.file}`)];
      if (stock.extended) {
        requests.push(decode(`/subpackages/luts/${stock.extended.file}`));
      }
      const [base, extended] = await Promise.all(requests);
      lutBitmaps.set(id, { base, extended });
    }
    return lutBitmaps.get(id);
  }

  function selectCachedStock(id) {
    const stock = stockById(id);
    const images = lutBitmaps.get(id);
    if (!images) {
      throw new Error(`Stock ${id} is not decoded`);
    }
    renderer.setLut(images.base, stock, images.extended);
  }

  async function loadStock(id) {
    await cacheStock(id);
    selectCachedStock(id);
  }

  async function render(id, intensity, adjustments) {
    await loadStock(id);
    renderer.setAdjustments({
      ...SpektrafilmAdjustments.DEFAULTS,
      ...(adjustments || {}),
    });
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
      dataUrl: canvas.toDataURL('image/png'),
    };
  }

  async function thumbnail(id) {
    await cacheStock(id);
    const landscape = inputCanvas.width >= inputCanvas.height;
    const width = landscape ? 96 : Math.max(1, Math.round(96 * inputCanvas.width / inputCanvas.height));
    const height = landscape ? Math.max(1, Math.round(96 * inputCanvas.height / inputCanvas.width)) : 96;
    // Deliberately nonidentity live state proves the explicit thumbnail override.
    renderer.setAdjustments({ ev: 1, temperature: 50, contrast: 0.5, saturation: 1.5 });
    const started = performance.now();
    selectCachedStock(id);
    const result = renderer.renderToPixels({
      width,
      height,
      intensity: 1,
      adjustments: SpektrafilmAdjustments.DEFAULTS,
    });
    const switchMs = performance.now() - started;
    const restored = renderer.gl.getParameter(renderer.gl.FRAMEBUFFER_BINDING) === null;
    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const context = output.getContext('2d', { alpha: false });
    context.putImageData(new ImageData(new Uint8ClampedArray(result.pixels), width, height), 0, 0);
    return {
      stock: id,
      width,
      height,
      switchMs,
      timing: result.timing,
      restored,
      liveAdjustments: renderer.getAdjustments(),
      dataUrl: output.toDataURL('image/png'),
    };
  }

  async function timeStockSwitch(id) {
    await cacheStock(id);
    renderer.setAdjustments(SpektrafilmAdjustments.DEFAULTS);
    const started = performance.now();
    selectCachedStock(id);
    renderer.render(1);
    renderer.finish();
    renderer.gl.readPixels(0, 0, 1, 1, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, syncPixel);
    return { stock: id, switchMs: performance.now() - started };
  }

  async function verifyLutContract(id) {
    const stock = stockById(id);
    const images = await cacheStock(id);
    let missingExtendedThrows = false;
    try {
      renderer.setLut(images.base, stock);
    } catch (error) {
      missingExtendedThrows = /Extended LUT source is required/.test(error.message);
    }
    renderer.setLut(images.base, stock, images.extended);
    return { stock: id, missingExtendedThrows, extendedAccepted: true };
  }

  window.spektrafilmHarness = {
    initialise,
    loadPhoto,
    loadStock,
    render,
    thumbnail,
    timeStockSwitch,
    verifyLutContract,
  };
}());
