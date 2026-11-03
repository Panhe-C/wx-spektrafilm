// Photo decoding, EXIF orientation and bounded one-pass preview resizing.
(function registerPhoto(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./lut-renderer.js'));
  } else {
    root.SpektrafilmPhoto = factory(root.SpektrafilmRenderer);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function photoFactory(RendererModule) {
  const { computePreviewSize } = RendererModule;

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
  let engineApplied = mode === 'engine';
  let decisionRow = mode === 'engine' ? 'ENGINE' : 'MANUAL';
  let ambiguous = false;
  if (mode === 'auto') {
    engineApplied = false;
    if (orientation === 'up') {
      // getImageInfo dimensions are not the geometry authority. 'up' always
      // uses the actual decoded pixels, even when their dimensions disagree.
      decisionRow = 'UP';
    } else if (!swapsDimensions(orientation)) {
      // 2-4 do not swap dimensions, so no dimension-only test can distinguish
      // raw from engine-transformed pixels. Keep the documented manual policy.
      decisionRow = 'NON_SWAP';
      ambiguous = true;
    } else if (sizeSwapDetected && infoWidth > infoHeight && decodedWidth < decodedHeight) {
      // A: raw landscape info + upright portrait Image. This is the only
      // swapped-dimension direction that positively supports engine rotation
      // under the phone-camera landscape-raw heuristic.
      engineApplied = true;
      decisionRow = 'A';
    } else if (sizeSwapDetected && infoWidth < infoHeight && decodedWidth > decodedHeight) {
      // C: info is already upright while the decoded Image is raw. Rotating
      // the Image is required; treating this symmetric swap like A was wrong.
      decisionRow = 'C';
    } else if (decodedWidth === infoWidth && decodedHeight === infoHeight) {
      if (decodedWidth > decodedHeight) {
        // B: matching landscape raw dimensions. Phone-camera raw frames are
        // normally landscape, so apply the requested 90-degree transform.
        decisionRow = 'B';
      } else if (decodedWidth < decodedHeight) {
        // D: both could be raw portrait or already-upright portrait. Preserve
        // decoded pixels rather than risking a second rotation. Raw portrait
        // files that need rotation require explicit manual mode.
        engineApplied = true;
        decisionRow = 'D';
        ambiguous = true;
      } else {
        decisionRow = 'SQUARE';
        ambiguous = true;
      }
    } else {
      // Dimensions match neither raw nor swapped expectations. There is no
      // positive evidence of engine rotation, so transform the decoded pixels.
      decisionRow = 'UNMATCHED';
      ambiguous = true;
    }
  }
  const transformOrientation = engineApplied ? 'up' : orientation;
  const reasons = {
    A: 'info-raw-landscape-image-upright-engine',
    B: 'matching-landscape-manual',
    C: 'info-upright-portrait-image-raw-manual',
    D: 'ambiguous-matching-portrait-preserve-decoded',
    UP: 'orientation-up-trust-decoded',
    NON_SWAP: 'non-swapping-orientation-dims-ambiguous-manual',
    SQUARE: 'square-dims-manual',
    UNMATCHED: 'unmatched-dims-manual',
    MANUAL: 'explicit-manual',
    ENGINE: 'explicit-engine-applied',
  };
  return {
    orientation,
    mode,
    decisionRow,
    reason: reasons[decisionRow],
    ambiguous,
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

  const source = options.image
    ? await Promise.resolve(options.image)
    : await loadCanvasImage(options.canvas, options.src);
  // The decoded Image is the sole aspect/geometry authority. getImageInfo
  // dimensions participate only in the explicit EXIF decision table above.
  const sourceWidth = Number(source.naturalWidth || source.width);
  const sourceHeight = Number(source.naturalHeight || source.height);
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
 * Content-level whole-image check.
 *
 * The GPU probes compare the texture with a CPU copy of the *decode canvas*,
 * so they cannot see a wrong decode. This compares a tiny direct downscale of
 * the original Image with a downscale of the decode canvas: a magnified
 * top-left crop produces a large difference, a correct decode does not.
 *
 * It is Canvas2D only: no WebGL, no default-framebuffer readback.
 */
function measureWholeImageDecode(decoded, decodeCanvas, size) {
  const sourceWidth = decoded.sourceWidth;
  const sourceHeight = decoded.sourceHeight;
  const swapping = swapsDimensions(decoded.decision.transformOrientation);
  const orientedWidth = swapping ? sourceHeight : sourceWidth;
  const orientedHeight = swapping ? sourceWidth : sourceHeight;
  const probeLongEdge = 14;
  const probeWidth = Math.max(1, Math.round(
    orientedWidth >= orientedHeight
      ? probeLongEdge
      : probeLongEdge * orientedWidth / orientedHeight
  ));
  const probeHeight = Math.max(1, Math.round(
    orientedHeight >= orientedWidth
      ? probeLongEdge
      : probeLongEdge * orientedHeight / orientedWidth
  ));
  const probeScale = Math.min(
    probeWidth / orientedWidth,
    probeHeight / orientedHeight
  );
  const referenceDestinationWidth = sourceWidth * probeScale;
  const referenceDestinationHeight = sourceHeight * probeScale;
  const referenceTransform = orientationTransform(
    decoded.decision.transformOrientation,
    referenceDestinationWidth,
    referenceDestinationHeight
  );

  function newCanvas(width, height) {
    const canvas = wx.createOffscreenCanvas({ type: '2d', width, height });
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Whole-image check could not create a 2D context');
    }
    return { canvas, context };
  }

  const reference = newCanvas(probeWidth, probeHeight);
  reference.context.imageSmoothingEnabled = true;
  reference.context.setTransform(...referenceTransform);
  reference.context.drawImage(
    decoded.source,
    0, 0, sourceWidth, sourceHeight,
    0, 0, referenceDestinationWidth, referenceDestinationHeight
  );
  reference.context.setTransform(1, 0, 0, 1, 0, 0);

  const sampled = newCanvas(probeWidth, probeHeight);
  sampled.context.imageSmoothingEnabled = true;
  sampled.context.drawImage(
    decodeCanvas,
    0, 0, decodeCanvas.width, decodeCanvas.height,
    0, 0, probeWidth, probeHeight
  );

  const direct = reference.context.getImageData(0, 0, probeWidth, probeHeight).data;
  const actual = sampled.context.getImageData(0, 0, probeWidth, probeHeight).data;
  let sum = 0;
  let maximum = 0;
  for (let offset = 0; offset < direct.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = Math.abs(direct[offset + channel] - actual[offset + channel]);
      sum += difference;
      maximum = Math.max(maximum, difference);
    }
  }
  const pixels = probeWidth * probeHeight;
  const meanAbsDiff = sum / (pixels * 3);
  const cornerNames = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
  const corners = cornerNames.map((name, index) => {
    const offsets = [
      0,
      (probeWidth - 1) * 4,
      (probeHeight - 1) * probeWidth * 4,
      ((probeHeight - 1) * probeWidth + probeWidth - 1) * 4,
    ];
    const offset = offsets[index];
    const directPixel = Array.from(direct.subarray(offset, offset + 4));
    const decodedPixel = Array.from(actual.subarray(offset, offset + 4));
    return {
      name,
      direct: directPixel,
      decoded: decodedPixel,
      maxDiff: Math.max(
        Math.abs(directPixel[0] - decodedPixel[0]),
        Math.abs(directPixel[1] - decodedPixel[1]),
        Math.abs(directPixel[2] - decodedPixel[2])
      ),
    };
  });
  return {
    available: true,
    canvas2dOnly: true,
    probeSize: [probeWidth, probeHeight],
    decodeCanvasSize: [size.width, size.height],
    sourceSize: [sourceWidth, sourceHeight],
    meanAbsDiff,
    maxAbsDiff: maximum,
    corners,
    // A magnified crop differs by far more than the resampling noise of a
    // correct two-step downscale.
    wholeImage: meanAbsDiff <= 12 && corners.every((corner) => corner.maxDiff <= 48),
  };
}

/**
 * Canvas2D-only geometry self-test.
 *
 * It draws a known asymmetric source through the real drawOriented() path and
 * checks that the marker corner lands in the expected corner of the output.
 * It uses no WebGL and no framebuffer readback, so it isolates the decode
 * geometry on the device.
 */
function runOrientedSelfTest() {
  const sourceWidth = 80;
  const sourceHeight = 60;
  const source = wx.createOffscreenCanvas({ type: '2d', width: sourceWidth, height: sourceHeight });
  source.width = sourceWidth;
  source.height = sourceHeight;
  const sourceContext = source.getContext('2d');
  if (!sourceContext) {
    return { available: false, error: 'Canvas2D is not available' };
  }
  const colors = {
    topRight: [30, 200, 60],
    bottomLeft: [40, 80, 220],
    bottomRight: [230, 200, 40],
  };
  sourceContext.fillStyle = 'rgb(30,200,60)';
  sourceContext.fillRect(sourceWidth / 2, 0, sourceWidth / 2, sourceHeight / 2);
  sourceContext.fillStyle = 'rgb(40,80,220)';
  sourceContext.fillRect(0, sourceHeight / 2, sourceWidth / 2, sourceHeight / 2);
  sourceContext.fillStyle = 'rgb(230,200,40)';
  sourceContext.fillRect(
    sourceWidth / 2, sourceHeight / 2, sourceWidth / 2, sourceHeight / 2
  );
  sourceContext.fillStyle = 'rgb(255,255,255)';
  sourceContext.fillRect(0, 0, 10, 10);

  const cases = [
    {
      orientation: 'up', width: 40, height: 30,
      expected: [[255, 255, 255], colors.topRight, colors.bottomLeft, colors.bottomRight],
    },
    {
      orientation: 'right', width: 30, height: 40,
      expected: [colors.bottomLeft, [255, 255, 255], colors.bottomRight, colors.topRight],
    },
  ];
  const results = cases.map((item) => {
    const decision = decideExifOrientation({
      orientation: item.orientation,
      infoWidth: sourceWidth,
      infoHeight: sourceHeight,
      decodedWidth: sourceWidth,
      decodedHeight: sourceHeight,
      mode: 'manual',
    });
    const prepared = drawOriented({
      source,
      sourceWidth,
      sourceHeight,
      info: { width: sourceWidth, height: sourceHeight, orientation: item.orientation },
      decision,
    }, { width: item.width, height: item.height });
    const context = prepared.canvas.getContext('2d');
    const data = context.getImageData(0, 0, item.width, item.height).data;
    const offsets = [
      0,
      (item.width - 1) * 4,
      (item.height - 1) * item.width * 4,
      ((item.height - 1) * item.width + item.width - 1) * 4,
    ];
    const actual = offsets.map((offset) => Array.from(data.subarray(offset, offset + 3)));
    const maxDiff = Math.max(...actual.map((pixel, index) => Math.max(
      Math.abs(pixel[0] - item.expected[index][0]),
      Math.abs(pixel[1] - item.expected[index][1]),
      Math.abs(pixel[2] - item.expected[index][2])
    )));
    return {
      orientation: item.orientation,
      expected: item.expected,
      actual,
      maxDiff,
      pass: maxDiff <= 3,
      drawInfo: prepared.drawInfo,
    };
  });
  const pass = results.every((result) => result.pass);
  if (!pass) {
    console.error('[wx-spektrafilm][diag][geometry] oriented self-test failed', results);
  }
  return { available: true, canvas2dOnly: true, pass, cases: results };
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
  const orientedSourceWidth = swapsDimensions(decoded.decision.transformOrientation)
    ? decoded.sourceHeight
    : decoded.sourceWidth;
  const orientedSourceHeight = swapsDimensions(decoded.decision.transformOrientation)
    ? decoded.sourceWidth
    : decoded.sourceHeight;
  const requestedScaleX = size.width / orientedSourceWidth;
  const requestedScaleY = size.height / orientedSourceHeight;
  // The output aspect must follow the oriented decoded Image. Rounded output
  // sizes leave a sub-pixel tolerance; anything larger would stretch.
  const relativeAspectError = Math.abs(
    size.width * orientedSourceHeight - size.height * orientedSourceWidth
  ) / Math.max(size.width * orientedSourceHeight, size.height * orientedSourceWidth);
  if (relativeAspectError > 0.01) {
    const error = new Error('Output aspect does not match the oriented decoded Image');
    error.code = 'GEOMETRY_MISMATCH';
    throw error;
  }
  // One uniform scale maps the complete source rectangle into the oriented
  // output. The 9-argument call is deliberate: the old 5-argument call drew
  // the full-resolution source into a smaller canvas, creating a crop.
  const scale = Math.min(requestedScaleX, requestedScaleY);
  const destinationWidth = decoded.sourceWidth * scale;
  const destinationHeight = decoded.sourceHeight * scale;
  // The orientation matrix must be built in the SCALED destination space.
  // Building it from the raw source dimensions placed rotated content outside
  // the canvas for every downscale of a 90-degree orientation.
  const transform = orientationTransform(
    decoded.decision.transformOrientation, destinationWidth, destinationHeight
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
      context.drawImage(
        decoded.source,
        0, 0, decoded.sourceWidth, decoded.sourceHeight,
        0, 0, destinationWidth, destinationHeight
      );
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
    infoType: (decoded.info && decoded.info.type) || '',
    decodeCanvasWidth: size.width,
    decodeCanvasHeight: size.height,
    // scaleX/scaleY are the single uniform applied source scale; the two
    // requested axis ratios above differ only by output rounding.
    scaleX: scale,
    scaleY: scale,
    requestedScaleX,
    requestedScaleY,
    destinationWidth,
    destinationHeight,
    relativeAspectError,
    drawInfo: {
      sourceRect: [0, 0, decoded.sourceWidth, decoded.sourceHeight],
      destinationRect: [0, 0, destinationWidth, destinationHeight],
      outputSize: [size.width, size.height],
      transform,
      effectiveTransform: [
        transform[0] * scale, transform[1] * scale,
        transform[2] * scale, transform[3] * scale,
        transform[4], transform[5],
      ],
      scaleX: scale,
      scaleY: scale,
      relativeAspectError,
    },
    // Content-level check: is the decode canvas the WHOLE image, or only a
    // magnified crop of its top-left corner? It compares a tiny direct
    // downscale of the original Image with a downscale of the decode canvas.
    checkWholeImage: () => measureWholeImageDecode(decoded, output, size),
    decisionRow: decoded.decision.decisionRow,
    decisionReason: decoded.decision.reason,
    decisionMode: decoded.decision.mode,
    decision: decoded.decision,
    transformOrientation: decoded.decision.transformOrientation,
    ambiguousDecision: decoded.decision.ambiguous === true,
    infoOrientation: decoded.info && decoded.info.orientation,
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
    options.longEdge || 1280
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

  return {
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
    measureWholeImageDecode,
    runOrientedSelfTest,
    swapsDimensions,
  };
}));
