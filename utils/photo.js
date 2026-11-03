// Photo decoding, EXIF orientation and bounded one-pass preview resizing.
const { computePreviewSize } = require('./lut-renderer.js');

const EXIF_ORIENTATION_MODE = 'auto';

const ORIENTATIONS = {
  1: 'up',
  2: 'up-mirrored',
  3: 'down',
  4: 'down-mirrored',
  5: 'left-mirrored',
  6: 'right',
  7: 'right-mirrored',
  8: 'left',
};

function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src, success: resolve, fail: reject });
  });
}

function loadCanvasImage(canvas, src) {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    image.onload = () => resolve(image);
    image.onerror = () => {
      const error = new Error('Image decoding failed');
      error.code = 'DECODE_FAILED';
      reject(error);
    };
    image.src = src;
  });
}

function normalizeOrientation(value) {
  if (typeof value === 'number' || /^[1-8]$/.test(String(value || ''))) {
    return ORIENTATIONS[Number(value)] || 'up';
  }
  const orientation = String(value || 'up').toLowerCase();
  const known = Object.keys(ORIENTATIONS).some((key) => ORIENTATIONS[key] === orientation);
  return known ? orientation : 'up';
}

function orientationTransform(orientation, width, height) {
  switch (orientation) {
    case 'up-mirrored':
      return [-1, 0, 0, 1, width, 0];
    case 'down':
      return [-1, 0, 0, -1, width, height];
    case 'down-mirrored':
      return [1, 0, 0, -1, 0, height];
    case 'left-mirrored':
      return [0, 1, 1, 0, 0, 0];
    case 'right':
      return [0, 1, -1, 0, height, 0];
    case 'right-mirrored':
      return [0, -1, -1, 0, height, width];
    case 'left':
      return [0, -1, 1, 0, 0, width];
    case 'up':
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

function swapsDimensions(orientation) {
  return ['left-mirrored', 'right', 'right-mirrored', 'left'].indexOf(orientation) !== -1;
}

/**
 * Pure EXIF policy decision. In auto mode, only orientations 5-8 can reveal
 * engine-applied orientation: the decoded dimensions are swapped relative to
 * wx.getImageInfo. Orientations 2-4 intentionally remain manual because their
 * dimensions cannot reveal whether the engine already transformed pixels.
 */
function decideExifOrientation(options) {
  const mode = options.mode || EXIF_ORIENTATION_MODE;
  if (['auto', 'manual', 'engine'].indexOf(mode) === -1) {
    throw new Error(`Unknown EXIF orientation mode: ${mode}`);
  }
  const orientation = normalizeOrientation(options.orientation);
  const infoWidth = Number(options.infoWidth);
  const infoHeight = Number(options.infoHeight);
  const decodedWidth = Number(options.decodedWidth);
  const decodedHeight = Number(options.decodedHeight);
  const dimensions = [infoWidth, infoHeight, decodedWidth, decodedHeight];
  if (dimensions.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Invalid EXIF decision dimensions');
  }
  const sizeSwapDetected = swapsDimensions(orientation) &&
    decodedWidth === infoHeight && decodedHeight === infoWidth &&
    (decodedWidth !== infoWidth || decodedHeight !== infoHeight);
  const engineApplied = mode === 'engine' || (mode === 'auto' && sizeSwapDetected);
  const transformOrientation = engineApplied ? 'up' : orientation;
  return {
    orientation,
    mode,
    sizeSwapDetected,
    engineApplied,
    transformOrientation,
    outputWidth: swapsDimensions(transformOrientation) ? decodedHeight : decodedWidth,
    outputHeight: swapsDimensions(transformOrientation) ? decodedWidth : decodedHeight,
  };
}

/**
 * Decode the picture and decide how it has to be rotated.
 *
 * The decision is the same for the preview and for the export: the EXIF
 * policy lives in decideExifOrientation and must not depend on the output
 * size.
 */
async function decodeOriented(options) {
  const info = await getImageInfo(options.src);
  const type = String(info.type || '').toLowerCase();
  if (type && ['jpg', 'jpeg', 'png'].indexOf(type) === -1) {
    const error = new Error(`Unsupported image type: ${type}`);
    error.code = 'UNSUPPORTED_TYPE';
    throw error;
  }

  const source = await loadCanvasImage(options.canvas, options.src);
  const sourceWidth = Number(source.width || info.width);
  const sourceHeight = Number(source.height || info.height);
  if (!sourceWidth || !sourceHeight) {
    const error = new Error('Image has invalid dimensions');
    error.code = 'DECODE_FAILED';
    throw error;
  }

  const decision = decideExifOrientation({
    orientation: info.orientation,
    infoWidth: info.width,
    infoHeight: info.height,
    decodedWidth: sourceWidth,
    decodedHeight: sourceHeight,
    mode: options.orientationMode,
  });

  return { info, source, sourceWidth, sourceHeight, decision };
}

/**
 * Draw the decoded picture into an offscreen 2D canvas of the requested size,
 * with the EXIF orientation applied.
 */
function drawOriented(decoded, size) {
  const output = wx.createOffscreenCanvas({
    type: '2d',
    width: size.width,
    height: size.height,
  });
  output.width = size.width;
  output.height = size.height;
  const context = output.getContext('2d');
  if (!context) {
    const error = new Error('Canvas 2D resize context creation failed');
    error.code = 'DECODE_FAILED';
    throw error;
  }
  context.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in context) {
    context.imageSmoothingQuality = 'high';
  }
  const transform = orientationTransform(
    decoded.decision.transformOrientation, decoded.sourceWidth, decoded.sourceHeight
  );
  let released = false;
  function drawOriginal() {
    if (released) {
      throw new Error('The original decoded Image has already been released');
    }
    // Retry uses the original canvas.createImage() Image, not a snapshot of
    // the potentially zero Canvas2D output. Orientation and output geometry
    // remain identical to the first draw.
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.setTransform(...transform);
    try {
      context.drawImage(decoded.source, 0, 0, decoded.sourceWidth, decoded.sourceHeight);
    } finally {
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
  drawOriginal();

  return {
    canvas: output,
    width: size.width,
    height: size.height,
    sourceWidth: decoded.sourceWidth,
    sourceHeight: decoded.sourceHeight,
    infoWidth: Number(decoded.info && decoded.info.width),
    infoHeight: Number(decoded.info && decoded.info.height),
    decodeCanvasWidth: size.width,
    decodeCanvasHeight: size.height,
    orientation: decoded.decision.orientation,
    engineApplied: decoded.decision.engineApplied,
    // The renderer invokes this at most once, only when its CPU RGBA decode is
    // all black. The original Image stays alive until release() after upload.
    retryDecode: () => {
      drawOriginal();
      return output;
    },
    release: () => {
      if (!released) {
        released = true;
        decoded.source.src = '';
      }
    },
  };
}

async function preparePhoto(options) {
  const decoded = await decodeOriented(options);
  const size = computePreviewSize(
    decoded.decision.outputWidth,
    decoded.decision.outputHeight,
    options.devicePixelRatio,
    options.maxTextureSize,
    1280
  );
  return drawOriented(decoded, size);
}

/**
 * The export variant: the same orientation policy, but the picture is
 * decoded into a canvas of the requested (full-resolution) size.
 */
async function prepareExportImage(options) {
  const decoded = await decodeOriented(options);
  const width = Math.max(1, Math.round(Number(options.width)));
  const height = Math.max(1, Math.round(Number(options.height)));
  return drawOriented(decoded, { width, height });
}

module.exports = {
  EXIF_ORIENTATION_MODE,
  decideExifOrientation,
  decodeOriented,
  drawOriented,
  getImageInfo,
  loadCanvasImage,
  normalizeOrientation,
  orientationTransform,
  prepareExportImage,
  preparePhoto,
  swapsDimensions,
};
