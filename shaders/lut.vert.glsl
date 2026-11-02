precision highp float;

attribute vec2 aPosition;
varying vec2 vUv;

void main() {
  // DOM/canvas images have their top row at v = 0. Flip only the image V
  // coordinate; LUT rows deliberately keep their native top-to-bottom order.
  vUv = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
