// Shared Mini Program / headless-browser WebGL1 renderer.
// The GLSL is embedded in utils/shaders.js for WeChat and read directly from
// shaders/*.glsl by the harness. Do not fork the lookup math into either host.
(function registerRenderer(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./adjust.js'));
  } else {
    root.SpektrafilmRenderer = factory(root.SpektrafilmAdjustments);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function rendererFactory(Adjustments) {
  const CONTEXT_ATTRIBUTES = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
  };

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
    const buffer = gl.createBuffer();
    const photoTexture = gl.createTexture();
    const lutTexture = gl.createTexture();
    const extendedLutTexture = gl.createTexture();
    const targetTexture = gl.createTexture();
    const targetFramebuffer = gl.createFramebuffer();
    const uniforms = {
      image: gl.getUniformLocation(program, 'uImage'),
      lut: gl.getUniformLocation(program, 'uLut'),
      extendedLut: gl.getUniformLocation(program, 'uLutExtended'),
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
    };
    let lut = null;
    let hasPhoto = false;
    let destroyed = false;
    let targetWidth = 0;
    let targetHeight = 0;
    let adjustments = Adjustments.normalize();

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

    function setLut(source, metadata, extendedSource) {
      const base = validateLutMetadata(metadata);
      lut = Object.assign(base, { extended: null });
      upload(gl.TEXTURE1, lutTexture, source);
      if (metadata.extended) {
        if (!extendedSource) {
          throw new Error(`Extended LUT source is required for ${metadata.id || 'this stock'}`);
        }
        const extended = validateLutMetadata(metadata.extended);
        const headroomEv = Number(metadata.extended.headroomEv);
        if (!Number.isFinite(headroomEv) || headroomEv <= 0) {
          throw new Error('Extended LUT headroomEv must be positive');
        }
        upload(gl.TEXTURE2, extendedLutTexture, extendedSource);
        lut.extended = Object.assign(extended, { headroomEv });
      }
    }

    function setAdjustments(patch) {
      adjustments = Adjustments.merge(adjustments, patch);
      return Object.assign({}, adjustments);
    }

    function getAdjustments() {
      return Object.assign({}, adjustments);
    }

    function draw(intensity, adjustmentState) {
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
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, photoTexture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lutTexture);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, extendedLutTexture);
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
      gl.uniform1f(uniforms.contrast, 1 + adjustmentState.contrast);
      gl.uniform1f(uniforms.saturation, adjustmentState.saturation);
      gl.uniform1f(
        uniforms.postIdentity,
        adjustmentState.contrast === 0 && adjustmentState.saturation === 1 ? 1 : 0
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function render(intensity) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      draw(intensity, adjustments);
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
      if (!hasPhoto || !lut) {
        throw new Error('A photo and LUT are required for renderToPixels');
      }
      const width = Math.round(Number(settings.width));
      const height = Math.round(Number(settings.height));
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
        throw new Error('Invalid offscreen render dimensions');
      }
      const state = settings.adjustments === undefined
        ? adjustments
        : Adjustments.normalize(settings.adjustments);
      const intensity = settings.intensity === undefined ? 1 : settings.intensity;
      const started = now();
      ensureTarget(width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer);
      gl.viewport(0, 0, width, height);
      draw(intensity, state);
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
      const hook = settings.onTiming || options.onTiming;
      if (hook) {
        hook(Object.assign({ kind: 'renderToPixels' }, timing));
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
      gl.deleteFramebuffer(targetFramebuffer);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    }

    return {
      canvas,
      gl,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      resize,
      setPhoto,
      setLut,
      setAdjustments,
      getAdjustments,
      render,
      renderToPixels,
      clearPhoto,
      finish,
      destroy,
    };
  }

  return {
    computePreviewSize,
    createRenderer,
  };
}));
