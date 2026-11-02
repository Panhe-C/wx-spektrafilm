// Pure adjustment mapping shared by the Mini Program renderer and headless tests.
// Camera EV/WB gains are applied in linear sRGB before the physical film LUT.
(function registerAdjustments(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SpektrafilmAdjustments = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function adjustmentFactory() {
  const DEFAULTS = Object.freeze({
    ev: 0,
    temperature: 0,
    tint: 0,
    contrast: 0,
    saturation: 1,
  });
  const LIMITS = Object.freeze({
    ev: [-2, 2],
    temperature: [-100, 100],
    tint: [-100, 100],
    contrast: [-1, 1],
    saturation: [0, 2],
  });
  const D65_KELVIN = 6504;
  const MIN_KELVIN = 3000;
  const MAX_KELVIN = 12000;
  const TINT_STOPS_AT_100 = 0.5;
  const LUMA = [0.2126, 0.7152, 0.0722];
  const RGB_TO_XYZ = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
  ];
  const XYZ_TO_RGB = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.9692660, 1.8760108, 0.0415560],
    [0.0556434, -0.2040259, 1.0572252],
  ];
  const BRADFORD = [
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
  ];
  const BRADFORD_INVERSE = [
    [0.9869929, -0.1470543, 0.1599627],
    [0.4323053, 0.5183603, 0.0492912],
    [-0.0085287, 0.0400428, 0.9684867],
  ];

  function clamp(value, range) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`Non-finite adjustment: ${value}`);
    }
    return Math.max(range[0], Math.min(range[1], number));
  }

  function normalize(adjustments) {
    const input = adjustments || {};
    return {
      ev: clamp(input.ev === undefined ? DEFAULTS.ev : input.ev, LIMITS.ev),
      temperature: clamp(
        input.temperature === undefined ? DEFAULTS.temperature : input.temperature,
        LIMITS.temperature
      ),
      tint: clamp(input.tint === undefined ? DEFAULTS.tint : input.tint, LIMITS.tint),
      contrast: clamp(
        input.contrast === undefined ? DEFAULTS.contrast : input.contrast,
        LIMITS.contrast
      ),
      saturation: clamp(
        input.saturation === undefined ? DEFAULTS.saturation : input.saturation,
        LIMITS.saturation
      ),
    };
  }

  function merge(previous, patch) {
    return normalize(Object.assign({}, normalize(previous), patch || {}));
  }

  function temperatureToCct(temperature) {
    const value = clamp(temperature, LIMITS.temperature);
    const reciprocalD65 = 1 / D65_KELVIN;
    const reciprocal = value >= 0
      ? reciprocalD65 + (value / 100) * (1 / MIN_KELVIN - reciprocalD65)
      : reciprocalD65 + (value / 100) * (reciprocalD65 - 1 / MAX_KELVIN);
    return 1 / reciprocal;
  }

  // Kim et al. cubic Planckian-locus approximation over the used 3000–12000 K range.
  function cctToXy(kelvin) {
    const t = kelvin;
    const t2 = t * t;
    const t3 = t2 * t;
    const x = t <= 4000
      ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.179910
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.240390;
    let y;
    if (t <= 4000) {
      y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867;
    } else {
      y = 3.0817580 * x * x * x - 5.87338670 * x * x + 3.75112997 * x - 0.37001483;
    }
    return [x, y];
  }

  function xyToXyz(xy) {
    return [xy[0] / xy[1], 1, (1 - xy[0] - xy[1]) / xy[1]];
  }

  function multiplyMatrixVector(matrix, vector) {
    return matrix.map((row) => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]);
  }

  function multiplyMatrices(left, right) {
    return left.map((row) => right[0].map((unused, column) => (
      row[0] * right[0][column] + row[1] * right[1][column] + row[2] * right[2][column]
    )));
  }

  function normalizeWhiteGain(gain) {
    const luminance = gain[0] * LUMA[0] + gain[1] * LUMA[1] + gain[2] * LUMA[2];
    if (!(luminance > 0) || !Number.isFinite(luminance)) {
      throw new Error('Invalid white-balance luminance');
    }
    return gain.map((value) => value / luminance);
  }

  function whiteBalance(temperature, tint) {
    const temp = clamp(temperature, LIMITS.temperature);
    const tintValue = clamp(tint, LIMITS.tint);
    if (temp === 0 && tintValue === 0) {
      return { gain: [1, 1, 1], cct: D65_KELVIN, tintGreenGain: 1 };
    }
    let gain = [1, 1, 1];
    if (temp !== 0) {
      const source = multiplyMatrixVector(BRADFORD, xyToXyz(cctToXy(D65_KELVIN)));
      const destination = multiplyMatrixVector(BRADFORD, xyToXyz(cctToXy(temperatureToCct(temp))));
      const coneScale = [
        [destination[0] / source[0], 0, 0],
        [0, destination[1] / source[1], 0],
        [0, 0, destination[2] / source[2]],
      ];
      const xyzAdaptation = multiplyMatrices(
        multiplyMatrices(BRADFORD_INVERSE, coneScale),
        BRADFORD
      );
      const rgbAdaptation = multiplyMatrices(
        multiplyMatrices(XYZ_TO_RGB, xyzAdaptation),
        RGB_TO_XYZ
      );
      gain = multiplyMatrixVector(rgbAdaptation, [1, 1, 1]);
    }
    const tintGreenGain = Math.pow(2, -TINT_STOPS_AT_100 * tintValue / 100);
    gain[1] *= tintGreenGain;
    return {
      gain: normalizeWhiteGain(gain),
      cct: temperatureToCct(temp),
      tintGreenGain,
    };
  }

  function linearGain(adjustments, headroomEv) {
    const value = normalize(adjustments);
    const wb = whiteBalance(value.temperature, value.tint).gain;
    const exposure = Math.pow(2, value.ev - (headroomEv || 0));
    return wb.map((channel) => channel * exposure);
  }

  function isCameraIdentity(adjustments) {
    const value = normalize(adjustments);
    return value.ev === 0 && value.temperature === 0 && value.tint === 0;
  }

  return {
    DEFAULTS,
    LIMITS,
    D65_KELVIN,
    MIN_KELVIN,
    MAX_KELVIN,
    LUMA,
    normalize,
    merge,
    temperatureToCct,
    cctToXy,
    whiteBalance,
    linearGain,
    isCameraIdentity,
  };
}));
