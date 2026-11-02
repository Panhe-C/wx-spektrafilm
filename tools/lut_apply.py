"""Apply tiled-grid 2D LUTs with WebGL-equivalent trilinear interpolation."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

DEFAULT_COLS = 8
_CHUNK_PIXELS = 131_072


def _read_grid(png_path: str | Path, cols: int = DEFAULT_COLS) -> tuple[np.ndarray, int, int, int]:
    with Image.open(png_path) as image:
        if image.mode != "RGB":
            raise ValueError(f"{png_path}: expected an RGB PNG, got {image.mode}")
        grid = np.asarray(image, dtype=np.uint8)
    height, width, channels = grid.shape
    if channels != 3 or cols < 1 or width % cols:
        raise ValueError(f"{png_path}: invalid tiled-grid shape {width}x{height}, cols={cols}")
    n = width // cols
    if n < 2 or height % n:
        raise ValueError(f"{png_path}: cannot infer cube size from {width}x{height}")
    rows = height // n
    if rows != (n + cols - 1) // cols:
        raise ValueError(f"{png_path}: expected rows=ceil(N/{cols}), got N={n}, rows={rows}")
    return grid, n, cols, rows


def _coordinates(image: np.ndarray, n: int) -> tuple[np.ndarray, ...]:
    rgb = image.astype(np.float32) * np.float32(1.0 / 255.0)
    coordinates = rgb * np.float32(n - 1)
    lower = np.floor(coordinates).astype(np.intp)
    fraction = coordinates - lower
    upper = np.minimum(lower + 1, n - 1)
    r0, g0, b0 = (lower[..., channel] for channel in range(3))
    r1, g1, b1 = (upper[..., channel] for channel in range(3))
    fr, fg, fb = (fraction[..., channel] for channel in range(3))
    return r0, g0, b0, r1, g1, b1, fr, fg, fb


def _trilinear(image: np.ndarray, n: int, vertex) -> np.ndarray:
    """Chunked eight-vertex interpolation; vertex(b,g,r) returns RGB values."""
    flat = image.reshape(-1, 3)
    output = np.empty(flat.shape, dtype=np.float32)
    for start in range(0, flat.shape[0], _CHUNK_PIXELS):
        stop = min(start + _CHUNK_PIXELS, flat.shape[0])
        chunk = flat[start:stop]
        r0, g0, b0, r1, g1, b1, fr, fg, fb = _coordinates(chunk, n)
        accum = np.zeros(chunk.shape, dtype=np.float32)
        for b_index, wb in ((b0, 1.0 - fb), (b1, fb)):
            for g_index, wg in ((g0, 1.0 - fg), (g1, fg)):
                for r_index, wr in ((r0, 1.0 - fr), (r1, fr)):
                    weight = (wb * wg * wr)[:, None]
                    accum += vertex(b_index, g_index, r_index).astype(np.float32) * weight
        output[start:stop] = accum
    return output.reshape(image.shape)


def apply_cube_lut(img_uint8: np.ndarray, table: np.ndarray) -> np.ndarray:
    """Float sRGB output through an unquantized [blue,green,red,RGB] cube."""
    image = np.asarray(img_uint8)
    if image.dtype != np.uint8 or image.ndim < 2 or image.shape[-1] != 3:
        raise ValueError("img_uint8 must be a uint8 array with shape (..., 3)")
    table = np.asarray(table)
    if table.ndim != 4 or table.shape[-1] != 3 or not all(
        size == table.shape[0] for size in table.shape[:3]
    ):
        raise ValueError(f"table must have shape (N,N,N,3), got {table.shape}")
    n = table.shape[0]
    return _trilinear(image, n, lambda b, g, r: table[b, g, r])


def apply_strip_lut_float(img_uint8: np.ndarray, png_path: str | Path,
                          cols: int = DEFAULT_COLS) -> np.ndarray:
    """Float sRGB output through the 8-bit tiled PNG, without final rounding."""
    image = np.asarray(img_uint8)
    if image.dtype != np.uint8 or image.ndim < 2 or image.shape[-1] != 3:
        raise ValueError("img_uint8 must be a uint8 array with shape (..., 3)")
    grid, n, cols, _ = _read_grid(png_path, cols)

    def vertex(b, g, r):
        x = (b % cols) * n + r
        y = (b // cols) * n + g
        return grid[y, x].astype(np.float32) * np.float32(1.0 / 255.0)

    return _trilinear(image, n, vertex)


def apply_strip_lut(img_uint8: np.ndarray, png_path: str | Path,
                    cols: int = DEFAULT_COLS) -> np.ndarray:
    """Return 8-bit RGB after the same lookup and final rounding as WebGL.

    Input code ``c`` maps to cube coordinate ``c * (N - 1)``. Blue slices are
    row-major with eight slices per row. Slice ``b`` starts at texel
    ``x=(b%8)*N, y=(b//8)*N``; within it, red is x and green is y. A vertex's
    normalized center is therefore ``((x+r+0.5)/(8*N),
    (y+g+0.5)/(rows*N))``. A shader takes two hardware-bilinear samples (one
    in each adjacent blue slice) and mixes them by the blue fraction. Explicit
    per-slice red addressing prevents bleeding into neighboring slices.
    """
    output = apply_strip_lut_float(img_uint8, png_path, cols=cols)
    return np.rint(np.clip(output, 0.0, 1.0) * 255.0).astype(np.uint8)


__all__ = ["apply_cube_lut", "apply_strip_lut", "apply_strip_lut_float"]
