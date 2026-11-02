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

async function preparePhoto(options) {
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
  const size = computePreviewSize(
    decision.outputWidth,
    decision.outputHeight,
    options.devicePixelRatio,
    options.maxTextureSize,
    1280
  );
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
    decision.transformOrientation, sourceWidth, sourceHeight
  );
  context.setTransform(...transform);
  context.drawImage(source, 0, 0, sourceWidth, sourceHeight);
  context.setTransform(1, 0, 0, 1, 0, 0);
  source.src = '';

  return {
    canvas: output,
    width: size.width,
    height: size.height,
    sourceWidth,
    sourceHeight,
    orientation: decision.orientation,
    engineApplied: decision.engineApplied,
  };
}

module.exports = {
  EXIF_ORIENTATION_MODE,
  decideExifOrientation,
  getImageInfo,
  loadCanvasImage,
  normalizeOrientation,
  orientationTransform,
  preparePhoto,
  swapsDimensions,
};
