// Shared Mini Program / headless-browser WebGL1 renderer.
// The GLSL is embedded in utils/shaders.js for WeChat and read directly from
// shaders/*.glsl by the harness. Do not fork the lookup math into either host.
(function registerRenderer(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SpektrafilmRenderer = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function rendererFactory() {
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
    const gl = canvas.getContext('webgl', CONTEXT_ATTRIBUTES) ||
      canvas.getContext('experimental-webgl', CONTEXT_ATTRIBUTES);
    if (!gl) {
      const error = new Error('WebGL context creation failed');
      error.code = 'WEBGL_UNAVAILABLE';
      throw error;
    }

    const program = createProgram(gl, options.vertexSource, options.fragmentSource);
    const buffer = gl.createBuffer();
    const photoTexture = gl.createTexture();
    const lutTexture = gl.createTexture();
    const uniforms = {
      image: gl.getUniformLocation(program, 'uImage'),
      lut: gl.getUniformLocation(program, 'uLut'),
      n: gl.getUniformLocation(program, 'uN'),
      cols: gl.getUniformLocation(program, 'uCols'),
      rows: gl.getUniformLocation(program, 'uRows'),
      intensity: gl.getUniformLocation(program, 'uIntensity'),
    };
    let lut = null;
    let hasPhoto = false;
    let destroyed = false;

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
    gl.activeTexture(gl.TEXTURE0);

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

    function setLut(source, metadata) {
      if (!metadata || !metadata.size || !metadata.cols || !metadata.rows) {
        throw new Error('Incomplete LUT metadata');
      }
      upload(gl.TEXTURE1, lutTexture, source);
      lut = {
        n: metadata.size,
        cols: metadata.cols,
        rows: metadata.rows,
      };
    }

    function render(intensity) {
      if (destroyed) {
        throw new Error('Renderer has been destroyed');
      }
      if (!hasPhoto) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }
      const amount = lut && Number.isFinite(intensity) ? intensity : 0;
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, photoTexture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lutTexture);
      if (lut) {
        gl.uniform1f(uniforms.n, lut.n);
        gl.uniform1f(uniforms.cols, lut.cols);
        gl.uniform1f(uniforms.rows, lut.rows);
      }
      gl.uniform1f(uniforms.intensity, amount);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function clearPhoto() {
      hasPhoto = false;
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
      render,
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
