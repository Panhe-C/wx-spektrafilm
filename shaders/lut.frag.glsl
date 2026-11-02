#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D uImage;
uniform sampler2D uLut;
uniform sampler2D uLutExtended;
uniform sampler2D uHalo;
uniform float uN;
uniform float uCols;
uniform float uRows;
uniform float uExtendedN;
uniform float uExtendedCols;
uniform float uExtendedRows;
uniform float uUseExtended;
uniform float uCameraIdentity;
uniform vec3 uLinearGain;
uniform float uIntensity;
uniform float uContrast;
uniform float uSaturation;
uniform float uPostIdentity;

// --- normalised frame space ------------------------------------------------
// The picture is mapped into a frame whose long edge is 1.0. uRegionOrigin
// and uRegionSize describe the rectangle this draw covers, so a tiled export
// renders a sub-rectangle of the same global picture and every coordinate
// dependent effect (grain, vignette) stays continuous across the tiles.
uniform vec2 uImageFrameOrigin;
uniform vec2 uImageFrameSize;
uniform vec2 uRegionOrigin;
uniform vec2 uRegionSize;

// --- spatial effects (approximate, see docs/EFFECTS.md) --------------------
uniform float uGrainStrength;
uniform float uGrainGrid;        // grain lattice spacing in frame units
uniform float uGrainCurve[17];   // grain amplitude versus output level
uniform mat3 uGrainMatrix;       // grain colour mixing (Cholesky of the
                                 // measured mid-tone covariance, in 8-bit
                                 // code units)
uniform float uHaloEnabled;
uniform vec3 uHaloStrength;      // per-channel back-reflection coefficient
uniform vec2 uHaloUvScale;
uniform vec2 uHaloUvOffset;
uniform float uVignetteStrength;

varying vec2 vUv;

#define GRAIN_CURVE_SIZE 17
#define HALO_SCALE 4.0

float srgbChannelToLinear(float value) {
  return value <= 0.04045
    ? value / 12.92
    : pow((value + 0.055) / 1.055, 2.4);
}

float linearChannelToSrgb(float value) {
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * pow(value, 1.0 / 2.4) - 0.055;
}

vec3 srgbToLinear(vec3 value) {
  return vec3(
    srgbChannelToLinear(value.r),
    srgbChannelToLinear(value.g),
    srgbChannelToLinear(value.b)
  );
}

vec3 linearToSrgb(vec3 value) {
  return vec3(
    linearChannelToSrgb(value.r),
    linearChannelToSrgb(value.g),
    linearChannelToSrgb(value.b)
  );
}

vec2 sliceUv(vec2 redGreen, float blue, float n, float cols, float rows) {
  float tileColumn = mod(blue, cols);
  float tileRow = floor(blue / cols);
  float last = n - 1.0;

  // Stay between the first and last texel centres of this blue slice. At
  // either endpoint the neighbouring texel has zero bilinear weight, so no
  // adjacent tile can contribute to the sample.
  vec2 inSlice = clamp(redGreen, vec2(0.0), vec2(last));
  vec2 texel = vec2(tileColumn * n, tileRow * n) + inSlice + 0.5;
  return texel / vec2(cols * n, rows * n);
}

vec3 lookupLut(sampler2D lut, vec3 color, float n, float cols, float rows) {
  vec3 q = clamp(color, 0.0, 1.0) * (n - 1.0);
  vec3 q0 = floor(q);
  vec3 q1 = min(q0 + 1.0, vec3(n - 1.0));
  vec3 f = q - q0;

  // Red/green interpolation is performed by LINEAR texture sampling inside
  // each slice. Only the blue interpolation is explicit in the shader.
  vec3 blue0 = texture2D(lut, sliceUv(q.xy, q0.z, n, cols, rows)).rgb;
  vec3 blue1 = texture2D(lut, sliceUv(q.xy, q1.z, n, cols, rows)).rgb;
  return clamp(mix(blue0, blue1, f.z), 0.0, 1.0);
}

// --- procedural grain ------------------------------------------------------
// Integer-hash idiom for WebGL1: multiply-and-fract has no transcendental
// function, so the field is reproducible on every implementation that keeps
// IEEE float semantics. The lattice lives in the normalised frame space, so
// the grain keeps the same size relative to the picture at any resolution.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 point, vec2 seed) {
  vec2 cell = floor(point);
  vec2 f = point - cell;
  vec2 fade = f * f * (3.0 - 2.0 * f);
  float a = hash12(cell + seed);
  float b = hash12(cell + vec2(1.0, 0.0) + seed);
  float c = hash12(cell + vec2(0.0, 1.0) + seed);
  float d = hash12(cell + vec2(1.0, 1.0) + seed);
  return mix(mix(a, b, fade.x), mix(c, d, fade.x), fade.y);
}

