// Shared Mini Program / headless-browser WebGL1 renderer.
// The GLSL is embedded in utils/shaders.js for WeChat and read directly from
// shaders/*.glsl by the harness. Do not fork the lookup math into either host.
(function registerRenderer(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./adjust.js'), require('./effects.js'));
  } else {
    root.SpektrafilmRenderer = factory(root.SpektrafilmAdjustments, root.SpektrafilmEffects);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function rendererFactory(Adjustments, Effects) {
  const CONTEXT_ATTRIBUTES = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
  };

  // The halation exposure buffer keeps two stops of headroom above diffuse
  // white so that clipped highlights still feed the bloom.
  const HALO_EXPOSURE_SCALE = 4.0;

  function computePreviewSize(width, height, devicePixelRatio, maxTextureSize, longEdge) {
    const targetEdge = longEdge || 1280;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('Invalid photo dimensions');
    }
    const sourceLongEdge = Math.max(width, height);
    const cap = Math.min(devicePixelRatio * sourceLongEdge, maxTextureSize, 2048);
    const outputLongEdge = Math.max(1, Math.min(targetEdge, sourceLongEdge, cap));
    const scale = outputLongEdge / sourceLongEdge;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  // Normalised frame space: the long edge of the picture is 1.0. Every
  // coordinate dependent effect (grain, vignette) is expressed in this space
  // so that a tiled export is continuous across the tile borders.
  function computeFrameRect(width, height) {
    const longEdge = Math.max(width, height);
    return {
      origin: [0, 0],
      size: [width / longEdge, height / longEdge],
      longEdgePx: longEdge,
    };
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'Unknown GLSL compile error';
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function createProgram(gl, vertexSource, fragmentSource) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || 'Unknown WebGL link error';
      gl.deleteProgram(program);
      throw new Error(message);
    }
    return program;
  }

  function createRenderer(canvas, options) {
    if (!canvas || !options || !options.vertexSource || !options.fragmentSource) {
      throw new Error('A canvas and both GLSL sources are required');
    }
    if (!Adjustments) {
      throw new Error('utils/adjust.js must be loaded before the renderer');
    }
    if (!Effects) {
      throw new Error('utils/effects.js must be loaded before the renderer');
    }
    const gl = canvas.getContext('webgl', CONTEXT_ATTRIBUTES) ||
      canvas.getContext('experimental-webgl', CONTEXT_ATTRIBUTES);
    if (!gl) {
      const error = new Error('WebGL context creation failed');
      error.code = 'WEBGL_UNAVAILABLE';
      throw error;
    }
    const now = options.now || (() => {
      if (typeof performance !== 'undefined' && performance.now) {
        return performance.now();
      }
      return Date.now();
    });

    const program = createProgram(gl, options.vertexSource, options.fragmentSource);
    const haloProgram = options.haloFragmentSource
      ? createProgram(gl, options.vertexSource, options.haloFragmentSource)
      : null;
    const buffer = gl.createBuffer();
    const photoTexture = gl.createTexture();
    const lutTexture = gl.createTexture();
    const extendedLutTexture = gl.createTexture();
    const targetTexture = gl.createTexture();
    const targetFramebuffer = gl.createFramebuffer();
    const haloTextureA = gl.createTexture();
    const haloTextureB = gl.createTexture();
    const haloFramebufferA = gl.createFramebuffer();
    const haloFramebufferB = gl.createFramebuffer();
    const uniforms = {
      image: gl.getUniformLocation(program, 'uImage'),
      lut: gl.getUniformLocation(program, 'uLut'),
      extendedLut: gl.getUniformLocation(program, 'uLutExtended'),
      halo: gl.getUniformLocation(program, 'uHalo'),
      n: gl.getUniformLocation(program, 'uN'),
      cols: gl.getUniformLocation(program, 'uCols'),
      rows: gl.getUniformLocation(program, 'uRows'),
      extendedN: gl.getUniformLocation(program, 'uExtendedN'),
      extendedCols: gl.getUniformLocation(program, 'uExtendedCols'),
      extendedRows: gl.getUniformLocation(program, 'uExtendedRows'),
      useExtended: gl.getUniformLocation(program, 'uUseExtended'),
      cameraIdentity: gl.getUniformLocation(program, 'uCameraIdentity'),
      linearGain: gl.getUniformLocation(program, 'uLinearGain'),
      intensity: gl.getUniformLocation(program, 'uIntensity'),
      contrast: gl.getUniformLocation(program, 'uContrast'),
      saturation: gl.getUniformLocation(program, 'uSaturation'),
      postIdentity: gl.getUniformLocation(program, 'uPostIdentity'),
      imageFrameOrigin: gl.getUniformLocation(program, 'uImageFrameOrigin'),
      imageFrameSize: gl.getUniformLocation(program, 'uImageFrameSize'),
      regionOrigin: gl.getUniformLocation(program, 'uRegionOrigin'),
      regionSize: gl.getUniformLocation(program, 'uRegionSize'),
      imageUvOffset: gl.getUniformLocation(program, 'uImageUvOffset'),
      imageUvScale: gl.getUniformLocation(program, 'uImageUvScale'),
      grainStrength: gl.getUniformLocation(program, 'uGrainStrength'),
      grainGrid: gl.getUniformLocation(program, 'uGrainGrid'),
      grainCurve: gl.getUniformLocation(program, 'uGrainCurve[0]'),
      grainMatrix: gl.getUniformLocation(program, 'uGrainMatrix'),
      haloEnabled: gl.getUniformLocation(program, 'uHaloEnabled'),
      haloStrength: gl.getUniformLocation(program, 'uHaloStrength'),
      haloUvScale: gl.getUniformLocation(program, 'uHaloUvScale'),
      haloUvOffset: gl.getUniformLocation(program, 'uHaloUvOffset'),
      vignetteStrength: gl.getUniformLocation(program, 'uVignetteStrength'),
    };
    const haloUniforms = haloProgram ? {
      source: gl.getUniformLocation(haloProgram, 'uSource'),
      mode: gl.getUniformLocation(haloProgram, 'uMode'),
      linearGain: gl.getUniformLocation(haloProgram, 'uLinearGain'),
      blurDirection: gl.getUniformLocation(haloProgram, 'uBlurDirection'),
      blurSigma: gl.getUniformLocation(haloProgram, 'uBlurSigma'),
      sourceSize: gl.getUniformLocation(haloProgram, 'uSourceSize'),
      exposureScale: gl.getUniformLocation(haloProgram, 'uExposureScale'),
      imageUvOffset: gl.getUniformLocation(haloProgram, 'uImageUvOffset'),
      imageUvScale: gl.getUniformLocation(haloProgram, 'uImageUvScale'),
    } : null;

    // A missing uniform would silently disable a feature, so the renderer
    // refuses to start with an incomplete uniform set.
    const missing = Object.keys(uniforms)
      .filter((name) => uniforms[name] === null)
      .map((name) => `u${name[0].toUpperCase()}${name.slice(1)}`);
    if (haloUniforms) {
      Object.keys(haloUniforms)
        .filter((name) => haloUniforms[name] === null)
        .forEach((name) => missing.push(`halo:${name}`));
    }
    if (missing.length) {
      throw new Error(`The shader is missing required uniforms: ${missing.join(', ')}`);
    }

    let lut = null;
    let hasPhoto = false;
    let destroyed = false;
    let targetWidth = 0;
    let targetHeight = 0;
    let haloWidth = 0;
    let haloHeight = 0;
    let adjustments = Adjustments.normalize();
    let effects = Effects.normalize();
    let stockEffects = Effects.forStock('portra400');

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      1, 1,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(uniforms.image, 0);
    gl.uniform1i(uniforms.lut, 1);
    gl.uniform1i(uniforms.extendedLut, 2);
    gl.uniform1i(uniforms.halo, 3);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    gl.clearColor(0, 0, 0, 1);

    function configureTexture(texture) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0])
      );
    }

    gl.activeTexture(gl.TEXTURE0);
    configureTexture(photoTexture);
    gl.activeTexture(gl.TEXTURE1);
    configureTexture(lutTexture);
    gl.activeTexture(gl.TEXTURE2);
    configureTexture(extendedLutTexture);
    gl.activeTexture(gl.TEXTURE3);
    configureTexture(haloTextureA);
    gl.activeTexture(gl.TEXTURE3);
    configureTexture(haloTextureB);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targetTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    function upload(textureUnit, texture, source) {
      gl.activeTexture(textureUnit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      if (typeof gl.UNPACK_COLORSPACE_CONVERSION_WEBGL !== 'undefined') {
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
    }

    function resize(width, height) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
    }

    function setPhoto(source) {
      upload(gl.TEXTURE0, photoTexture, source);
      hasPhoto = true;
    }

    function validateLutMetadata(metadata) {
      if (!metadata || !metadata.size || !metadata.cols || !metadata.rows) {
        throw new Error('Incomplete LUT metadata');
      }
      return {
        n: metadata.size,
        cols: metadata.cols,
        rows: metadata.rows,
      };
    }

    function uploadExtended(source, metadata) {
      const extended = validateLutMetadata(metadata);
      const headroomEv = Number(metadata.headroomEv);
      if (!Number.isFinite(headroomEv) || headroomEv <= 0) {
        throw new Error('Extended LUT headroomEv must be positive');
      }
      upload(gl.TEXTURE2, extendedLutTexture, source);
      return Object.assign(extended, { headroomEv });
    }

    // The extended cube is optional here: it is loaded lazily and only when a
    // positive EV or a nonidentity white balance actually needs it. Drawing
    // without it raises a clear error in draw().
    function setLut(source, metadata, extendedSource) {
      const base = validateLutMetadata(metadata);
      lut = Object.assign(base, { extended: null, stockId: metadata.id || '' });
      upload(gl.TEXTURE1, lutTexture, source);
      stockEffects = Effects.forStock(lut.stockId);
      if (metadata.extended && extendedSource) {
        lut.extended = uploadExtended(extendedSource, metadata.extended);
      }
    }

    function setExtendedLut(source, metadata) {
      if (!lut) {
        throw new Error('A base LUT must be selected before the extended LUT');
      }
      if (!metadata) {
        throw new Error('Extended LUT metadata is required');
      }
      lut.extended = uploadExtended(source, metadata);
    }

    function hasExtendedLut() {
      return !!(lut && lut.extended);
    }

    function setAdjustments(patch) {
      adjustments = Adjustments.merge(adjustments, patch);
      return Object.assign({}, adjustments);
    }

    function getAdjustments() {
      return Object.assign({}, adjustments);
    }

    function setEffects(patch) {
      effects = Effects.merge(effects, patch);
      return Object.assign({}, effects);
    }

    function getEffects() {
      return Object.assign({}, effects);
    }

    function ensureHaloTargets(width, height) {
      if (width === haloWidth && height === haloHeight) {
        return;
      }
      [haloTextureA, haloTextureB].forEach((texture) => {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, null
        );
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, haloFramebufferA);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, haloTextureA, 0
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw new Error('Halation framebuffer is incomplete');
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, haloFramebufferB);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, haloTextureB, 0
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw new Error('Halation blur framebuffer is incomplete');
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      haloWidth = width;
      haloHeight = height;
    }

    // The halation source is the linear camera exposure (sRGB decoded, camera
    // gain applied, two stops of headroom kept). It is blurred separably with
    // a nine-tap Gaussian whose sigma is the frame-relative physical sigma.
    //
    // The chain renders the *padded* region of the picture (the tile plus the
    // halation margin), so that a tiled export is seamless: every pixel of
    // the tile only sees real picture content inside the kernel support.
    function renderHaloChain(target, gain, sigmaPixels) {
      if (!haloProgram) {
        throw new Error('The halation shader source is required for the halation effect');
      }
      const width = target.haloWidth;
      const height = target.haloHeight;
      const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      ensureHaloTargets(width, height);
      gl.useProgram(haloProgram);
      gl.uniform1i(haloUniforms.source, 0);
      gl.uniform3f(haloUniforms.linearGain, gain[0], gain[1], gain[2]);
      gl.uniform1f(haloUniforms.exposureScale, HALO_EXPOSURE_SCALE);
      gl.uniform2f(
        haloUniforms.imageUvOffset,
        target.haloImageUvOffset[0], target.haloImageUvOffset[1]
      );
      gl.uniform2f(
        haloUniforms.imageUvScale,
        target.haloImageUvScale[0], target.haloImageUvScale[1]
      );

      // 1. exposure pass: photo texture -> haloTextureA
      gl.bindFramebuffer(gl.FRAMEBUFFER, haloFramebufferA);
      gl.viewport(0, 0, width, height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, photoTexture);
      gl.uniform1f(haloUniforms.mode, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 2. horizontal blur: haloTextureA -> haloTextureB
      gl.bindFramebuffer(gl.FRAMEBUFFER, haloFramebufferB);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, haloTextureA);
      gl.uniform1f(haloUniforms.mode, 1);
      gl.uniform1f(haloUniforms.blurSigma, sigmaPixels);
      gl.uniform2f(haloUniforms.sourceSize, width, height);
      gl.uniform2f(haloUniforms.blurDirection, 1, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 3. vertical blur: haloTextureB -> haloTextureA
      gl.bindFramebuffer(gl.FRAMEBUFFER, haloFramebufferA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, haloTextureB);
      gl.uniform1f(haloUniforms.mode, 1);
      gl.uniform1f(haloUniforms.blurSigma, sigmaPixels);
      gl.uniform2f(haloUniforms.sourceSize, width, height);
      gl.uniform2f(haloUniforms.blurDirection, 0, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Restore the framebuffer the caller had bound: the main pass may draw
      // into an offscreen target (the tiled export) instead of the canvas.
      gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
    }

    function defaultTarget(width, height) {
      const rect = computeFrameRect(width, height);
      return {
        width,
        height,
        haloWidth: width,
        haloHeight: height,
        regionOrigin: rect.origin,
        regionSize: rect.size,
        imageFrameOrigin: rect.origin,
        imageFrameSize: rect.size,
        imageUvOffset: [0, 0],
        imageUvScale: [1, 1],
        haloImageUvOffset: [0, 0],
        haloImageUvScale: [1, 1],
        haloUvScale: [1, 1],
        haloUvOffset: [0, 0],
        longEdgePx: rect.longEdgePx,
      };
    }

    function draw(intensity, adjustmentState, effectState, target) {
      if (destroyed) {
        throw new Error('Renderer has been destroyed');
      }
      if (!hasPhoto) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }
      const amount = lut && Number.isFinite(intensity) ? intensity : 0;
      const needsExtended = adjustmentState.ev > 0 ||
        adjustmentState.temperature !== 0 || adjustmentState.tint !== 0;
      const useExtended = amount > 0 && needsExtended;
      if (useExtended && !lut.extended) {
        throw new Error('This stock has no extended-range LUT for positive EV/WB');
      }
      const gain = Adjustments.linearGain(
        adjustmentState,
        useExtended ? lut.extended.headroomEv : 0
      );
      const grainStrength = Math.max(0, Number(effectState.grain) || 0);
      const halationStrength = Math.max(0, Number(effectState.halation) || 0);
      const vignetteStrength = Math.max(0, Number(effectState.vignette) || 0);
      const haloEnabled = halationStrength > 0 && !!haloProgram;
      if (halationStrength > 0 && !haloProgram) {
        throw new Error('The halation effect needs the halo shader source');
      }

      if (haloEnabled) {
        const sigmaPixels = Effects.halationSigmaPixels(
          stockEffects.halation.sigmaUm, target.longEdgePx
        );
        renderHaloChain(target, gain, sigmaPixels);
      }

      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, photoTexture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lutTexture);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, extendedLutTexture);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, haloTextureA);
      gl.uniform1f(uniforms.n, lut ? lut.n : 0);
      gl.uniform1f(uniforms.cols, lut ? lut.cols : 0);
      gl.uniform1f(uniforms.rows, lut ? lut.rows : 0);
      if (lut && lut.extended) {
        gl.uniform1f(uniforms.extendedN, lut.extended.n);
        gl.uniform1f(uniforms.extendedCols, lut.extended.cols);
        gl.uniform1f(uniforms.extendedRows, lut.extended.rows);
      }
      gl.uniform1f(uniforms.useExtended, useExtended ? 1 : 0);
      gl.uniform1f(uniforms.cameraIdentity, Adjustments.isCameraIdentity(adjustmentState) ? 1 : 0);
      gl.uniform3f(uniforms.linearGain, gain[0], gain[1], gain[2]);
      gl.uniform1f(uniforms.intensity, amount);
      gl.uniform1f(uniforms.contrast, Adjustments.contrastMultiplier(adjustmentState.contrast));
      gl.uniform1f(uniforms.saturation, adjustmentState.saturation);
      gl.uniform1f(
        uniforms.postIdentity,
        adjustmentState.contrast === 0 && adjustmentState.saturation === 1 ? 1 : 0
      );
      gl.uniform2f(
        uniforms.imageUvOffset,
        target.imageUvOffset[0], target.imageUvOffset[1]
      );
      gl.uniform2f(
        uniforms.imageUvScale,
        target.imageUvScale[0], target.imageUvScale[1]
      );
      gl.uniform2f(
        uniforms.imageFrameOrigin,
        target.imageFrameOrigin[0], target.imageFrameOrigin[1]
      );
      gl.uniform2f(uniforms.imageFrameSize, target.imageFrameSize[0], target.imageFrameSize[1]);
      gl.uniform2f(uniforms.regionOrigin, target.regionOrigin[0], target.regionOrigin[1]);
      gl.uniform2f(uniforms.regionSize, target.regionSize[0], target.regionSize[1]);
      gl.uniform1f(uniforms.grainStrength, grainStrength);
      gl.uniform1f(uniforms.grainGrid, Effects.GRAIN_LATTICE_FRAME);
      gl.uniform1fv(uniforms.grainCurve, stockEffects.grain.curve);
      // The grain matrix is the Cholesky factor of the measured mid-tone
      // grain covariance, stored row-major. WebGL1 wants column-major data
      // and rejects the transpose flag, so the order is swapped here.
      const matrix = stockEffects.grain.matrix;
      gl.uniformMatrix3fv(uniforms.grainMatrix, false, [
        matrix[0], matrix[3], matrix[6],
        matrix[1], matrix[4], matrix[7],
        matrix[2], matrix[5], matrix[8],
      ]);
      gl.uniform1f(uniforms.haloEnabled, haloEnabled ? 1 : 0);
      gl.uniform3f(
        uniforms.haloStrength,
        stockEffects.halation.strength[0] * halationStrength,
        stockEffects.halation.strength[1] * halationStrength,
        stockEffects.halation.strength[2] * halationStrength
      );
      gl.uniform2f(uniforms.haloUvScale, target.haloUvScale[0], target.haloUvScale[1]);
      gl.uniform2f(uniforms.haloUvOffset, target.haloUvOffset[0], target.haloUvOffset[1]);
      gl.uniform1f(uniforms.vignetteStrength, vignetteStrength);
      // The halation chain changed the viewport; the main pass always draws
      // into the target rectangle.
      gl.viewport(0, 0, target.width, target.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function render(intensity) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      draw(intensity, adjustments, effects, defaultTarget(canvas.width, canvas.height));
    }

    function ensureTarget(width, height) {
      if (width === targetWidth && height === targetHeight) {
        return;
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targetTexture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetTexture, 0
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw new Error('Offscreen RGBA framebuffer is incomplete');
      }
      targetWidth = width;
      targetHeight = height;
    }

    function flipRows(pixels, width, height) {
      const stride = width * 4;
      const temporary = new Uint8Array(stride);
      for (let top = 0; top < Math.floor(height / 2); top += 1) {
        const bottom = height - top - 1;
        const topOffset = top * stride;
        const bottomOffset = bottom * stride;
        temporary.set(pixels.subarray(topOffset, topOffset + stride));
        pixels.copyWithin(topOffset, bottomOffset, bottomOffset + stride);
        pixels.set(temporary, bottomOffset);
      }
    }

    function renderToPixels(options) {
      const settings = options || {};
      const width = Math.round(Number(settings.width));
      const height = Math.round(Number(settings.height));
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
        throw new Error('Invalid offscreen render dimensions');
      }
      return renderTargetToPixels({
        width,
        height,
        target: defaultTarget(width, height),
        intensity: settings.intensity,
        adjustments: settings.adjustments,
        effects: settings.effects,
        flipY: settings.flipY,
        onTiming: settings.onTiming,
        kind: 'renderToPixels',
      });
    }

    /**
     * Render a sub-rectangle of the picture.
     *
     * The target describes the rectangle in the normalised frame space and
     * the uv mapping of the photo texture, so the grain, the vignette and the
     * halation stay continuous with the rest of the picture. This is the
     * path the full-resolution export uses to render its tiles.
     */
    function renderRegionToPixels(options) {
      const settings = options || {};
      const width = Math.round(Number(settings.width));
      const height = Math.round(Number(settings.height));
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
        throw new Error('Invalid region render dimensions');
      }
      const target = settings.target;
      if (!target) {
        throw new Error('A region target is required for renderRegionToPixels');
      }
      if (target.width !== width || target.height !== height) {
        throw new Error('The region target does not match the requested size');
      }
      return renderTargetToPixels({
        width,
        height,
        target,
        intensity: settings.intensity,
        adjustments: settings.adjustments,
        effects: settings.effects,
        flipY: settings.flipY,
        onTiming: settings.onTiming,
        kind: 'renderRegionToPixels',
      });
    }

    function renderTargetToPixels(options) {
      const settings = options || {};
      if (!hasPhoto || !lut) {
        throw new Error('A photo and LUT are required to render offscreen');
      }
      const width = settings.width;
      const height = settings.height;
      const state = settings.adjustments === undefined
        ? adjustments
        : Adjustments.normalize(settings.adjustments);
      const effectState = settings.effects === undefined
        ? effects
        : Effects.normalize(settings.effects);
      const intensity = settings.intensity === undefined ? 1 : settings.intensity;
      const started = now();
      ensureTarget(width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer);
      gl.viewport(0, 0, width, height);
      draw(intensity, state, effectState, settings.target);
      const submitted = now();
      gl.finish();
      const rendered = now();
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const read = now();
      const topDown = settings.flipY !== false;
      if (topDown) {
        flipRows(pixels, width, height);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      const timing = {
        submitMs: submitted - started,
        renderMs: rendered - started,
        readPixelsMs: read - rendered,
        totalMs: read - started,
      };
      const result = {
        pixels,
        width,
        height,
        format: 'RGBA8',
        rowOrder: topDown ? 'top-down' : 'bottom-up',
        timing,
      };
      const hook = settings.onTiming;
      if (hook) {
        hook(Object.assign({ kind: settings.kind || 'renderToPixels' }, timing));
      }
      return result;
    }

    function clearPhoto() {
      hasPhoto = false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    function finish() {
      gl.finish();
    }

    function destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      gl.deleteTexture(photoTexture);
      gl.deleteTexture(lutTexture);
      gl.deleteTexture(extendedLutTexture);
      gl.deleteTexture(targetTexture);
      gl.deleteTexture(haloTextureA);
      gl.deleteTexture(haloTextureB);
      gl.deleteFramebuffer(targetFramebuffer);
      gl.deleteFramebuffer(haloFramebufferA);
      gl.deleteFramebuffer(haloFramebufferB);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      if (haloProgram) {
        gl.deleteProgram(haloProgram);
      }
    }

    return {
      canvas,
      gl,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      resize,
      setPhoto,
      setLut,
      setExtendedLut,
      hasExtendedLut,
      setAdjustments,
      getAdjustments,
      setEffects,
      getEffects,
      render,
      renderToPixels,
      renderRegionToPixels,
      clearPhoto,
      finish,
      destroy,
    };
  }

  return {
    computePreviewSize,
    computeFrameRect,
    createRenderer,
  };
}));
