/* global SpektrafilmRenderer */
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
      maxTextureSize: renderer.maxTextureSize,
      renderer: debug
        ? renderer.gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : renderer.gl.getParameter(renderer.gl.RENDERER),
    };
  }

  async function loadPhoto(photo) {
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
      1280
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

  async function loadStock(id) {
    const stock = manifest.find((item) => item.id === id);
    if (!stock) {
      throw new Error(`Unknown stock ${id}`);
    }
    if (!lutBitmaps.has(id)) {
      lutBitmaps.set(id, await decode(`/subpackages/luts/${stock.file}`));
    }
    renderer.setLut(lutBitmaps.get(id), stock);
  }

  async function render(id, intensity) {
    await loadStock(id);
    const start = performance.now();
    renderer.render(intensity);
    renderer.finish();
    renderer.gl.readPixels(0, 0, 1, 1, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, syncPixel);
    const renderMs = performance.now() - start;
    return {
      renderMs,
      width: canvas.width,
      height: canvas.height,
      dataUrl: canvas.toDataURL('image/png'),
    };
  }

  window.spektrafilmHarness = {
    initialise,
    loadPhoto,
    loadStock,
    render,
  };
}());
