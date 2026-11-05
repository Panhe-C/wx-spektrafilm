// Shared Mini Program / headless-browser WebGL1 renderer.
// The GLSL is embedded in utils/shaders.js for WeChat and read directly from
// shaders/*.glsl by the harness. Do not fork the lookup math into either host.
(function registerRenderer(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./adjust.js'),
      require('./effects.js'),
      require('./border.js')
    );
  } else {
    root.SpektrafilmRenderer = factory(
      root.SpektrafilmAdjustments,
      root.SpektrafilmEffects,
      root.SpektrafilmBorder
    );
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function rendererFactory(
  Adjustments,
  Effects,
  Border
) {
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
  const UPLOAD_STRATEGIES = Object.freeze({ PIXELS: 'pixels', DIRECT: 'direct' });
  const DIAG_LOG_PREFIX = '[wx-spektrafilm][diag]';
  const PROBE_SIZE = 4;

  function normalizeUploadStrategy(value) {
    const strategy = String(value || UPLOAD_STRATEGIES.PIXELS).toLowerCase();
    if (strategy === 'p' || strategy === 'rgba' || strategy === 'bytes') {
      return UPLOAD_STRATEGIES.PIXELS;
    }
    if (strategy === 'd' || strategy === 'source') {
      return UPLOAD_STRATEGIES.DIRECT;
    }
    if (strategy !== UPLOAD_STRATEGIES.PIXELS && strategy !== UPLOAD_STRATEGIES.DIRECT) {
      throw new Error(`Unknown texture upload strategy: ${value}`);
    }
    return strategy;
  }

  function sourceDimensions(source) {
    const width = Math.round(Number(source && (source.width || source.videoWidth)));
    const height = Math.round(Number(source && (source.height || source.videoHeight)));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new Error('Texture source has invalid dimensions');
    }
    return { width, height };
  }

  function describeSource(source) {
    if (!source) {
      return 'null';
    }
    if (source.pixels && source.width && source.height) {
      return 'rgba-bytes';
    }
    const constructorName = source.constructor && source.constructor.name
      ? String(source.constructor.name)
      : '';
    if (/ImageBitmap/.test(constructorName)) {
      return 'image-bitmap';
    }
    if (/Image/.test(constructorName) || (typeof source.src === 'string' && !source.getContext)) {
      return 'canvas-image';
    }
    if (typeof source.getContext === 'function') {
      try {
        if (source.getContext('2d')) {
          return /OffscreenCanvas/.test(constructorName) ? 'offscreen-2d-canvas' : '2d-canvas';
        }
      } catch (error) {
        // A WebGL canvas cannot also vend a 2D context. It is not a supported
        // source here, but the regular upload error will be more informative.
      }
      return /OffscreenCanvas/.test(constructorName) ? 'offscreen-canvas' : 'canvas';
    }
    return constructorName || typeof source;
  }

  function meanRgb(pixels) {
    let sum = 0;
    const count = Math.floor(pixels.length / 4);
    for (let offset = 0; offset < count * 4; offset += 4) {
      sum += pixels[offset] + pixels[offset + 1] + pixels[offset + 2];
    }
    return count ? sum / (count * 3) : 0;
  }

  function pixelAt(pixels, width, x, y) {
    const offset = (y * width + x) * 4;
    return Array.from(pixels.subarray(offset, offset + 4));
  }

  function maxPixelDifference(first, second) {
    let difference = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      difference = Math.max(difference, Math.abs(first[channel] - second[channel]));
    }
    return difference;
  }

  // CPU equivalent of the centre sample done by the full shader at uv=0.5.
  // Texel-centred diagnostic probes use pixelAt instead; this helper handles
  // the half-way sample on even-sized sources without hiding interpolation.
  function bilinearAtHalf(pixels, width, height) {
    const sourceX = width * 0.5 - 0.5;
    const sourceY = height * 0.5 - 0.5;
    const x0 = Math.max(0, Math.min(width - 1, Math.floor(sourceX)));
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(sourceY)));
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const fx = Math.max(0, sourceX - Math.floor(sourceX));
    const fy = Math.max(0, sourceY - Math.floor(sourceY));
    const p00 = pixelAt(pixels, width, x0, y0);
    const p10 = pixelAt(pixels, width, x1, y0);
    const p01 = pixelAt(pixels, width, x0, y1);
    const p11 = pixelAt(pixels, width, x1, y1);
    return [0, 1, 2, 3].map((channel) => Math.round(
      p00[channel] * (1 - fx) * (1 - fy) + p10[channel] * fx * (1 - fy) +
      p01[channel] * (1 - fx) * fy + p11[channel] * fx * fy
    ));
  }

  function computeDrawingBufferSize(cssWidth, cssHeight, pixelRatio, limits) {
    const width = Number(cssWidth);
    const height = Number(cssHeight);
    const ratio = Number(pixelRatio);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
      !Number.isFinite(ratio) || ratio <= 0) {
      throw new Error('Invalid canvas CSS dimensions or pixel ratio');
    }
    const constraints = limits || {};
    const viewport = constraints.maxViewportDims || [Infinity, Infinity];
    const maxWidth = Math.max(1, Math.floor(Math.min(
      Number(constraints.maxRenderbufferSize) || Infinity,
      Number(viewport[0]) || Infinity
    )));
    const maxHeight = Math.max(1, Math.floor(Math.min(
      Number(constraints.maxRenderbufferSize) || Infinity,
      Number(viewport[1]) || Infinity
    )));
    const requestedWidth = Math.max(1, Math.round(width * ratio));
    const requestedHeight = Math.max(1, Math.round(height * ratio));
    const scale = Math.min(1, maxWidth / requestedWidth, maxHeight / requestedHeight);
    return {
      width: Math.max(1, Math.min(maxWidth, Math.floor(requestedWidth * scale))),
      height: Math.max(1, Math.min(maxHeight, Math.floor(requestedHeight * scale))),
      requestedWidth,
      requestedHeight,
      maxWidth,
      maxHeight,
      clamped: scale < 1,
    };
  }

  function computeAspectFitRect(bufferWidth, bufferHeight, photoWidth, photoHeight) {
    const values = [bufferWidth, bufferHeight, photoWidth, photoHeight].map(Number);
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error('Invalid aspect-fit geometry');
    }
    const scale = Math.min(bufferWidth / photoWidth, bufferHeight / photoHeight);
    const width = Math.max(1, Math.min(bufferWidth, Math.round(photoWidth * scale)));
    const height = Math.max(1, Math.min(bufferHeight, Math.round(photoHeight * scale)));
    return {
      x: Math.floor((bufferWidth - width) / 2),
      y: Math.floor((bufferHeight - height) / 2),
      width,
      height,
    };
  }

  // The photo is fitted into the buffer minus a presentation inset (the CSS
  // pixels that an overlay such as the adjustment sheet covers). The buffer
  // itself never changes: only where the photo is drawn inside it. y is in GL
  // coordinates (bottom-up), so the bottom inset raises the photo.
  function normalizeInset(inset) {
    const source = inset || {};
    const read = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
    return {
      top: read(source.top),
      right: read(source.right),
      bottom: read(source.bottom),
      left: read(source.left),
    };
  }

  function computePresentationRect(bufferWidth, bufferHeight, photoWidth, photoHeight, insetPx) {
    const inset = normalizeInset(insetPx);
    // Never swallow the whole buffer: keep at least a quarter of each axis.
    const maxHorizontal = Math.floor(bufferWidth * 0.75);
    const maxVertical = Math.floor(bufferHeight * 0.75);
    let left = Math.round(inset.left);
    let right = Math.round(inset.right);
    let top = Math.round(inset.top);
    let bottom = Math.round(inset.bottom);
    if (left + right > maxHorizontal) {
      const factor = maxHorizontal / (left + right);
      left = Math.floor(left * factor);
      right = Math.floor(right * factor);
    }
    if (top + bottom > maxVertical) {
      const factor = maxVertical / (top + bottom);
      top = Math.floor(top * factor);
      bottom = Math.floor(bottom * factor);
    }
    const fit = computeAspectFitRect(
      bufferWidth - left - right, bufferHeight - top - bottom, photoWidth, photoHeight
    );
    return {
      x: fit.x + left,
      y: fit.y + bottom,
      width: fit.width,
      height: fit.height,
    };
  }

  // A film border around the photo (utils/border.js). The FRAMED picture
  // (photo plus margins) is fitted into the presentation area exactly like a
  // plain photo, and the photo goes into the sub-rectangle left by the
  // margins. The margins are the remainder, so photo + margins always tile the
  // outer rectangle without a gap. y is in GL coordinates (bottom-up).
  function computeFramedRects(bufferWidth, bufferHeight, layout, insetPx) {
    const outer = computePresentationRect(
      bufferWidth, bufferHeight, layout.outerW, layout.outerH, insetPx
    );
    const scaleX = outer.width / layout.outerW;
    const scaleY = outer.height / layout.outerH;
    const left = Math.round(layout.left * scaleX);
    const right = Math.round(layout.right * scaleX);
    const top = Math.round(layout.top * scaleY);
    const bottom = Math.round(layout.bottom * scaleY);
    return {
      outer,
      photo: {
        x: outer.x + left,
        y: outer.y + bottom,
        width: Math.max(1, outer.width - left - right),
        height: Math.max(1, outer.height - top - bottom),
      },
    };
  }

  function hexToUnitRgb(hex) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
    const value = match ? parseInt(match[1], 16) : 0;
    return [(value >> 16) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
  }

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
    const bufferLimits = {
      maxRenderbufferSize: options.maxRenderbufferSize || gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxViewportDims: options.maxViewportDims || Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)),
    };
    let lastPresentation = null;
    let lastBufferGeometry = null;
    // CSS-pixel insets of the preview (see computePresentationRect).
    let presentationInset = { top: 0, right: 0, bottom: 0, left: 0 };
    let lastIntensity = 1;
    // The film border style of the preview ('none' = no border).
    let frameStyle = 'none';

    const program = createProgram(gl, options.vertexSource, options.fragmentSource);
    const haloProgram = options.haloFragmentSource
      ? createProgram(gl, options.vertexSource, options.haloFragmentSource)
      : null;
    const buffer = gl.createBuffer();
    const textureRecords = Object.create(null);
    const glErrors = [];
    const uploadAttempts = [];
    const uploadFallbacks = [];
    let preferredUploadStrategy = normalizeUploadStrategy(options.uploadStrategy);
    let activeUploadStrategy = preferredUploadStrategy;

    function glErrorName(code) {
      const names = ['INVALID_ENUM', 'INVALID_VALUE', 'INVALID_OPERATION',
        'INVALID_FRAMEBUFFER_OPERATION', 'OUT_OF_MEMORY', 'CONTEXT_LOST_WEBGL'];
      const match = names.find((name) => gl[name] === code);
      return match || `0x${Number(code).toString(16)}`;
    }

    function collectGlErrors(stage, textureName) {
      const found = [];
      for (let index = 0; index < 16; index += 1) {
        const code = gl.getError();
        if (code === gl.NO_ERROR) {
          break;
        }
        const entry = {
          stage,
          texture: textureName || '',
          code,
          name: glErrorName(code),
        };
        found.push(entry);
        glErrors.push(entry);
        if (glErrors.length > 160) {
          glErrors.shift();
        }
        console.error(`${DIAG_LOG_PREFIX}[gl] ${stage} ${entry.name} (${code})`);
      }
      return found;
    }

    function setUnpackState(directSource) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      if (typeof gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL !== 'undefined') {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      }
      // Typed-array uploads are already defined RGBA bytes. Colour-space
      // conversion is only relevant to the direct DOM/WeChat source overload.
      if (directSource && typeof gl.UNPACK_COLORSPACE_CONVERSION_WEBGL !== 'undefined') {
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      }
    }

    // Every WebGL1 texture, including targets and unused samplers, starts as
    // a complete opaque 1x1 RGBA texture. Reallocating with texImage2D does
    // not reset any of these parameters on the same texture object.
    function createTrackedTexture(name, unit) {
      const texture = gl.createTexture();
      const record = {
        name,
        texture,
        unit,
        width: 1,
        height: 1,
        format: 'RGBA8',
        filter: 'LINEAR',
        wrap: 'CLAMP_TO_EDGE',
        mipmaps: false,
        status: 'placeholder',
        strategy: '',
        sourceType: '',
        source: null,
        pixels: null,
        metadata: null,
        cpuDecodeSuspect: false,
        photoAllBlack: false,
        decodeRetried: false,
        decodeRetryError: '',
        selfChecks: [],
      };
      textureRecords[name] = record;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      setUnpackState(false);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255])
      );
      collectGlErrors(`texture-create:${name}`, name);
      return record;
    }

    function allocateTexture(record, width, height) {
      gl.activeTexture(record.unit === null ? gl.TEXTURE0 : record.unit);
      gl.bindTexture(gl.TEXTURE_2D, record.texture);
      setUnpackState(false);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null
      );
      record.width = width;
      record.height = height;
      record.format = 'RGBA8';
      record.status = 'allocated';
      collectGlErrors(`texture-allocate:${record.name}`, record.name);
    }

    gl.activeTexture(gl.TEXTURE0);
    const photoRecord = createTrackedTexture('photo', gl.TEXTURE0);
    const photoTexture = photoRecord.texture;
    gl.activeTexture(gl.TEXTURE1);
    const lutRecord = createTrackedTexture('lut', gl.TEXTURE1);
    const lutTexture = lutRecord.texture;
    gl.activeTexture(gl.TEXTURE2);
    const extendedLutRecord = createTrackedTexture('lutExtended', gl.TEXTURE2);
    const extendedLutTexture = extendedLutRecord.texture;
    gl.activeTexture(gl.TEXTURE0);
    const targetRecord = createTrackedTexture('target', null);
    const targetTexture = targetRecord.texture;
    const targetFramebuffer = gl.createFramebuffer();
    gl.activeTexture(gl.TEXTURE3);
    const haloRecordA = createTrackedTexture('haloA', gl.TEXTURE3);
    const haloTextureA = haloRecordA.texture;
    const haloRecordB = createTrackedTexture('haloB', gl.TEXTURE3);
    const haloTextureB = haloRecordB.texture;
    const haloFramebufferA = gl.createFramebuffer();
    const haloFramebufferB = gl.createFramebuffer();
    gl.activeTexture(gl.TEXTURE0);
    const probeRecord = createTrackedTexture('probe', null);
    const probeFramebuffer = gl.createFramebuffer();
    const probeProgram = createProgram(gl, options.vertexSource, `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uProbeSource;
uniform vec2 uProbePoint;
uniform float uProbeMode;
varying vec2 vUv;
void main() {
  if (uProbeMode > 1.5) {
    gl_FragColor = vec4(1.0, 0.0, 128.0 / 255.0, 1.0);
  } else {
    vec2 uv = uProbeMode > 0.5 ? uProbePoint : vUv;
    gl_FragColor = texture2D(uProbeSource, uv);
  }
}
`);
    const probeUniforms = {
      source: gl.getUniformLocation(probeProgram, 'uProbeSource'),
      point: gl.getUniformLocation(probeProgram, 'uProbePoint'),
      mode: gl.getUniformLocation(probeProgram, 'uProbeMode'),
    };
    allocateTexture(probeRecord, PROBE_SIZE, PROBE_SIZE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, probeFramebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, probeRecord.texture, 0
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Texture diagnostic framebuffer is incomplete');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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

    collectGlErrors('setup');

    function createReadbackCanvas(width, height) {
      if (typeof options.createCanvas2D === 'function') {
        return options.createCanvas2D(width, height);
      }
      if (typeof wx !== 'undefined' && typeof wx.createOffscreenCanvas === 'function') {
        let output;
        try {
          output = wx.createOffscreenCanvas({ type: '2d', width, height });
        } catch (error) {
          output = wx.createOffscreenCanvas(width, height);
        }
        output.width = width;
        output.height = height;
        return output;
      }
      if (typeof document !== 'undefined' && document.createElement) {
        const output = document.createElement('canvas');
        output.width = width;
        output.height = height;
        return output;
      }
      throw new Error('No 2D canvas is available for RGBA source decoding');
    }

    // Strategy P: obtain known, unpremultiplied RGBA bytes. Existing 2D
    // canvases are read 1:1 directly; Images/ImageBitmaps are drawn 1:1 into
    // a scratch 2D canvas with smoothing disabled, then read back.
    function decodeSourceRgba(source) {
      const size = sourceDimensions(source);
      let context = null;
      if (source && typeof source.getContext === 'function') {
        try {
          context = source.getContext('2d');
        } catch (error) {
          context = null;
        }
      }
      if (!context) {
        const scratch = createReadbackCanvas(size.width, size.height);
        context = scratch && scratch.getContext('2d');
        if (!context) {
          throw new Error('The RGBA decoder could not create a 2D context');
        }
        context.imageSmoothingEnabled = false;
        if (typeof context.setTransform === 'function') {
          context.setTransform(1, 0, 0, 1, 0, 0);
        }
        context.clearRect(0, 0, size.width, size.height);
        // The three-argument overload forbids scaling: the source is decoded
        // at exactly its own width and height.
        context.drawImage(source, 0, 0);
      }
      if (typeof context.getImageData !== 'function') {
        throw new Error('The 2D context does not provide getImageData');
      }
      const image = context.getImageData(0, 0, size.width, size.height);
      if (!image || !image.data || image.data.length < size.width * size.height * 4) {
        throw new Error('The 2D RGBA readback returned too few bytes');
      }
      const pixels = new Uint8Array(size.width * size.height * 4);
      pixels.set(image.data.subarray(0, pixels.length));
      let alphaMin = 255;
      let alphaMax = 0;
      for (let offset = 3; offset < pixels.length; offset += 4) {
        alphaMin = Math.min(alphaMin, pixels[offset]);
        alphaMax = Math.max(alphaMax, pixels[offset]);
      }
      return {
        width: size.width,
        height: size.height,
        pixels,
        sourceType: describeSource(source),
        alphaMin,
        alphaMax,
      };
    }

    // Probe passes are deliberately state-restoring: uploads happen while a
    // preview, thumbnail, halo pass, or export target may be live.
    function drawProbe(record, mode, point) {
      const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM);
      const previousViewport = Array.from(gl.getParameter(gl.VIEWPORT));
      const previousActive = gl.getParameter(gl.ACTIVE_TEXTURE);
      const previousActiveBinding = gl.getParameter(gl.TEXTURE_BINDING_2D);
      gl.activeTexture(gl.TEXTURE0);
      const previousZeroBinding = gl.getParameter(gl.TEXTURE_BINDING_2D);
      const output = new Uint8Array(PROBE_SIZE * PROBE_SIZE * 4);
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, probeFramebuffer);
        gl.viewport(0, 0, PROBE_SIZE, PROBE_SIZE);
        gl.useProgram(probeProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, (record || photoRecord).texture);
        gl.uniform1i(probeUniforms.source, 0);
        gl.uniform2f(probeUniforms.point, point ? point[0] : 0, point ? point[1] : 0);
        gl.uniform1f(probeUniforms.mode, mode);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.readPixels(0, 0, PROBE_SIZE, PROBE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, output);
        collectGlErrors('diagnostic-probe', record ? record.name : 'solid');
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
        gl.useProgram(previousProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, previousZeroBinding);
        gl.activeTexture(previousActive);
        gl.bindTexture(gl.TEXTURE_2D, previousActiveBinding);
        gl.viewport(
          previousViewport[0], previousViewport[1],
          previousViewport[2], previousViewport[3]
        );
      }
      return output;
    }

    function sampleTexturePixel(record, x, y) {
      const point = [(x + 0.5) / record.width, (y + 0.5) / record.height];
      return Array.from(drawProbe(record, 1, point).subarray(0, 4));
    }

    function lutWhiteCorner(record, decoded) {
      // The white corner belongs to blue slice N-1, not to the PNG's
      // bottom-right texel: the final row can contain zero-filled unused tiles.
      const metadata = record.metadata || {};
      const n = Number(metadata.size);
      const cols = Number(metadata.cols);
      if (!Number.isFinite(n) || !Number.isFinite(cols) || n < 1 || cols < 1) {
        throw new Error('LUT self-check requires size/cols metadata');
      }
      const blue = n - 1;
      const x = (blue % cols) * n + n - 1;
      const y = Math.floor(blue / cols) * n + n - 1;
      const cpu = pixelAt(decoded.pixels, decoded.width, x, y);
      return {
        x,
        y,
        cpu,
        cpuMean: (cpu[0] + cpu[1] + cpu[2]) / 3,
      };
    }

    function isCpuDecodeSuspect(record, decoded, kind) {
      if (kind === 'photo') {
        return meanRgb(decoded.pixels) <= 1;
      }
      // Every valid shipped film LUT maps the native white node to a
      // non-black print/scan value. Zero here means the 2D decode is suspect,
      // even if the subsequent P upload faithfully uploads those zero bytes.
      return lutWhiteCorner(record, decoded).cpuMean <= 2;
    }

    function uploadSelfCheck(record, decoded, kind, strategy, cpuDecodeSuspect) {
      if (kind === 'photo') {
        const readback = drawProbe(record, 0);
        const readbackMean = meanRgb(readback);
        const cpuMean = meanRgb(decoded.pixels);
        const x = Math.floor(decoded.width / 2);
        const y = Math.floor(decoded.height / 2);
        const cpuCentre = pixelAt(decoded.pixels, decoded.width, x, y);
        const gpuCentre = sampleTexturePixel(record, x, y);
        const centreMaxDiff = maxPixelDifference(cpuCentre, gpuCentre);
        const gpuNonBlack = readbackMean > 2;
        const blackFailure = cpuMean > 2 && readbackMean <= 1;
        // With a zero CPU decode there is no valid reference for P. Do not
        // let zero==zero pass: only a non-black direct GPU readback proves D.
        const ok = cpuDecodeSuspect
          ? strategy === UPLOAD_STRATEGIES.DIRECT && gpuNonBlack
          : !blackFailure;
        return {
          ok,
          blackFailure,
          cpuDecodeSuspect,
          gpuNonBlack,
          cpuMean,
          readbackMean,
          centreMaxDiff,
          centre: { x, y, cpu: cpuCentre, gpu: gpuCentre },
        };
      }
      const white = lutWhiteCorner(record, decoded);
      const gpu = sampleTexturePixel(record, white.x, white.y);
      const maxDiff = maxPixelDifference(white.cpu, gpu);
      const gpuMean = (gpu[0] + gpu[1] + gpu[2]) / 3;
      const gpuNonBlack = gpuMean > 2;
      const blackFailure = white.cpuMean > 2 && gpuMean <= 1;
      const ok = cpuDecodeSuspect
        ? strategy === UPLOAD_STRATEGIES.DIRECT && gpuNonBlack
        : !blackFailure && maxDiff <= 1;
      return {
        ok,
        blackFailure,
        cpuDecodeSuspect,
        gpuNonBlack,
        whiteCorner: { x: white.x, y: white.y, cpu: white.cpu, gpu, maxDiff },
      };
    }

    function uploadRecord(record, source, kind, metadata, retryDecode) {
      let activeSource = source;
      let decoded = decodeSourceRgba(activeSource);
      let decodeRetried = false;
      let decodeRetryError = '';
      record.metadata = metadata || null;
      let cpuDecodeSuspect = isCpuDecodeSuspect(record, decoded, kind);
      if (cpuDecodeSuspect && typeof retryDecode === 'function') {
        // photo.js supplies a one-time redraw from the original, fully loaded
        // canvas.createImage(). This distinguishes a bad first Canvas2D draw
        // from a persistent getImageData/source-upload host failure.
        try {
          activeSource = retryDecode() || activeSource;
          decoded = decodeSourceRgba(activeSource);
          decodeRetried = true;
          cpuDecodeSuspect = isCpuDecodeSuspect(record, decoded, kind);
        } catch (error) {
          decodeRetryError = String(error.message || error);
          console.error(`${DIAG_LOG_PREFIX}[decode] retry failed: ${decodeRetryError}`);
        }
      }

      record.width = decoded.width;
      record.height = decoded.height;
      record.format = 'RGBA8';
      record.sourceType = decoded.sourceType;
      record.alphaMin = decoded.alphaMin;
      record.alphaMax = decoded.alphaMax;
      record.source = activeSource;
      record.pixels = decoded.pixels;
      record.cpuDecodeSuspect = cpuDecodeSuspect;
      record.photoAllBlack = false;
      record.decodeRetried = decodeRetried;
      record.decodeRetryError = decodeRetryError;
      if (cpuDecodeSuspect) {
        console.error(
          `${DIAG_LOG_PREFIX}[decode] ${record.name} CPU decode is suspect ` +
          `(all-black photo/zero LUT white); trying P and D`
        );
      }

      const normalFirst = preferredUploadStrategy;
      const normalSecond = normalFirst === UPLOAD_STRATEGIES.PIXELS
        ? UPLOAD_STRATEGIES.DIRECT
        : UPLOAD_STRATEGIES.PIXELS;
      // A suspect decode always exercises P then D, even when D was sticky
      // from an earlier source. Otherwise zero CPU bytes could keep passing P.
      const strategies = cpuDecodeSuspect
        ? [UPLOAD_STRATEGIES.PIXELS, UPLOAD_STRATEGIES.DIRECT]
        : [normalFirst, normalSecond];
      const attempts = [];

      function attemptUpload(strategy, acceptAllBlack) {
        collectGlErrors(`before-upload:${record.name}`, record.name);
        let check = null;
        let uploadError = null;
        let errors = [];
        try {
          gl.activeTexture(record.unit);
          gl.bindTexture(gl.TEXTURE_2D, record.texture);
          setUnpackState(strategy === UPLOAD_STRATEGIES.DIRECT);
          if (strategy === UPLOAD_STRATEGIES.PIXELS) {
            gl.texImage2D(
              gl.TEXTURE_2D, 0, gl.RGBA, decoded.width, decoded.height, 0,
              gl.RGBA, gl.UNSIGNED_BYTE, decoded.pixels
            );
          } else {
            gl.texImage2D(
              gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, activeSource
            );
          }
          errors = collectGlErrors(`upload-${strategy}:${record.name}`, record.name);
          if (errors.length) {
            throw new Error(`WebGL upload failed: ${errors.map((entry) => entry.name).join(',')}`);
          }
          check = uploadSelfCheck(record, decoded, kind, strategy, cpuDecodeSuspect);
          if (!check.ok && !acceptAllBlack) {
            throw new Error(cpuDecodeSuspect
              ? 'CPU decode is suspect and this strategy did not prove non-black GPU content'
              : 'Texture self-check did not match the CPU source');
          }
        } catch (error) {
          uploadError = error;
        }
        const accepted = !uploadError;
        const attempt = {
          texture: record.name,
          kind,
          strategy,
          ok: accepted,
          acceptedAsAllBlack: accepted && acceptAllBlack,
          cpuDecodeSuspect,
          decodeRetried,
          selfCheck: check,
          error: uploadError ? String(uploadError.message || uploadError) : '',
          glErrors: errors.map((entry) => entry.name),
        };
        attempts.push(attempt);
        uploadAttempts.push(attempt);
        if (uploadAttempts.length > 80) {
          uploadAttempts.shift();
        }
        record.selfChecks.push(attempt);
        if (record.selfChecks.length > 8) {
          record.selfChecks.shift();
        }
        if (!accepted) {
          console.error(
            `${DIAG_LOG_PREFIX}[upload] ${record.name} ${strategy} failed: ${attempt.error}`
          );
        }
        return attempt;
      }

      for (let index = 0; index < strategies.length; index += 1) {
        const strategy = strategies[index];
        const attempt = attemptUpload(strategy, false);
        if (attempt.ok) {
          record.status = 'ready';
          record.strategy = strategy;
          activeUploadStrategy = strategy;
          if (cpuDecodeSuspect && strategy === UPLOAD_STRATEGIES.DIRECT) {
            // D has independently proved real source content despite zero CPU
            // bytes. Keep it sticky so later uploads do not silently return to P.
            preferredUploadStrategy = UPLOAD_STRATEGIES.DIRECT;
            console.error(
              `${DIAG_LOG_PREFIX}[decode] ${record.name} recovered with direct upload; ` +
              'cpuDecodeSuspect:true'
            );
          }
          return {
            strategy,
            cpuDecodeSuspect,
            photoAllBlack: false,
            decodeRetried,
          };
        }
        if (index === 0) {
          preferredUploadStrategy = strategies[1];
          uploadFallbacks.push({
            texture: record.name,
            from: strategy,
            to: strategies[1],
            reason: attempt.error,
            cpuDecodeSuspect,
          });
        }
      }

      const bothBlack = cpuDecodeSuspect && attempts.length === 2 && attempts.every(
        (attempt) => attempt.selfCheck && (
          kind === 'photo'
            ? attempt.selfCheck.readbackMean <= 2
            : attempt.selfCheck.whiteCorner.gpu.slice(0, 3).every((channel) => channel <= 2)
        )
      );
      if (kind === 'photo' && bothBlack) {
        // A genuinely black photograph is legal. Accept P only after D also
        // failed to prove content, and surface an explicit persistent warning.
        record.photoAllBlack = true;
        console.error(
          `${DIAG_LOG_PREFIX}[decode] photoAllBlack:true; accepting black RGBA after D also read black`
        );
        const attempt = attemptUpload(UPLOAD_STRATEGIES.PIXELS, true);
        if (attempt.ok) {
          preferredUploadStrategy = UPLOAD_STRATEGIES.PIXELS;
          activeUploadStrategy = UPLOAD_STRATEGIES.PIXELS;
          record.preferredUploadStrategy = preferredUploadStrategy;
          record.status = 'ready';
          record.strategy = UPLOAD_STRATEGIES.PIXELS;
          return {
            strategy: UPLOAD_STRATEGIES.PIXELS,
            cpuDecodeSuspect: true,
            photoAllBlack: true,
            decodeRetried,
          };
        }
      }

      record.status = 'failed';
      throw new Error(
        `Texture upload self-check failed for ${record.name}: ` +
        attempts.map((entry) => `${entry.strategy}: ${entry.error}`).join('; ')
      );
    }

    function resize(width, height) {
      const requestedWidth = Math.max(1, Math.round(Number(width)));
      const requestedHeight = Math.max(1, Math.round(Number(height)));
      if (!Number.isFinite(requestedWidth) || !Number.isFinite(requestedHeight)) {
        throw new Error('Invalid canvas drawing-buffer dimensions');
      }
      if (canvas.width !== requestedWidth || canvas.height !== requestedHeight) {
        canvas.width = requestedWidth;
        canvas.height = requestedHeight;
      }
      // The host may clamp or otherwise diverge from canvas.width/height.
      // Always use the actual default drawing buffer for GL state.
      const actualWidth = gl.drawingBufferWidth;
      const actualHeight = gl.drawingBufferHeight;
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, actualWidth, actualHeight);
      collectGlErrors('resize');
      return {
        width: actualWidth,
        height: actualHeight,
        requestedWidth,
        requestedHeight,
        clamped: actualWidth !== requestedWidth || actualHeight !== requestedHeight,
      };
    }

    function resizeToCssSize(cssWidth, cssHeight, pixelRatio, overrides) {
      const size = computeDrawingBufferSize(
        cssWidth, cssHeight, pixelRatio, overrides || bufferLimits
      );
      const actual = resize(size.width, size.height);
      lastBufferGeometry = Object.assign({}, size, {
        cssWidth: Number(cssWidth),
        cssHeight: Number(cssHeight),
        pixelRatio: Number(pixelRatio),
        actualWidth: actual.width,
        actualHeight: actual.height,
        hostClamped: actual.clamped,
      });
      return lastBufferGeometry;
    }

    // The canvas keeps its size; only the area the photo is fitted into
    // changes. The caller renders again afterwards.
    function setPresentationInset(inset) {
      presentationInset = normalizeInset(inset);
      return Object.assign({}, presentationInset);
    }

    function getPresentationInset() {
      return Object.assign({}, presentationInset);
    }

    // Choose the border. The layout is computed from the photo at render
    // time, so it can never disagree with the photo that is on screen.
    function setFrame(style) {
      if (!Border) {
        throw new Error('utils/border.js must be loaded before the renderer');
      }
      frameStyle = Border.normalizeStyle(style);
      return frameStyle;
    }

    function getFrame() {
      return frameStyle;
    }

    function setPhoto(source, details, retryDecode) {
      const result = uploadRecord(photoRecord, source, 'photo', null, retryDecode);
      photoRecord.details = details || null;
      hasPhoto = true;
      return result;
    }

    function setUploadStrategy(strategy) {
      preferredUploadStrategy = normalizeUploadStrategy(strategy);
      activeUploadStrategy = preferredUploadStrategy;
    }

    function reuploadTextures() {
      if (photoRecord.source) {
        uploadRecord(photoRecord, photoRecord.source, 'photo', photoRecord.metadata);
      }
      if (lutRecord.source) {
        uploadRecord(lutRecord, lutRecord.source, 'lut', lutRecord.metadata);
      }
      if (extendedLutRecord.source) {
        uploadRecord(
          extendedLutRecord, extendedLutRecord.source, 'lut', extendedLutRecord.metadata
        );
      }
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
      uploadRecord(extendedLutRecord, source, 'lut', metadata);
      return Object.assign(extended, { headroomEv });
    }

    // The extended cube is optional here: it is loaded lazily and only when a
    // positive EV or a nonidentity white balance actually needs it. Drawing
    // without it raises a clear error in draw().
    function setLut(source, metadata, extendedSource) {
      const base = validateLutMetadata(metadata);
      const next = Object.assign(base, { extended: null, stockId: metadata.id || '' });
      uploadRecord(lutRecord, source, 'lut', metadata);
      lut = next;
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
      [haloRecordA, haloRecordB].forEach((record) => {
        allocateTexture(record, width, height);
      });
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, photoTexture);
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
      collectGlErrors('framebuffer:halo');
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
      collectGlErrors('draw:halo-exposure');

      // 2. horizontal blur: haloTextureA -> haloTextureB
      gl.bindFramebuffer(gl.FRAMEBUFFER, haloFramebufferB);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, haloTextureA);
      gl.uniform1f(haloUniforms.mode, 1);
      gl.uniform1f(haloUniforms.blurSigma, sigmaPixels);
      gl.uniform2f(haloUniforms.sourceSize, width, height);
      gl.uniform2f(haloUniforms.blurDirection, 1, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      collectGlErrors('draw:halo-horizontal');

      // 3. vertical blur: haloTextureB -> haloTextureA
      gl.bindFramebuffer(gl.FRAMEBUFFER, haloFramebufferA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, haloTextureB);
      gl.uniform1f(haloUniforms.mode, 1);
      gl.uniform1f(haloUniforms.blurSigma, sigmaPixels);
      gl.uniform2f(haloUniforms.sourceSize, width, height);
      gl.uniform2f(haloUniforms.blurDirection, 0, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      collectGlErrors('draw:halo-vertical');

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
      // The halation chain changed the viewport. FBO paths use their full
      // target; the native preview supplies its centred photo sub-viewport.
      const viewport = target.viewport || {
        x: 0, y: 0, width: target.width, height: target.height,
      };
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.colorMask(true, true, true, true);
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (target.onScreen) {
        lastPresentation = {
          framebuffer: 'default',
          bufferWidth: gl.drawingBufferWidth,
          bufferHeight: gl.drawingBufferHeight,
          viewport: [viewport.x, viewport.y, viewport.width, viewport.height],
          photoRect: {
            x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height,
          },
          frame: target.frame || null,
          intensity,
        };
      }
      collectGlErrors('draw:main');
    }

    function render(intensity) {
      lastIntensity = Number.isFinite(Number(intensity)) ? Number(intensity) : 0;
      const bufferWidth = gl.drawingBufferWidth;
      const bufferHeight = gl.drawingBufferHeight;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.colorMask(true, true, true, true);
      gl.viewport(0, 0, bufferWidth, bufferHeight);
      gl.clearColor(8 / 255, 8 / 255, 8 / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (hasPhoto) {
        const scaleX = lastBufferGeometry && lastBufferGeometry.cssWidth > 0
          ? bufferWidth / lastBufferGeometry.cssWidth : 1;
        const scaleY = lastBufferGeometry && lastBufferGeometry.cssHeight > 0
          ? bufferHeight / lastBufferGeometry.cssHeight : 1;
        const insets = {
          top: presentationInset.top * scaleY,
          bottom: presentationInset.bottom * scaleY,
          left: presentationInset.left * scaleX,
          right: presentationInset.right * scaleX,
        };
        let photoRect;
        let frame = null;
        if (frameStyle !== 'none' && Border) {
          const layout = Border.computeLayout(frameStyle, photoRecord.width, photoRecord.height);
          const rects = computeFramedRects(bufferWidth, bufferHeight, layout, insets);
          photoRect = rects.photo;
          // The margins are flat colour first; the overlay canvas adds the
          // decoration (sprocket holes, edge print) on top. The photo
          // viewport is drawn afterwards and never overlaps the margins.
          const colour = hexToUnitRgb(layout.color);
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(rects.outer.x, rects.outer.y, rects.outer.width, rects.outer.height);
          gl.clearColor(colour[0], colour[1], colour[2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.disable(gl.SCISSOR_TEST);
          gl.clearColor(8 / 255, 8 / 255, 8 / 255, 1);
          frame = {
            style: frameStyle,
            layout,
            outerRect: rects.outer,
            cssRect: {
              x: rects.outer.x / scaleX,
              y: (bufferHeight - rects.outer.y - rects.outer.height) / scaleY,
              width: rects.outer.width / scaleX,
              height: rects.outer.height / scaleY,
            },
          };
        } else {
          photoRect = computePresentationRect(
            bufferWidth, bufferHeight, photoRecord.width, photoRecord.height, insets
          );
        }
        const target = defaultTarget(photoRect.width, photoRect.height);
        // Frame-relative effects use the photo rect, not the letterboxed stage.
        target.viewport = photoRect;
        target.frame = frame;
        target.onScreen = true;
        draw(lastIntensity, adjustments, effects, target);
      } else {
        lastPresentation = {
          framebuffer: 'default',
          bufferWidth,
          bufferHeight,
          viewport: [0, 0, bufferWidth, bufferHeight],
          photoRect: null,
          frame: null,
          intensity: 0,
        };
      }
      collectGlErrors('render');
      return lastPresentation;
    }

    function ensureTarget(width, height) {
      if (width === targetWidth && height === targetHeight) {
        return;
      }
      allocateTexture(targetRecord, width, height);
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
      collectGlErrors('framebuffer:target');
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
      const target = defaultTarget(width, height);
      if (settings.imageUvOffset) {
        target.imageUvOffset = settings.imageUvOffset.slice();
      }
      if (settings.imageUvScale) {
        target.imageUvScale = settings.imageUvScale.slice();
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
      collectGlErrors('readPixels:render-target');
      const read = now();
      const topDown = settings.flipY !== false;
      if (topDown) {
        flipRows(pixels, width, height);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
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

    function summarizeTexture(record) {
      return {
        name: record.name,
        unit: record.unit === null ? null : record.unit - gl.TEXTURE0,
        width: record.width,
        height: record.height,
        format: record.format,
        filter: record.filter,
        wrap: record.wrap,
        mipmaps: record.mipmaps,
        status: record.status,
        strategy: record.strategy || '',
        sourceType: record.sourceType || '',
        alphaMin: record.alphaMin === undefined ? null : record.alphaMin,
        alphaMax: record.alphaMax === undefined ? null : record.alphaMax,
        cpuDecodeSuspect: record.cpuDecodeSuspect === true,
        photoAllBlack: record.photoAllBlack === true,
        decodeRetried: record.decodeRetried === true,
        decodeRetryError: record.decodeRetryError || '',
        selfChecks: record.selfChecks.map((attempt) => JSON.parse(JSON.stringify(attempt))),
      };
    }

    function getDiagnostics() {
      return {
        upload: {
          preferredStrategy: preferredUploadStrategy,
          activeStrategy: activeUploadStrategy,
          attempts: uploadAttempts.map((attempt) => JSON.parse(JSON.stringify(attempt))),
          fallbacks: uploadFallbacks.map((entry) => Object.assign({}, entry)),
        },
        textures: Object.keys(textureRecords).map((name) => summarizeTexture(textureRecords[name])),
        presentation: lastPresentation ? JSON.parse(JSON.stringify(lastPresentation)) : null,
        bufferGeometry: lastBufferGeometry ? Object.assign({}, lastBufferGeometry) : null,
        glErrors: glErrors.map((entry) => Object.assign({}, entry)),
      };
    }

    function runDiagnostics() {
      const result = {};
      function capture(name, callback) {
        try {
          result[name] = callback();
        } catch (error) {
          result[name] = { available: false, error: String(error.message || error) };
          console.error(`${DIAG_LOG_PREFIX} ${name}: ${result[name].error}`);
        }
      }

      capture('solidColour', () => {
        const expected = [255, 0, 128, 255];
        const readback = drawProbe(photoRecord, 2);
        const pixel = Array.from(readback.subarray(0, 4));
        let exact = true;
        for (let offset = 0; offset < readback.length; offset += 1) {
          if (readback[offset] !== expected[offset % 4]) {
            exact = false;
            break;
          }
        }
        return { available: true, expected, pixel, exact, size: PROBE_SIZE };
      });

      capture('photoTexture', () => {
        if (!hasPhoto || !photoRecord.pixels) {
          return { available: false, reason: 'no-photo' };
        }
        const width = photoRecord.width;
        const height = photoRecord.height;
        const points = [
          { name: 'topLeft', x: 0, y: 0 },
          { name: 'topRight', x: width - 1, y: 0 },
          { name: 'bottomLeft', x: 0, y: height - 1 },
          { name: 'bottomRight', x: width - 1, y: height - 1 },
          { name: 'centre', x: Math.floor(width / 2), y: Math.floor(height / 2) },
        ];
        const samples = points.map((point) => {
          const cpu = pixelAt(photoRecord.pixels, width, point.x, point.y);
          const gpu = sampleTexturePixel(photoRecord, point.x, point.y);
          return Object.assign({}, point, {
            cpu,
            gpu,
            maxDiff: maxPixelDifference(cpu, gpu),
          });
        });
        return {
          available: true,
          strategy: photoRecord.strategy,
          sourceType: photoRecord.sourceType,
          cpuDecodeSuspect: photoRecord.cpuDecodeSuspect === true,
          photoAllBlack: photoRecord.photoAllBlack === true,
          decodeRetried: photoRecord.decodeRetried === true,
          width,
          height,
          samples,
          maxDiff: samples.reduce((worst, sample) => Math.max(worst, sample.maxDiff), 0),
        };
      });

      capture('lutTexture', () => {
        if (!lut || !lutRecord.pixels) {
          return { available: false, reason: 'no-lut' };
        }
        const width = lutRecord.width;
        const height = lutRecord.height;
        const points = [
          { name: 'blackCorner', x: 0, y: 0 },
          {
            name: 'whiteCorner',
            x: ((lut.n - 1) % lut.cols) * lut.n + lut.n - 1,
            y: Math.floor((lut.n - 1) / lut.cols) * lut.n + lut.n - 1,
          },
        ];
        const samples = points.map((point) => {
          const cpu = pixelAt(lutRecord.pixels, width, point.x, point.y);
          const gpu = sampleTexturePixel(lutRecord, point.x, point.y);
          return Object.assign({}, point, {
            cpu,
            gpu,
            maxDiff: maxPixelDifference(cpu, gpu),
          });
        });
        return {
          available: true,
          stockId: lut.stockId,
          strategy: lutRecord.strategy,
          sourceType: lutRecord.sourceType,
          cpuDecodeSuspect: lutRecord.cpuDecodeSuspect === true,
          width,
          height,
          samples,
          maxDiff: samples.reduce((worst, sample) => Math.max(worst, sample.maxDiff), 0),
        };
      });

      capture('defaultFramebuffer', () => {
        if (!hasPhoto || !lut) {
          return { available: false, reason: 'photo-and-lut-required' };
        }
        // Draw and read the native default framebuffer before any FBO probe.
        // readPixels coordinates are bottom-up, so flipY:false below gives the
        // FBO pixels exactly the same local coordinate convention.
        const presentation = render(lastIntensity);
        const rect = presentation.photoRect;
        const insetX = rect.width > 2 ? 1 : 0;
        const insetY = rect.height > 2 ? 1 : 0;
        const localPoints = [
          { name: 'centre', x: Math.floor(rect.width / 2), y: Math.floor(rect.height / 2) },
          { name: 'lowerLeftInset', x: insetX, y: insetY },
          { name: 'lowerRightInset', x: rect.width - 1 - insetX, y: insetY },
          { name: 'upperLeftInset', x: insetX, y: rect.height - 1 - insetY },
          {
            name: 'upperRightInset',
            x: rect.width - 1 - insetX,
            y: rect.height - 1 - insetY,
          },
        ];
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const defaults = localPoints.map((point) => {
          const value = new Uint8Array(4);
          gl.readPixels(
            rect.x + point.x, rect.y + point.y, 1, 1,
            gl.RGBA, gl.UNSIGNED_BYTE, value
          );
          return Array.from(value);
        });
        collectGlErrors('readPixels:default-framebuffer');
        const fbo = renderTargetToPixels({
          width: rect.width,
          height: rect.height,
          target: defaultTarget(rect.width, rect.height),
          intensity: lastIntensity,
          adjustments,
          effects,
          flipY: false,
          kind: 'diagnostic-default-comparison',
        });
        const samples = localPoints.map((point, index) => {
          const offset = (point.y * rect.width + point.x) * 4;
          const fboPixel = Array.from(fbo.pixels.subarray(offset, offset + 4));
          return Object.assign({}, point, {
            x: rect.x + point.x,
            y: rect.y + point.y,
            defaultPixel: defaults[index],
            fbo: fboPixel,
            maxDiff: maxPixelDifference(defaults[index], fboPixel),
          });
        });
        let letterbox = null;
        if (rect.x > 0 || rect.y > 0) {
          const x = rect.x > 0 ? 0 : rect.x + Math.floor(rect.width / 2);
          const y = rect.y > 0 ? 0 : rect.y + Math.floor(rect.height / 2);
          const value = new Uint8Array(4);
          // The FBO comparison preserves the default framebuffer; read the
          // stage background before the final on-screen restoration below.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, value);
          letterbox = {
            x,
            y,
            expected: [8, 8, 8, 255],
            defaultPixel: Array.from(value),
          };
          letterbox.exact = letterbox.expected.every(
            (channel, channelIndex) => letterbox.defaultPixel[channelIndex] === channel
          );
        }
        render(lastIntensity);
        return {
          available: true,
          bufferWidth: presentation.bufferWidth,
          bufferHeight: presentation.bufferHeight,
          viewport: presentation.viewport,
          photoRect: rect,
          samples,
          maxDiff: samples.reduce((worst, sample) => Math.max(worst, sample.maxDiff), 0),
          letterbox,
        };
      });

      capture('fullShader', () => {
        if (!hasPhoto || !lut || !photoRecord.pixels) {
          return { available: false, reason: 'photo-and-lut-required' };
        }
        const common = {
          width: 1,
          height: 1,
          adjustments: Adjustments.DEFAULTS,
          effects: Effects.EFFECT_DEFAULTS,
          flipY: false,
        };
        const one = renderTargetToPixels(Object.assign({}, common, {
          target: defaultTarget(1, 1), intensity: 1, kind: 'diagnostic-full-1',
        }));
        const zero = renderTargetToPixels(Object.assign({}, common, {
          target: defaultTarget(1, 1), intensity: 0, kind: 'diagnostic-full-0',
        }));
        const intensity1 = Array.from(one.pixels.subarray(0, 4));
        const intensity0 = Array.from(zero.pixels.subarray(0, 4));
        const cpuIntensity0 = bilinearAtHalf(
          photoRecord.pixels, photoRecord.width, photoRecord.height
        );
        return {
          available: true,
          centrePixel: true,
          intensity1,
          intensity0,
          cpuIntensity0,
          intensity0MaxDiff: maxPixelDifference(cpuIntensity0, intensity0),
        };
      });
      result.glErrors = glErrors.map((entry) => Object.assign({}, entry));
      return result;
    }

    function clearPhoto() {
      if (destroyed) {
        return;
      }
      hasPhoto = false;
      photoRecord.source = null;
      photoRecord.pixels = null;
      photoRecord.status = 'cleared';
      photoRecord.cpuDecodeSuspect = false;
      photoRecord.photoAllBlack = false;
      photoRecord.decodeRetried = false;
      render(0);
    }

    function finish() {
      gl.finish();
    }

    function destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      Object.keys(textureRecords).forEach((name) => {
        const record = textureRecords[name];
        gl.deleteTexture(record.texture);
        record.pixels = null;
        record.source = null;
      });
      gl.deleteFramebuffer(probeFramebuffer);
      gl.deleteProgram(probeProgram);
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
      maxRenderbufferSize: bufferLimits.maxRenderbufferSize,
      maxViewportDims: bufferLimits.maxViewportDims.slice(),
      resize,
      resizeToCssSize,
      setPresentationInset,
      getPresentationInset,
      setFrame,
      getFrame,
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
      setUploadStrategy,
      reuploadTextures,
      getDiagnostics,
      runDiagnostics,
      clearPhoto,
      finish,
      destroy,
    };
  }

  return {
    UPLOAD_STRATEGIES,
    computePreviewSize,
    computeDrawingBufferSize,
    computeAspectFitRect,
    computePresentationRect,
    computeFramedRects,
    computeFrameRect,
    createRenderer,
  };
}));
