#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

// Spatial-effect helper pass.
//
//   uMode = 0 : exposure pass. Converts the photo texture to the linear
//                camera exposure (sRGB -> linear, times the camera gain),
//                keeps two stops of headroom and writes exposure/4 so that
//                highlights above diffuse white still contribute to the
//                halation bloom.
//   uMode = 1 : separable Gaussian blur of uSource. The nine taps are
//                placed at (i - 4) * sigma/2 texels, so the kernel covers
//                +/- 2 sigma and is resampled from the texture with the
//                hardware bilinear filter.
//
// The region uniforms place the rendered rectangle in the normalised frame
// space (the long edge of the picture is 1.0), so a tiled export can render
// a padded sub-rectangle of the same global picture and get identical
// results in the overlap.

uniform sampler2D uSource;
uniform float uMode;
uniform vec3 uLinearGain;
uniform vec2 uBlurDirection;
uniform float uBlurSigma;
uniform vec2 uSourceSize;
uniform float uExposureScale;
uniform vec2 uRegionOrigin;
uniform vec2 uRegionSize;
uniform vec2 uImageFrameOrigin;
uniform vec2 uImageFrameSize;
varying vec2 vUv;

float srgbChannelToLinear(float value) {
  return value <= 0.04045
    ? value / 12.92
    : pow((value + 0.055) / 1.055, 2.4);
}

vec3 srgbToLinear(vec3 value) {
  return vec3(
    srgbChannelToLinear(value.r),
    srgbChannelToLinear(value.g),
    srgbChannelToLinear(value.b)
  );
}

void main() {
  if (uMode < 0.5) {
    vec2 framePos = uRegionOrigin + vUv * uRegionSize;
    vec2 imageUv = (framePos - uImageFrameOrigin) / uImageFrameSize;
    vec3 encoded = clamp(texture2D(uSource, imageUv).rgb, 0.0, 1.0);
    vec3 exposure = srgbToLinear(encoded) * uLinearGain;
    gl_FragColor = vec4(clamp(exposure / uExposureScale, 0.0, 1.0), 1.0);
    return;
  }

  if (uBlurSigma <= 0.0) {
    gl_FragColor = vec4(texture2D(uSource, vUv).rgb, 1.0);
    return;
  }

  float stepSize = uBlurSigma * 0.5;
  vec3 sum = vec3(0.0);
  float weightSum = 0.0;
  for (int i = 0; i < 9; ++i) {
    float offset = (float(i) - 4.0) * stepSize;
    float normalized = offset / uBlurSigma;
    float weight = exp(-0.5 * normalized * normalized);
    vec2 uv = vUv + uBlurDirection * offset / uSourceSize;
    sum += texture2D(uSource, uv).rgb * weight;
    weightSum += weight;
  }
  gl_FragColor = vec4(sum / weightSum, 1.0);
}
