"""NumPy mirror of the WebGL grain maths (shaders/lut.frag.glsl).

The mirror is used by harness/effects_compare.py to check the shader's grain
statistics against an independent implementation. It is not bit exact: the GPU
evaluates the hash in 32-bit floats and may use fused multiply-add, so only
the statistics are compared.
"""
from __future__ import annotations

import numpy as np

F32 = np.float32


def fract(x: np.ndarray) -> np.ndarray:
    """GLSL fract(): x - floor(x), always in [0, 1)."""
    return x - np.floor(x)


def hash12(px: np.ndarray, py: np.ndarray) -> np.ndarray:
    """GLSL hash12(vec2): multiply-and-fract integer-hash idiom."""
    p3x = fract(px * F32(0.1031))
    p3y = fract(py * F32(0.1031))
    p3z = fract(px * F32(0.1031))
    dot = (p3x * (p3y + F32(33.33))
           + p3y * (p3z + F32(33.33))
           + p3z * (p3x + F32(33.33)))
    p3x = p3x + dot
    p3y = p3y + dot
    p3z = p3z + dot
    return fract((p3x + p3y) * p3z)


def value_noise(point_x: np.ndarray, point_y: np.ndarray,
                seed_x: float, seed_y: float) -> np.ndarray:
    """Bilinear value noise with a smoothstep fade, as in the shader."""
    cell_x = np.floor(point_x)
    cell_y = np.floor(point_y)
    fx = point_x - cell_x
    fy = point_y - cell_y
    ux = fx * fx * (F32(3.0) - F32(2.0) * fx)
    uy = fy * fy * (F32(3.0) - F32(2.0) * fy)
    a = hash12(cell_x + F32(seed_x), cell_y + F32(seed_y))
    b = hash12(cell_x + F32(1.0 + seed_x), cell_y + F32(seed_y))
    c = hash12(cell_x + F32(seed_x), cell_y + F32(1.0 + seed_y))
    d = hash12(cell_x + F32(1.0 + seed_x), cell_y + F32(1.0 + seed_y))
    top = a * (F32(1.0) - ux) + b * ux
    bottom = c * (F32(1.0) - ux) + d * ux
    return top * (F32(1.0) - uy) + bottom * uy


def grain_signal(frame_x: np.ndarray, frame_y: np.ndarray,
                 lattice_frame: float) -> np.ndarray:
    """The three independent unit-variance noise fields of the shader."""
    point_x = frame_x / F32(lattice_frame)
    point_y = frame_y / F32(lattice_frame)
    n1 = value_noise(point_x, point_y, 0.0, 0.0)
    n2 = value_noise(point_x, point_y, 37.0, 17.0)
    n3 = value_noise(point_x, point_y, 91.0, 53.0)
    fields = np.stack([n1, n2, n3], axis=-1).astype(np.float32)
    return (fields - F32(0.5)) * F32(1.5)


def grain_curve_lookup(level: np.ndarray, curve: list[float]) -> np.ndarray:
    """Linear lookup in the 17-point amplitude curve of the shader."""
    size = len(curve)
    scaled = np.clip(level, 0.0, 1.0) * F32(size - 1)
    index = np.floor(scaled).astype(np.int32)
    fraction = scaled - index
    table = np.asarray(curve, dtype=np.float32)
    low = table[np.clip(index, 0, size - 1)]
    high = table[np.clip(index + 1, 0, size - 1)]
    return low + (high - low) * fraction


def apply_grain(graded: np.ndarray, curve: list[float], matrix: np.ndarray,
                lattice_frame: float, strength: float) -> np.ndarray:
    """Return the grain perturbation (in normalised sRGB units) of the shader."""
    graded = np.asarray(graded, dtype=np.float32)
    height, width = graded.shape[:2]
    long_edge = max(height, width)
    columns = (np.arange(width, dtype=np.float32) + F32(0.5)) / F32(long_edge)
    rows = (np.arange(height, dtype=np.float32) + F32(0.5)) / F32(long_edge)
    frame_x = np.broadcast_to(columns[None, :], (height, width))
    frame_y = np.broadcast_to(rows[:, None], (height, width))
    fields = grain_signal(frame_x, frame_y, lattice_frame)
    mixing = np.asarray(matrix, dtype=np.float32).reshape(3, 3)
    mixed = np.einsum("ij,hwj->hwi", mixing, fields)
    luma = (graded[..., 0] * F32(0.2126)
            + graded[..., 1] * F32(0.7152)
            + graded[..., 2] * F32(0.0722))
    amplitude = grain_curve_lookup(luma, curve) * F32(strength)
    return mixed * amplitude[..., None] / F32(255.0)


def autocorrelate(plane: np.ndarray,
                 lags=((1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (6, 0), (1, 1))) -> dict:
    """Normalised autocorrelation of a zero-mean 2D plane."""
    x = plane - plane.mean()
    variance = float(np.mean(x * x))
    out = {}
    if variance <= 0:
        return {f"{dy},{dx}": 0.0 for dy, dx in lags}
    for dy, dx in lags:
        if dy == 0:
            a = x[:, :-dx] if dx else x
            b = x[:, dx:] if dx else x
        else:
            a = x[:-dy, :-dx] if dx else x[:-dy, :]
            b = x[dy:, dx:] if dx else x[dy:, :]
        out[f"{dy},{dx}"] = float(np.mean(a * b) / variance)
    return out


def cross_correlate(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    denominator = np.sqrt(float(np.mean(a * a)) * float(np.mean(b * b)))
    if denominator <= 0:
        return 0.0
    return float(np.mean(a * b) / denominator)


def grain_statistics(image: np.ndarray) -> dict:
    """Standard deviation, autocorrelation and channel correlation of an image."""
    image = np.asarray(image, dtype=np.float64)
    return {
        "std": [float(np.std(image[:, :, c])) for c in range(3)],
        "mean": [float(np.mean(image[:, :, c])) for c in range(3)],
        "autocorr": [autocorrelate(image[:, :, c]) for c in range(3)],
        "cross": {
            "rg": cross_correlate(image[:, :, 0], image[:, :, 1]),
            "rb": cross_correlate(image[:, :, 0], image[:, :, 2]),
            "gb": cross_correlate(image[:, :, 1], image[:, :, 2]),
        },
    }


def radial_profile(diff: np.ndarray, center_x: int, center_y: int,
                   max_radius: int) -> list[dict]:
    """Mean difference per channel as a function of the radius."""
    height, width = diff.shape[:2]
    yy, xx = np.mgrid[0:height, 0:width]
    radius = np.sqrt((yy - center_y) ** 2 + (xx - center_x) ** 2)
    profile = []
    for r in range(0, max_radius + 1):
        mask = (radius >= r) & (radius < r + 1)
        if not mask.any():
            continue
        profile.append({
            "radius_px": r,
            "mean_codes": [float(np.mean(diff[:, :, c][mask])) for c in range(3)],
        })
    return profile
