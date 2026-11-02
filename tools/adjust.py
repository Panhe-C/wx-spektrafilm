"""Shared NumPy math for camera-side and post-LUT renderer adjustments.

The camera operations precede the physical LUT; contrast/saturation are explicitly
non-physical post-processing. Film modeling powered by spektrafilm.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from lut_apply import apply_strip_lut_srgb_float

REC709_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def encoded_srgb(image: np.ndarray) -> np.ndarray:
    array = np.asarray(image)
    if array.dtype == np.uint8:
        return array.astype(np.float32) * np.float32(1.0 / 255.0)
    return array.astype(np.float32)


def srgb_to_linear(encoded: np.ndarray) -> np.ndarray:
    value = np.clip(encoded_srgb(encoded), 0.0, 1.0).astype(np.float32)
    low = value * np.float32(1.0 / 12.92)
    high = np.power((value + np.float32(0.055)) * np.float32(1.0 / 1.055),
                    np.float32(2.4), dtype=np.float32)
    return np.where(value <= np.float32(0.04045), low, high).astype(np.float32)


def linear_to_srgb(linear: np.ndarray) -> np.ndarray:
    value = np.clip(np.asarray(linear, dtype=np.float32), 0.0, 1.0)
    low = value * np.float32(12.92)
    high = (np.float32(1.055) * np.power(value, np.float32(1.0 / 2.4), dtype=np.float32)
            - np.float32(0.055))
    return np.where(value <= np.float32(0.0031308), low, high).astype(np.float32)


def camera_side_srgb(image: np.ndarray, linear_gain=(1.0, 1.0, 1.0)) -> np.ndarray:
    """Apply a camera-side linear RGB gain, then clamp at the LUT input boundary."""
    gain = np.asarray(linear_gain, dtype=np.float32)
    if gain.shape != (3,) or not np.all(np.isfinite(gain)) or np.any(gain < 0.0):
        raise ValueError("linear_gain must contain three finite nonnegative values")
    linear = srgb_to_linear(image) * gain.reshape((1,) * (np.ndim(image) - 1) + (3,))
    return linear_to_srgb(linear)


def apply_lut_camera_gain(image: np.ndarray, png_path: str | Path,
                          linear_gain=(1.0, 1.0, 1.0)) -> np.ndarray:
    adjusted = camera_side_srgb(image, linear_gain)
    return apply_strip_lut_srgb_float(adjusted, png_path)


def post_adjust_srgb(graded: np.ndarray, contrast: float = 0.0,
                     saturation: float = 1.0) -> np.ndarray:
    """Contrast about encoded 0.5, then Rec.709 encoded-luma saturation."""
    value = np.asarray(graded, dtype=np.float32)
    contrasted = np.float32(0.5) + (value - np.float32(0.5)) * np.float32(1.0 + contrast)
    luma = np.sum(contrasted * REC709_LUMA, axis=-1, keepdims=True, dtype=np.float32)
    saturated = luma + (contrasted - luma) * np.float32(saturation)
    return np.clip(saturated, 0.0, 1.0).astype(np.float32)


def finish_adjustments(original: np.ndarray, graded: np.ndarray, intensity: float = 1.0,
                       contrast: float = 0.0, saturation: float = 1.0) -> np.ndarray:
    """Mix original/LUT first; optional non-physical post adjustments come last."""
    source = encoded_srgb(original)
    amount = float(np.clip(intensity, 0.0, 1.0))
    if amount == 0.0:
        return source.copy()
    mixed = source + (np.asarray(graded, dtype=np.float32) - source) * np.float32(amount)
    return post_adjust_srgb(mixed, contrast=contrast, saturation=saturation)


def rounded_srgb(value: np.ndarray) -> np.ndarray:
    return np.rint(np.clip(value, 0.0, 1.0) * 255.0).astype(np.uint8)


__all__ = [
    "REC709_LUMA", "apply_lut_camera_gain", "camera_side_srgb", "encoded_srgb",
    "finish_adjustments", "linear_to_srgb", "post_adjust_srgb", "rounded_srgb",
    "srgb_to_linear",
]
