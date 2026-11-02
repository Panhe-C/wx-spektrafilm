// Photo decoding, EXIF orientation and bounded one-pass preview resizing.
const { computePreviewSize } = require('./lut-renderer.js');

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

  const orientation = normalizeOrientation(info.orientation);
  const orientedWidth = swapsDimensions(orientation) ? sourceHeight : sourceWidth;
  const orientedHeight = swapsDimensions(orientation) ? sourceWidth : sourceHeight;
  const size = computePreviewSize(
    orientedWidth,
    orientedHeight,
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
  const transform = orientationTransform(orientation, sourceWidth, sourceHeight);
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
    orientation,
  };
}

module.exports = {
  getImageInfo,
  loadCanvasImage,
  normalizeOrientation,
  orientationTransform,
  preparePhoto,
  swapsDimensions,
};