// Three independent unit-variance fields; the colour mixing matrix turns
// them into the correlated red/green/blue grain perturbation measured on the
// physical pipeline.
vec3 grainSignal(vec2 framePos) {
  vec2 point = framePos / uGrainGrid;
  float n1 = valueNoise(point, vec2(0.0, 0.0));
  float n2 = valueNoise(point, vec2(37.0, 17.0));
  float n3 = valueNoise(point, vec2(91.0, 53.0));
  // The bilinear value noise has a mean variance of 4/9; rescale to unit
  // variance so the measured covariance matrix stays meaningful.
  return (vec3(n1, n2, n3) - 0.5) * 1.5;
}

float grainCurveLookup(float level) {
  float scaled = clamp(level, 0.0, 1.0) * float(GRAIN_CURVE_SIZE - 1);
  float index = floor(scaled);
  float fraction = scaled - index;
  float low = 0.0;
  float high = 0.0;
  for (int i = 0; i < GRAIN_CURVE_SIZE; ++i) {
    if (float(i) == index) {
      low = uGrainCurve[i];
    }
    if (float(i) == index + 1.0) {
      high = uGrainCurve[i];
    }
  }
  return mix(low, high, fraction);
}

void main() {
  vec3 original = clamp(texture2D(uImage, vUv).rgb, 0.0, 1.0);
  float intensity = clamp(uIntensity, 0.0, 1.0);
  if (intensity <= 0.0) {
    // Hold-to-compare always returns the untouched original, even when the
    // non-physical post-LUT controls are nonidentity.
    gl_FragColor = vec4(original, 1.0);
    return;
  }

  vec2 framePos = uRegionOrigin + vUv * uRegionSize;

  // The camera side (exposure EV, white balance) and the spatial effects
  // that act on the exposure (halation, vignette) share one linear-light
  // stage. With every effect at zero the original bit-exact Phase-4 path is
  // kept.
  bool needsExposure = uCameraIdentity < 0.5 ||
    uHaloEnabled > 0.5 || uVignetteStrength > 0.0;
  vec3 lutInput = original;
  if (needsExposure) {
    vec3 exposure = srgbToLinear(original) * uLinearGain;
    if (uVignetteStrength > 0.0) {
      vec2 centred = (framePos - (uImageFrameOrigin + uImageFrameSize * 0.5)) /
        (uImageFrameSize * 0.5);
      float radius2 = 0.5 * dot(centred, centred);
      exposure *= max(0.0, 1.0 - 0.6 * uVignetteStrength * radius2);
    }
    if (uHaloEnabled > 0.5) {
      vec3 bloom = texture2D(uHalo, vUv * uHaloUvScale + uHaloUvOffset).rgb * HALO_SCALE;
      // Back-reflection halation: the blurred exposure is added to the
      // exposure and the sum is renormalised, exactly like the physical
      // model (the scattered light is taken out of the direct beam).
      exposure = (exposure + uHaloStrength * bloom) / (1.0 + uHaloStrength);
    }
    lutInput = linearToSrgb(clamp(exposure, 0.0, 1.0));
  }

  vec3 graded;
  if (uUseExtended > 0.5) {
    graded = lookupLut(uLutExtended, lutInput, uExtendedN, uExtendedCols, uExtendedRows);
  } else {
    graded = lookupLut(uLut, lutInput, uN, uCols, uRows);
  }

  // Grain is a density effect in the physical pipeline. Here it is applied
  // to the graded picture, with an amplitude that follows the measured
  // grain-versus-level curve of the stock.
  if (uGrainStrength > 0.0) {
    float level = clamp(dot(graded, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    float amplitude = grainCurveLookup(level) * uGrainStrength;
    graded += (uGrainMatrix * grainSignal(framePos)) * amplitude / 255.0;
  }

  // Intensity mixes original and physical LUT output first. Optional contrast
  // and Rec.709 encoded-luma saturation are explicitly non-physical and last.
  vec3 mixed = mix(original, graded, intensity);
  vec3 finalColor = mixed;
  if (uPostIdentity < 0.5) {
    vec3 contrasted = 0.5 + (mixed - 0.5) * uContrast;
    float luma = dot(contrasted, vec3(0.2126, 0.7152, 0.0722));
    finalColor = luma + (contrasted - luma) * uSaturation;
  }
  gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
}
