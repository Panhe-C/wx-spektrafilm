// On-device WebGL diagnostics. GL access is isolated in runDiagnostics();
// formatReport() is pure and unit-tested in Node.
(function registerDiagnostics(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SpektrafilmDiagnostics = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function diagnosticsFactory() {
  const PREFIX = '[wx-spektrafilm][diag]';
  let lastReport = null;
  let lastText = '';

  function errorText(error) {
    return String((error && (error.errMsg || error.message)) || error || 'unknown');
  }

  function pixel(value) {
    return Array.isArray(value) ? `[${value.join(',')}]` : '-';
  }

  function number(value, digits) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(digits || 2) : '-';
  }

  function json(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return `<unserialisable: ${errorText(error)}>`;
    }
  }

  function pushSampleLines(lines, test) {
    if (!test) {
      return;
    }
    if (!test.available) {
      lines.push(`  unavailable: ${test.reason || test.error || 'unknown'}`);
      return;
    }
    (test.samples || []).forEach((sample) => {
      lines.push(
        `  ${sample.name} (${sample.x},${sample.y}) cpu=${pixel(sample.cpu)} ` +
        `gpu=${pixel(sample.gpu)} maxDiff=${sample.maxDiff}`
      );
    });
    lines.push(`  maxDiff=${test.maxDiff}`);
  }

  // Keep this formatter deterministic apart from values supplied in report.
  // It deliberately emits only compact probes, never full pixel arrays.
  function formatReport(report) {
    const value = report || {};
    const gl = value.gl || {};
    const canvas = value.canvas || {};
    const upload = value.upload || {};
    const tests = value.tests || {};
    const lines = [
      'WX-SPEKTRAFILM DIAGNOSTIC v1',
      `time: ${value.generatedAt || '-'}`,
      `app: ${json(value.app || {})}`,
      `summary: ${json(value.summary || {})}`,
      '',
      '[WEBGL]',
      `available: ${gl.available === true}`,
      `version: ${gl.version || '-'}`,
      `glsl: ${gl.shadingLanguageVersion || '-'}`,
      `vendor: ${gl.vendor || '-'}`,
      `renderer: ${gl.renderer || '-'}`,
      `unmaskedVendor: ${gl.unmaskedVendor || '-'}`,
      `unmaskedRenderer: ${gl.unmaskedRenderer || '-'}`,
      `attributes: ${json(gl.attributes || null)}`,
      `MAX_TEXTURE_SIZE: ${gl.maxTextureSize === undefined ? '-' : gl.maxTextureSize}`,
      `MAX_TEXTURE_IMAGE_UNITS: ${gl.maxTextureImageUnits === undefined ? '-' : gl.maxTextureImageUnits}`,
      `fragment highp float: ${json(gl.fragmentHighpFloat || null)}`,
      `extensions: ${(gl.extensions || []).join(', ') || '-'}`,
      '',
      '[CANVAS]',
      `node: ${number(canvas.nodeWidth, 1)}x${number(canvas.nodeHeight, 1)} css px`,
      `canvasRect: ${json(canvas.canvasRect || null)}`,
      `stageRect: ${json(canvas.stageRect || null)}`,
      `bufferGeometry: ${json(canvas.bufferGeometry || null)}`,
      `lastPresentation: ${json(canvas.presentation || null)}`,
      `drawingBuffer: ${canvas.drawingBufferWidth || 0}x${canvas.drawingBufferHeight || 0}`,
      `canvas.width/height: ${canvas.width || 0}x${canvas.height || 0}`,
      `viewport: ${pixel(canvas.viewport)}`,
      `pixelRatio: ${canvas.pixelRatio || '-'}`,
      `rule: ${canvas.sizingRule || '-'}`,
      '',
      '[PHOTO SOURCE]',
      json(value.photo || { type: 'none' }),
      '',
      '[THUMBNAIL GEOMETRY]',
      json(value.thumbnail || null),
      '',
      '[UPLOAD]',
      `preferred: ${upload.preferredStrategy || '-'}; active: ${upload.activeStrategy || '-'}`,
      `fallbacks: ${json(upload.fallbacks || [])}`,
    ];

    (value.textures || []).forEach((texture) => {
      lines.push(
        `texture ${texture.name}: ${texture.width}x${texture.height} ${texture.format} ` +
        `unit=${texture.unit === null ? '-' : texture.unit} status=${texture.status} ` +
        `strategy=${texture.strategy || '-'} source=${texture.sourceType || '-'}`
      );
      lines.push(
        `  params: min/mag=${texture.filter} wrap=${texture.wrap} mipmaps=${texture.mipmaps} ` +
        `alpha=${texture.alphaMin === null ? '-' : texture.alphaMin}..` +
        `${texture.alphaMax === null ? '-' : texture.alphaMax}`
      );
      if (['photo', 'lut', 'lutExtended'].indexOf(texture.name) !== -1) {
        lines.push(
          `  decode: cpuDecodeSuspect=${texture.cpuDecodeSuspect === true} ` +
          `photoAllBlack=${texture.photoAllBlack === true} ` +
          `retry=${texture.decodeRetried === true} ` +
          `retryError=${texture.decodeRetryError || '-'}`
        );
      }
      const checks = texture.selfChecks || [];
      const latest = checks[checks.length - 1];
      if (latest) {
        const check = latest.selfCheck || {};
        lines.push(
          `  latest ${latest.strategy}: ok=${latest.ok} error=${latest.error || '-'} ` +
          `gl=${(latest.glErrors || []).join(',') || '-'}`
        );
        if (check.cpuMean !== undefined) {
          lines.push(
            `  photo self-check: cpuMean=${number(check.cpuMean)} ` +
            `gpuMean=${number(check.readbackMean)} centreMaxDiff=${check.centreMaxDiff}`
          );
        }
        if (check.whiteCorner) {
          lines.push(
            `  LUT white: cpu=${pixel(check.whiteCorner.cpu)} ` +
            `gpu=${pixel(check.whiteCorner.gpu)} maxDiff=${check.whiteCorner.maxDiff}`
          );
        }
      }
    });

    lines.push('', '[SOLID COLOUR]');
    const solid = tests.solidColour || {};
    lines.push(
      `expected=${pixel(solid.expected)} gpu=${pixel(solid.pixel)} ` +
      `exact=${solid.exact === true} error=${solid.error || '-'}`
    );
    lines.push('', '[DEFAULT FRAMEBUFFER versus FBO]');
    const presented = tests.defaultFramebuffer || {};
    if (presented.available) {
      lines.push(
        `buffer=${presented.bufferWidth}x${presented.bufferHeight} ` +
        `viewport=${pixel(presented.viewport)} photoRect=${json(presented.photoRect)}`
      );
      (presented.samples || []).forEach((sample) => {
        lines.push(
          `  ${sample.name} (${sample.x},${sample.y}) default=${pixel(sample.defaultPixel)} ` +
          `fbo=${pixel(sample.fbo)} maxDiff=${sample.maxDiff}`
        );
      });
      lines.push(`  maxDiff=${presented.maxDiff}`);
      if (presented.letterbox) {
        lines.push(
          `  letterbox (${presented.letterbox.x},${presented.letterbox.y}) ` +
          `default=${pixel(presented.letterbox.defaultPixel)} ` +
          `expected=${pixel(presented.letterbox.expected)} exact=${presented.letterbox.exact}`
        );
      }
    } else {
      lines.push(`unavailable: ${presented.reason || presented.error || 'unknown'}`);
    }
    lines.push('', '[PHOTO TEXTURE: corners + centre]');
    pushSampleLines(lines, tests.photoTexture);
    lines.push('', '[LUT TEXTURE: black + white corners]');
    pushSampleLines(lines, tests.lutTexture);
    lines.push('', '[FULL SHADER: centre]');
    const full = tests.fullShader || {};
    if (full.available) {
      lines.push(`intensity=1: ${pixel(full.intensity1)}`);
      lines.push(
        `intensity=0: ${pixel(full.intensity0)} cpu=${pixel(full.cpuIntensity0)} ` +
        `maxDiff=${full.intensity0MaxDiff}`
      );
    } else {
      lines.push(`unavailable: ${full.reason || full.error || 'unknown'}`);
    }
    lines.push('', '[GL ERRORS]');
    const errors = value.glErrors || [];
    lines.push(`count: ${errors.length}`);
    errors.slice(-40).forEach((entry) => {
      lines.push(`${entry.stage} ${entry.texture || '-'} ${entry.name} (${entry.code})`);
    });
    if (value.fatal) {
      lines.push('', `[FATAL] ${value.fatal}`);
    }
    return `${lines.join('\n')}\n`;
  }

  function readGlInfo(renderer) {
    const gl = renderer.gl;
    const info = {
      available: true,
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      attributes: gl.getContextAttributes ? gl.getContextAttributes() : null,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
      extensions: (gl.getSupportedExtensions() || []).slice().sort(),
    };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    if (debug) {
      info.unmaskedVendor = gl.getParameter(debug.UNMASKED_VENDOR_WEBGL);
      info.unmaskedRenderer = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
    }
    const highp = gl.getShaderPrecisionFormat
      ? gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)
      : null;
    info.fragmentHighpFloat = highp ? {
      rangeMin: highp.rangeMin,
      rangeMax: highp.rangeMax,
      precision: highp.precision,
    } : null;
    return info;
  }

  function runDiagnostics(options) {
    const settings = options || {};
    const renderer = settings.renderer;
    const canvas = settings.canvas || (renderer && renderer.canvas);
    let report = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      app: settings.app || {},
      photo: settings.photo || { type: 'none' },
      thumbnail: settings.thumbnail || null,
      gl: { available: false },
      canvas: {
        nodeWidth: settings.nodeSize && settings.nodeSize.width,
        nodeHeight: settings.nodeSize && settings.nodeSize.height,
        canvasRect: settings.canvasRect || null,
        stageRect: settings.stageRect || null,
        width: canvas && canvas.width,
        height: canvas && canvas.height,
        pixelRatio: settings.pixelRatio,
        sizingRule: 'stable stage CSS size × pixelRatio; centred GL aspect-fit viewport',
      },
      upload: {},
      textures: [],
      tests: {},
      glErrors: [],
    };
    try {
      if (!renderer || !renderer.gl || !canvas) {
        throw new Error('Renderer or canvas is not available');
      }
      const gl = renderer.gl;
      report.gl = readGlInfo(renderer);
      report.canvas.drawingBufferWidth = gl.drawingBufferWidth;
      report.canvas.drawingBufferHeight = gl.drawingBufferHeight;
      report.canvas.viewport = Array.from(gl.getParameter(gl.VIEWPORT));
      const state = typeof renderer.getDiagnostics === 'function'
        ? renderer.getDiagnostics()
        : {};
      report.upload = state.upload || {};
      report.textures = state.textures || [];
      report.glErrors = state.glErrors || [];
      report.canvas.bufferGeometry = state.bufferGeometry || null;
      report.canvas.presentation = state.presentation || null;
      report.tests = typeof renderer.runDiagnostics === 'function'
        ? renderer.runDiagnostics()
        : { error: 'renderer diagnostics are unavailable' };
      report.glErrors = report.tests.glErrors || report.glErrors;
      if (report.tests.defaultFramebuffer && report.tests.defaultFramebuffer.available) {
        report.canvas.presentation = {
          framebuffer: 'default',
          bufferWidth: report.tests.defaultFramebuffer.bufferWidth,
          bufferHeight: report.tests.defaultFramebuffer.bufferHeight,
          viewport: report.tests.defaultFramebuffer.viewport,
          photoRect: report.tests.defaultFramebuffer.photoRect,
        };
      }
      const tests = report.tests;
      const checks = {
        solidExact: !!(tests.solidColour && tests.solidColour.exact),
        photoWithin1: !tests.photoTexture || !tests.photoTexture.available ||
          tests.photoTexture.maxDiff <= 1,
        lutWithin1: !tests.lutTexture || !tests.lutTexture.available || tests.lutTexture.maxDiff <= 1,
        fullZeroWithin1: !tests.fullShader || !tests.fullShader.available ||
          tests.fullShader.intensity0MaxDiff <= 1,
        defaultMatchesFbo: !tests.defaultFramebuffer || !tests.defaultFramebuffer.available ||
          tests.defaultFramebuffer.maxDiff <= 1,
        letterboxExact: !tests.defaultFramebuffer || !tests.defaultFramebuffer.available ||
          !tests.defaultFramebuffer.letterbox || tests.defaultFramebuffer.letterbox.exact,
        noGlErrors: (report.glErrors || []).length === 0,
      };
      report.summary = {
        ok: Object.keys(checks).every((key) => checks[key]),
        checks,
        activeStrategy: report.upload.activeStrategy || '',
        fallbackCount: (report.upload.fallbacks || []).length,
        cpuDecodeSuspect: report.textures.some((texture) => texture.cpuDecodeSuspect),
        photoAllBlack: report.textures.some((texture) => texture.photoAllBlack),
      };
    } catch (error) {
      report.fatal = errorText(error);
      report.summary = { ok: false, fatal: report.fatal };
    }
    const text = formatReport(report);
    lastReport = report;
    lastText = text;
    console.log(`${PREFIX}\n${text}`);
    if (!report.summary.ok) {
      console.error(`${PREFIX} failed: ${json(report.summary)}`);
    }
    return { report, text };
  }

  return {
    PREFIX,
    formatReport,
    runDiagnostics,
    getLastReport() {
      return lastReport;
    },
    getLastText() {
      return lastText;
    },
  };
}));
