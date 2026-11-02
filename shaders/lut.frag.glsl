#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D uImage;
uniform sampler2D uLut;
uniform sampler2D uLutExtended;
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
varying vec2 vUv;

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

void main() {
  vec3 original = clamp(texture2D(uImage, vUv).rgb, 0.0, 1.0);
  float intensity = clamp(uIntensity, 0.0, 1.0);
  if (intensity <= 0.0) {
    // Hold-to-compare always returns the untouched original, even when the
    // non-physical post-LUT controls are nonidentity.
    gl_FragColor = vec4(original, 1.0);
    return;
  }

  vec3 lutInput = original;
  if (uCameraIdentity < 0.5) {
    vec3 linear = srgbToLinear(original) * uLinearGain;
    lutInput = linearToSrgb(clamp(linear, 0.0, 1.0));
  }
  vec3 graded;
  if (uUseExtended > 0.5) {
    graded = lookupLut(uLutExtended, lutInput, uExtendedN, uExtendedCols, uExtendedRows);
  } else {
    graded = lookupLut(uLut, lutInput, uN, uCols, uRows);
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
