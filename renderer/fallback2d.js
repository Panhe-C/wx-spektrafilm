// Deliberate Phase-2 placeholder. A future implementation may resize and draw
// the source photo here, but it cannot provide a colour-accurate 3D LUT without
// implementing interpolation itself.
function createFallback2D() {
  throw new Error('Canvas 2D fallback: not implemented');
}

module.exports = {
  createFallback2D,
};
