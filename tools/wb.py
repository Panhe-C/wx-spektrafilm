"""NumPy mirror of utils/adjust.js Bradford/CCT white-balance mapping."""
from __future__ import annotations

import numpy as np

D65_KELVIN = 6504.0
MIN_KELVIN = 3000.0
MAX_KELVIN = 12000.0
TINT_STOPS_AT_100 = 0.5
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float64)
RGB_TO_XYZ = np.array([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
])
XYZ_TO_RGB = np.array([
    [3.2404542, -1.5371385, -0.4985314],
    [-0.9692660, 1.8760108, 0.0415560],
    [0.0556434, -0.2040259, 1.0572252],
])
BRADFORD = np.array([
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
])
BRADFORD_INVERSE = np.array([
    [0.9869929, -0.1470543, 0.1599627],
    [0.4323053, 0.5183603, 0.0492912],
    [-0.0085287, 0.0400428, 0.9684867],
])


def temperature_to_cct(temperature: float) -> float:
    value = float(np.clip(temperature, -100.0, 100.0))
    reciprocal_d65 = 1.0 / D65_KELVIN
    if value >= 0:
        reciprocal = reciprocal_d65 + value / 100.0 * (1.0 / MIN_KELVIN - reciprocal_d65)
    else:
        reciprocal = reciprocal_d65 + value / 100.0 * (reciprocal_d65 - 1.0 / MAX_KELVIN)
    return 1.0 / reciprocal


def cct_to_xy(kelvin: float) -> np.ndarray:
    t = float(kelvin)
    if t <= 4000:
        x = -0.2661239e9 / t**3 - 0.2343589e6 / t**2 + 0.8776956e3 / t + 0.179910
        y = -0.9549476 * x**3 - 1.37418593 * x**2 + 2.09137015 * x - 0.16748867
    else:
        x = -3.0258469e9 / t**3 + 2.1070379e6 / t**2 + 0.2226347e3 / t + 0.240390
        y = 3.0817580 * x**3 - 5.87338670 * x**2 + 3.75112997 * x - 0.37001483
    return np.array([x, y])


def _xy_to_xyz(xy: np.ndarray) -> np.ndarray:
    return np.array([xy[0] / xy[1], 1.0, (1.0 - xy[0] - xy[1]) / xy[1]])


def white_balance(temperature: float, tint: float) -> dict:
    temp = float(np.clip(temperature, -100.0, 100.0))
    tint_value = float(np.clip(tint, -100.0, 100.0))
    if temp == 0.0 and tint_value == 0.0:
        return {"gain": np.ones(3), "cct": D65_KELVIN, "tintGreenGain": 1.0}
    gain = np.ones(3)
    if temp != 0.0:
        source = BRADFORD @ _xy_to_xyz(cct_to_xy(D65_KELVIN))
        destination = BRADFORD @ _xy_to_xyz(cct_to_xy(temperature_to_cct(temp)))
        cone_scale = np.diag(destination / source)
        xyz_adaptation = BRADFORD_INVERSE @ cone_scale @ BRADFORD
        rgb_adaptation = XYZ_TO_RGB @ xyz_adaptation @ RGB_TO_XYZ
        gain = rgb_adaptation @ np.ones(3)
    tint_green_gain = float(2.0 ** (-TINT_STOPS_AT_100 * tint_value / 100.0))
    gain[1] *= tint_green_gain
    gain /= gain @ LUMA
    return {"gain": gain, "cct": temperature_to_cct(temp), "tintGreenGain": tint_green_gain}


__all__ = ["cct_to_xy", "temperature_to_cct", "white_balance"]
