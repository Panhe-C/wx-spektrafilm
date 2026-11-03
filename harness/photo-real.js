// Real-Canvas2D verification of utils/photo.js.
//
// This file runs inside the headless browser. It loads the production photo
// module (window.SpektrafilmPhoto) and exercises drawOriented(), preparePhoto()
// and prepareExportImage() with genuine Image/Canvas objects, so the source
// rectangle -> destination rectangle mapping is verified against real pixels.
//
// Every case compares the produced canvas against an independently computed
// reference (whole source rectangle, oriented transform, uniform scale).
(function installRealPhotoTests() {
  const Photo = window.SpektrafilmPhoto;
  const SWAPPING = ['left-mirrored', 'right', 'right-mirrored', 'left'];

  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function buildRawSource() {
    const width = 400;
    const height = 300;
    const canvas = makeCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgb(220,40,40)';
    context.fillRect(0, 0, width / 2, height / 2);
    context.fillStyle = 'rgb(40,200,60)';
    context.fillRect(width / 2, 0, width / 2, height / 2);
    context.fillStyle = 'rgb(40,80,220)';
    context.fillRect(0, height / 2, width / 2, height / 2);
    context.fillStyle = 'rgb(230,200,40)';
    context.fillRect(width / 2, height / 2, width / 2, height / 2);
    // Unmistakable corner markers.
    context.fillStyle = 'rgb(255,255,255)';
    context.fillRect(0, 0, 16, 16);
    context.fillStyle = 'rgb(0,0,0)';
    context.fillRect(width - 16, 0, 16, 16);
    context.fillStyle = 'rgb(240,40,200)';
    context.fillRect(0, height - 16, 16, 16);
    context.fillStyle = 'rgb(40,230,230)';
    context.fillRect(width - 16, height - 16, 16, 16);
    return canvas;
  }

  // The pixels an engine that already applied EXIF would produce.
  function orientedPixels(raw, orientation) {
    const swapping = SWAPPING.indexOf(orientation) !== -1;
    const canvas = makeCanvas(
      swapping ? raw.height : raw.width,
      swapping ? raw.width : raw.height
    );
    const context = canvas.getContext('2d');
    const matrix = Photo.orientationTransform(orientation, raw.width, raw.height);
    context.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
    context.drawImage(raw, 0, 0);
    context.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`image failed: ${src.slice(0, 40)}`));
      image.src = src;
    });
  }

  // A unique URL per case: the same pixels need different getImageInfo
  // metadata, and the info is looked up by src.
  function blobUrl(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('toBlob failed'));
          return;
        }
        resolve(URL.createObjectURL(blob));
      }, 'image/png');
    });
  }

  // Independent reference: the WHOLE source rectangle is mapped into the
  // output through the oriented transform and one uniform scale.
  function referenceCanvas(image, decision, outputWidth, outputHeight) {
    const swapping = SWAPPING.indexOf(decision.transformOrientation) !== -1;
    const destinationWidth = swapping ? outputHeight : outputWidth;
    const destinationHeight = swapping ? outputWidth : outputHeight;
    const canvas = makeCanvas(outputWidth, outputHeight);
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in context) {
      context.imageSmoothingQuality = 'high';
    }
    const matrix = Photo.orientationTransform(
      decision.transformOrientation, destinationWidth, destinationHeight
    );
    context.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
    context.drawImage(
      image,
      0, 0, image.naturalWidth || image.width, image.naturalHeight || image.height,
      0, 0, destinationWidth, destinationHeight
    );
    context.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  function cornerSamples(canvas) {
    const context = canvas.getContext('2d');
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const offsets = [
      0,
      (canvas.width - 1) * 4,
      ((canvas.height - 1) * canvas.width) * 4,
      ((canvas.height - 1) * canvas.width + canvas.width - 1) * 4,
    ];
    return offsets.map((offset) => Array.from(data.subarray(offset, offset + 3)));
  }

  function compareCanvases(actual, expected) {
    if (actual.width !== expected.width || actual.height !== expected.height) {
      return { sizeMismatch: true, meanAbsDiff: 255, maxAbsDiff: 255, corners: [] };
    }
    const a = actual.getContext('2d').getImageData(0, 0, actual.width, actual.height).data;
    const b = expected.getContext('2d').getImageData(0, 0, expected.width, expected.height).data;
    let sum = 0;
    let maximum = 0;
    for (let offset = 0; offset < a.length; offset += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = Math.abs(a[offset + channel] - b[offset + channel]);
        sum += difference;
        maximum = Math.max(maximum, difference);
      }
    }
    const corners = cornerSamples(actual).map((pixel, index) => {
      const reference = cornerSamples(expected)[index];
      return {
        name: ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'][index],
        actual: pixel,
        expected: reference,
        maxDiff: Math.max(
          Math.abs(pixel[0] - reference[0]),
          Math.abs(pixel[1] - reference[1]),
          Math.abs(pixel[2] - reference[2])
        ),
      };
    });
    return {
      sizeMismatch: false,
      meanAbsDiff: sum / (a.length / 4 * 3),
      maxAbsDiff: maximum,
      corners,
    };
  }

  function installWxMock(infoBySrc) {
    window.wx = {
      getImageInfo(options) {
        const info = infoBySrc[options.src];
        if (!info) {
          options.fail({ errMsg: 'getImageInfo:fail unknown src' });
          return;
        }
        options.success(Object.assign({ type: 'png' }, info));
      },
      createOffscreenCanvas(options) {
        return makeCanvas(options.width, options.height);
      },
    };
  }

  window.runRealPhotoTests = async function runRealPhotoTests(options) {
    const settings = options || {};
    const raw = buildRawSource();
    const infoBySrc = {};
    installWxMock(infoBySrc);
    const hostCanvas = makeCanvas(16, 16);
    hostCanvas.createImage = () => new Image();

    const orientations = [1, 2, 3, 4, 5, 6, 7, 8];
    const names = ['up', 'up-mirrored', 'down', 'down-mirrored',
      'left-mirrored', 'right', 'right-mirrored', 'left'];
    const cases = [];
    const failures = [];

    for (let index = 0; index < orientations.length; index += 1) {
      const orientation = names[index];
      const engineCanvas = orientedPixels(raw, orientation);
      const rawUrl = await blobUrl(raw);
      const engineUrl = await blobUrl(engineCanvas);
      const swapping = SWAPPING.indexOf(orientation) !== -1;
      const rawInfo = { width: raw.width, height: raw.height };
      const uprightInfo = swapping
        ? { width: raw.height, height: raw.width }
        : { width: raw.width, height: raw.height };

      const combinations = [
        {
          name: 'raw-image-raw-info',
          src: await blobUrl(raw),
          info: Object.assign({ orientation }, rawInfo),
          expectedRow: swapping ? 'B' : (orientation === 'up' ? 'UP' : 'NON_SWAP'),
        },
        {
          name: 'engine-image-raw-info',
          src: engineUrl,
          info: Object.assign({ orientation }, rawInfo),
          expectedRow: swapping ? 'A' : (orientation === 'up' ? 'UP' : 'NON_SWAP'),
        },
        {
          name: 'raw-image-upright-info',
          src: await blobUrl(raw),
          info: Object.assign({ orientation }, uprightInfo),
          expectedRow: swapping ? 'C' : (orientation === 'up' ? 'UP' : 'NON_SWAP'),
        },
        {
          name: 'engine-image-upright-info',
          src: await blobUrl(engineCanvas),
          info: Object.assign({ orientation }, uprightInfo),
          expectedRow: swapping ? 'D' : (orientation === 'up' ? 'UP' : 'NON_SWAP'),
        },
      ];

      for (const combination of combinations) {
        const src = combination.src;
        infoBySrc[src] = combination.info;
        const image = await loadImage(combination.src);

        for (const mode of ['preview-downscale', 'preview-1to1', 'export-size']) {
          let prepared;
          if (mode === 'export-size') {
            const decision = Photo.decideExifOrientation({
              orientation: combination.info.orientation,
              infoWidth: combination.info.width,
              infoHeight: combination.info.height,
              decodedWidth: image.naturalWidth,
              decodedHeight: image.naturalHeight,
              mode: 'auto',
            });
            prepared = await Photo.prepareExportImage({
              canvas: hostCanvas,
              src,
              width: Math.max(1, Math.round(decision.outputWidth * 0.8)),
              height: Math.max(1, Math.round(decision.outputHeight * 0.8)),
            });
          } else {
            prepared = await Photo.preparePhoto({
              canvas: hostCanvas,
              src,
              devicePixelRatio: 1,
              maxTextureSize: 8192,
              longEdge: mode === 'preview-1to1' ? 400 : 200,
            });
          }
          const reference = referenceCanvas(
            image, prepared.decision, prepared.width, prepared.height
          );
          const comparison = compareCanvases(prepared.canvas, reference);
          const expectedAspect = prepared.decision.outputWidth / prepared.decision.outputHeight;
          const actualAspect = prepared.width / prepared.height;
          const aspectError = Math.abs(actualAspect - expectedAspect) / expectedAspect;
          const record = {
            orientation,
            name: combination.name,
            mode,
            decisionRow: prepared.decision.decisionRow,
            expectedRow: combination.expectedRow,
            sourceSize: [image.naturalWidth, image.naturalHeight],
            outputSize: [prepared.width, prepared.height],
            scaleX: prepared.scaleX,
            scaleY: prepared.scaleY,
            aspectError,
            meanAbsDiff: comparison.meanAbsDiff,
            maxAbsDiff: comparison.maxAbsDiff,
            corners: comparison.corners,
            drawInfo: prepared.drawInfo,
          };
          cases.push(record);
          const rowOk = prepared.decision.decisionRow === combination.expectedRow;
          const pixelsOk = comparison.meanAbsDiff <= 2 && comparison.maxAbsDiff <= 8;
          const aspectOk = aspectError < 0.02;
          if (!rowOk || !pixelsOk || !aspectOk) {
            failures.push({
              orientation,
              name: combination.name,
              mode,
              rowOk,
              pixelsOk,
              aspectOk,
              meanAbsDiff: comparison.meanAbsDiff,
              maxAbsDiff: comparison.maxAbsDiff,
              aspectError,
              decisionRow: prepared.decision.decisionRow,
              expectedRow: combination.expectedRow,
            });
          }
          prepared.release();
        }
      }
    }

    // Regression: a 1600x1200 source drawn without a scale would fill the
    // 200x150 output with the top-left crop only. The bottom-right marker
    // colour must survive in the output.
    const large = makeCanvas(1600, 1200);
    const largeContext = large.getContext('2d');
    largeContext.drawImage(raw, 0, 0, 1600, 1200);
    const largeData = await blobUrl(large);
    const largeSrc = largeData;
    infoBySrc[largeSrc] = { width: 1600, height: 1200, orientation: 'up' };
    const largePrepared = await Photo.preparePhoto({
      canvas: hostCanvas,
      src: largeSrc,
      devicePixelRatio: 1,
      maxTextureSize: 8192,
      longEdge: 200,
    });
    const largeCorners = cornerSamples(largePrepared.canvas);
    const regression = {
      outputSize: [largePrepared.width, largePrepared.height],
      corners: largeCorners,
      // The cyan bottom-right marker must be present in the output.
      bottomRightIsCyan: largeCorners[3][0] < 120 && largeCorners[3][1] > 180 &&
        largeCorners[3][2] > 180,
    };
    if (!regression.bottomRightIsCyan) {
      failures.push({ name: 'no-top-left-crop-regression', regression });
    }
    largePrepared.release();

    // Optional: the real user photo, when the fixture exists.
    let userPhoto = null;
    if (settings.userPhotoUrl) {
      const userImage = await loadImage(settings.userPhotoUrl);
      const userSrc = settings.userPhotoUrl;
      infoBySrc[userSrc] = {
        width: userImage.naturalWidth,
        height: userImage.naturalHeight,
        orientation: 'up',
      };
      const userPrepared = await Photo.preparePhoto({
        canvas: hostCanvas,
        src: userSrc,
        devicePixelRatio: 1,
        maxTextureSize: 8192,
        longEdge: 1280,
      });
      const userReference = referenceCanvas(
        userImage, userPrepared.decision, userPrepared.width, userPrepared.height
      );
      const userComparison = compareCanvases(userPrepared.canvas, userReference);
      userPhoto = {
        sourceSize: [userImage.naturalWidth, userImage.naturalHeight],
        outputSize: [userPrepared.width, userPrepared.height],
        meanAbsDiff: userComparison.meanAbsDiff,
        maxAbsDiff: userComparison.maxAbsDiff,
        corners: userComparison.corners,
        wholeImage: userComparison.meanAbsDiff <= 2,
      };
      if (!userPhoto.wholeImage) {
        failures.push({ name: 'user-photo-whole-image', userPhoto });
      }
      userPrepared.release();
    }

    return { cases, failures, regression, userPhoto };
  };
}());
