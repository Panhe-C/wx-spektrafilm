#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D uImage;
uniform sampler2D uLut;
uniform float uN;
uniform float uCols;
uniform float uRows;
uniform float uIntensity;
varying vec2 vUv;

vec2 sliceUv(vec2 redGreen, float blue) {
  float tileColumn = mod(blue, uCols);
  float tileRow = floor(blue / uCols);
  float last = uN - 1.0;

  // Stay between the first and last texel centres of this blue slice. At
  // either endpoint the neighbouring texel has zero bilinear weight, so no
  // adjacent tile can contribute to the sample.
  vec2 inSlice = clamp(redGreen, vec2(0.0), vec2(last));
  vec2 texel = vec2(tileColumn * uN, tileRow * uN) + inSlice + 0.5;
  return texel / vec2(uCols * uN, uRows * uN);
}

void main() {
  vec3 original = clamp(texture2D(uImage, vUv).rgb, 0.0, 1.0);
  vec3 q = original * (uN - 1.0);
  vec3 q0 = floor(q);
  vec3 q1 = min(q0 + 1.0, vec3(uN - 1.0));
  vec3 f = q - q0;

  // Red/green interpolation is performed by LINEAR texture sampling inside
  // each slice. Only the blue interpolation is explicit in the shader.
  vec3 blue0 = texture2D(uLut, sliceUv(q.xy, q0.z)).rgb;
  vec3 blue1 = texture2D(uLut, sliceUv(q.xy, q1.z)).rgb;
  vec3 graded = clamp(mix(blue0, blue1, f.z), 0.0, 1.0);

  // Input and LUT values are already encoded sRGB: no gamma conversion here.
  gl_FragColor = vec4(clamp(mix(original, graded, clamp(uIntensity, 0.0, 1.0)), 0.0, 1.0), 1.0);
}
