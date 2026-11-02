"""Single physical spektrafilm recipe shared by bake and full simulate().

No project-owned post-simulation tone, levels, or neutralization transform is
allowed. Film modeling powered by spektrafilm:
https://github.com/andreavolpato/spektrafilm
"""
from __future__ import annotations

import json
import math
from dataclasses import asdict
from pathlib import Path

import numpy as np

from spektrafilm.runtime.params_builder import digest_params, init_params
from spektrafilm_lut_creator.bundles import BundleSpec
from spektrafilm_lut_creator.color_spaces import (
    decode_cctf,
    encode_cctf,
    input_exposure_gain,
    output_midgray_gain,
)

ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build"
LUT_DIR = ROOT / "subpackages" / "luts"
STOCKS_PATH = Path(__file__).with_name("stocks.json")
SPEKTRAFILM_ROOT = Path("/workspace/spektrafilm")
TESTPHOTO_ROOT = Path("/workspace/testphotos")
TEST_PHOTO_DIR = TESTPHOTO_ROOT

INPUT_COLOR_SPACE = "sRGB"
OUTPUT_COLOR_SPACE = "sRGB"
LUT_RESOLUTIONS = (33, 49, 65)
LUT_RESOLUTION = 33
LUT_COLS = 8
LUT_GRID_COLS = LUT_COLS
MAX_TEXTURE_SIDE = 2048
MAX_LUT_DIRECTORY_BYTES = int(1.5 * 1024 * 1024)
MAX_PHASE4_LUT_DIRECTORY_BYTES = 1_200_000
MAX_PHASE4_LUT_DIRECTORY_BYTES = 1_200_000
RAMP_CODES = np.array([0, 20, 45, 60, 80, 118, 170, 200, 230, 250, 255], dtype=np.uint8)

NATIVE_STOPS_ABOVE_MIDGRAY = math.log2(1.0 / 0.18)
STOPS_ABOVE_MIDGRAY = NATIVE_STOPS_ABOVE_MIDGRAY
EXPOSURE_HEADROOM_EV = 2.0
EXTENDED_STOPS_ABOVE_MIDGRAY = STOPS_ABOVE_MIDGRAY + EXPOSURE_HEADROOM_EV
UPSTREAM_SDR_STOPS = 4.0
# Measured exploration diagnostic only. The per-photo values scatter widely and
# print compensation cancels this offset for negative/print stocks but not for
# direct-scan slides. It is therefore not used as the production exposure.
AUTO_EXPOSURE_MEDIAN_EV = -0.6522495
# sRGB code 118 decodes to approximately 0.18 linear metered mid-grey: zero EV
# is the auto-exposure-equivalent fixed setting for a balanced phone photo.
CAMERA_EXPOSURE_COMPENSATION_EV = 0.0

# One global recipe. Only film/paper data, database neutral filters, and the
# positive-film direct-scan route vary per stock.
GLOBAL_RECIPE = {
    "id": "native_zero_scan_v2",
    "stops_above_midgray": STOPS_ABOVE_MIDGRAY,
    "camera_exposure_compensation_ev": CAMERA_EXPOSURE_COMPENSATION_EV,
    "enlarger_print_exposure": 1.0,
    "print_exposure_compensation": True,
    "normalize_print_exposure": True,
    "neutral_print_filters_from_database": True,
    "illuminant": "TH-KG3",
    "y_filter_shift": 0.0,
    "m_filter_shift": 0.0,
    "scanner_white_correction": True,
    "scanner_black_correction": True,
    "scanner_white_level": 0.98,
    "scanner_black_level": 0.01,
    "output_gamut_algorithm": "cam16ucs",
}
# Backward-compatible, JSON-friendly alias used by the baker/report scripts.
PHYSICAL_RECIPE = {
    "camera_exposure_compensation_ev": CAMERA_EXPOSURE_COMPENSATION_EV,
    "enlarger_print_exposure_ev": 0.0,
    "enlarger_print_exposure_compensation": True,
    "enlarger_normalize_print_exposure": True,
    "neutral_print_filters_from_database": True,
    "enlarger_illuminant": "TH-KG3",
    "enlarger_y_filter_shift": 0.0,
    "enlarger_m_filter_shift": 0.0,
    "scanner_white_correction": True,
    "scanner_black_correction": True,
    "scanner_white_level": 0.98,
    "scanner_black_level": 0.01,
}


def load_stocks() -> list[dict]:
    stocks = json.loads(STOCKS_PATH.read_text(encoding="utf-8"))
    required = {"id", "name", "film", "print", "iso", "category", "notes"}
    ids = [stock["id"] for stock in stocks]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate stock ids in tools/stocks.json")
    for stock in stocks:
        missing = required - stock.keys()
        if missing:
            raise ValueError(f"{stock.get('id', '<unknown>')}: missing {sorted(missing)}")
        forbidden = {"calibration", "tone_curve", "post_tone"} & stock.keys()
        if forbidden:
            raise ValueError(f"{stock['id']}: forbidden non-physical keys {sorted(forbidden)}")
    return stocks


def stock_by_id(stock_id: str) -> dict:
    for stock in load_stocks():
        if stock["id"] == stock_id:
            return stock
    raise KeyError(f"Unknown stock id {stock_id!r}")


def _recipe_with_overrides(recipe: dict | None, overrides: dict | None) -> dict:
    result = dict(GLOBAL_RECIPE if recipe is None else recipe)
    if overrides:
        # Accept the baker's historical explicit names without creating a
        # second configuration path.
        aliases = {
            "enlarger_print_exposure_ev": None,
            "enlarger_print_exposure_compensation": "print_exposure_compensation",
            "enlarger_normalize_print_exposure": "normalize_print_exposure",
            "enlarger_illuminant": "illuminant",
            "enlarger_y_filter_shift": "y_filter_shift",
            "enlarger_m_filter_shift": "m_filter_shift",
        }
        unknown = set(overrides) - set(PHYSICAL_RECIPE) - set(result)
        if unknown:
            raise KeyError(f"Unknown physical recipe fields: {sorted(unknown)}")
        for key, value in overrides.items():
            if key == "enlarger_print_exposure_ev":
                result["enlarger_print_exposure"] = 2.0 ** float(value)
            else:
                result[aliases.get(key, key)] = value
    return result


def recipe_config(overrides: dict | None = None) -> dict:
    """Return a complete internal recipe after validated historical aliases."""
    return _recipe_with_overrides(None, overrides)


def physical_recipe(overrides: dict | None = None) -> dict:
    recipe = recipe_config(overrides)
    return {
        "camera_exposure_compensation_ev": recipe["camera_exposure_compensation_ev"],
        "enlarger_print_exposure_ev": math.log2(recipe["enlarger_print_exposure"]),
        "enlarger_print_exposure_compensation": recipe["print_exposure_compensation"],
        "enlarger_normalize_print_exposure": recipe["normalize_print_exposure"],
        "neutral_print_filters_from_database": recipe["neutral_print_filters_from_database"],
        "enlarger_illuminant": recipe["illuminant"],
        "enlarger_y_filter_shift": recipe["y_filter_shift"],
        "enlarger_m_filter_shift": recipe["m_filter_shift"],
        "scanner_white_correction": recipe["scanner_white_correction"],
        "scanner_black_correction": recipe["scanner_black_correction"],
        "scanner_white_level": recipe["scanner_white_level"],
        "scanner_black_level": recipe["scanner_black_level"],
    }


def make_bundle_spec(
    stock: dict,
    resolution: int = LUT_RESOLUTION,
    recipe: dict | None = None,
    stops_above_midgray: float | None = None,
) -> BundleSpec:
    recipe = dict(GLOBAL_RECIPE if recipe is None else recipe)
    stops = recipe["stops_above_midgray"] if stops_above_midgray is None else stops_above_midgray
    return BundleSpec(
        name=f"wx_{stock['id']}",
        film_profile=stock["film"],
        print_profiles=(stock["print"],),
        input_color_space=INPUT_COLOR_SPACE,
        output_color_space=OUTPUT_COLOR_SPACE,
        topology="1lut",
        resolution=resolution,
        stops_above_midgray=float(stops),
        output_gamut_compress=str(recipe["output_gamut_algorithm"]),
        qa=False,
        ocio_config=False,
    )


def make_runtime_params(
    spec: BundleSpec,
    print_profile: str,
    recipe: dict | None = None,
    overrides: dict | None = None,
):
    """Digest once, then restore deterministic physical LUT-compatible knobs.

    `lut_mode` removes spatial, stochastic, and image-global effects, but also
    resets static exposure/scanner controls. The selected physical controls are
    restored after digest and before SimulationPipeline construction. This
    exact object is used by both BundleBuilder and public simulate().
    """
    from spektrafilm_lut_creator.color_spaces import get as get_color_space

    recipe = _recipe_with_overrides(recipe, overrides)
    in_entry = get_color_space(spec.input_color_space)
    out_entry = get_color_space(spec.output_color_space)
    params = init_params(film_profile=spec.film_profile, print_profile=print_profile)
    params.debug.lut_mode = True
    params.io.input_color_space = in_entry.primaries
    params.io.output_color_space = out_entry.primaries
    params.io.input_cctf_decoding = False
    params.io.output_cctf_encoding = False
    params.io.input_gamut_compress = spec.input_gamut_compress
    params.io.output_gamut_compress = spec.output_gamut_compress
    params.io.scan_film = bool(params.film.is_positive)
    params.settings.neutral_print_filters_from_database = bool(
        recipe["neutral_print_filters_from_database"]
    )
    params.enlarger.illuminant = str(recipe["illuminant"])
    params.enlarger.y_filter_shift = float(recipe["y_filter_shift"])
    params.enlarger.m_filter_shift = float(recipe["m_filter_shift"])
    params = digest_params(params)

    params.camera.auto_exposure = False
    params.camera.exposure_compensation_ev = float(recipe["camera_exposure_compensation_ev"])
    params.enlarger.print_exposure = float(recipe["enlarger_print_exposure"])
    params.enlarger.print_exposure_compensation = bool(recipe["print_exposure_compensation"])
    params.enlarger.normalize_print_exposure = bool(recipe["normalize_print_exposure"])
    params.scanner.white_correction = bool(recipe["scanner_white_correction"])
    params.scanner.black_correction = bool(recipe["scanner_black_correction"])
    params.scanner.white_level = float(recipe["scanner_white_level"])
    params.scanner.black_level = float(recipe["scanner_black_level"])
    params.scanner.unsharp_mask = (0.0, 0.0)
    params.io.scan_film = bool(params.film.is_positive)
    return params


def exposure_gain(stops_above_midgray: float | None = STOPS_ABOVE_MIDGRAY) -> float:
    return float(input_exposure_gain(INPUT_COLOR_SPACE, stops_above_midgray))


def decode_srgb_input(image: np.ndarray, recipe: dict | None = None,
                      stops_above_midgray: float | None = None) -> np.ndarray:
    recipe = GLOBAL_RECIPE if recipe is None else recipe
    array = np.asarray(image)
    encoded = array.astype(np.float64) / 255.0 if array.dtype == np.uint8 else array.astype(np.float64)
    stops = recipe["stops_above_midgray"] if stops_above_midgray is None else stops_above_midgray
    return decode_cctf(encoded, INPUT_COLOR_SPACE) * exposure_gain(stops)


def encode_srgb_output(linear: np.ndarray, clip: bool = True) -> np.ndarray:
    encoded = encode_cctf(linear * output_midgray_gain(OUTPUT_COLOR_SPACE), OUTPUT_COLOR_SPACE)
    return np.clip(encoded, 0.0, 1.0) if clip else encoded


def simulate_linear_srgb(
    linear_input: np.ndarray,
    stock: dict,
    resolution: int = LUT_RESOLUTION,
    recipe: dict | None = None,
    stops_above_midgray: float | None = None,
    overrides: dict | None = None,
) -> np.ndarray:
    """Full public simulate() for already-decoded native linear-sRGB input."""
    from spektrafilm import simulate

    recipe = _recipe_with_overrides(recipe, overrides)
    spec = make_bundle_spec(
        stock, resolution=resolution, recipe=recipe,
        stops_above_midgray=stops_above_midgray,
    )
    params = make_runtime_params(spec, stock["print"], recipe)
    linear_output = simulate(
        linear_input, params, digest_params_first=False, print_timings=False,
    )
    return encode_srgb_output(linear_output, clip=False)


def simulate_srgb(
    image: np.ndarray,
    stock: dict,
    resolution: int = LUT_RESOLUTION,
    recipe: dict | None = None,
    stops_above_midgray: float | None = None,
    overrides: dict | None = None,
) -> np.ndarray:
    """Full public simulate(); uint8 or [0,1] float sRGB in, float sRGB out.

    The returned encoded values are deliberately not clipped so callers can
    inspect physical out-of-gamut values. Display/8-bit conversion clips at the
    same boundary as the LUT creator. There is no additional tone operation.
    """
    recipe = _recipe_with_overrides(recipe, overrides)
    spec = make_bundle_spec(
        stock, resolution=resolution, recipe=recipe,
        stops_above_midgray=stops_above_midgray,
    )
    linear_input = decode_srgb_input(image, recipe, spec.stops_above_midgray)
    return simulate_linear_srgb(
        linear_input, stock, resolution=resolution, recipe=recipe,
        stops_above_midgray=spec.stops_above_midgray,
    )


def effective_stock_parameters(stock: dict, recipe: dict | None = None) -> dict:
    recipe = GLOBAL_RECIPE if recipe is None else recipe
    spec = make_bundle_spec(stock, recipe=recipe)
    params = make_runtime_params(spec, stock["print"], recipe)
    return {
        "film": stock["film"], "print": stock["print"],
        "scan_film": bool(params.io.scan_film),
        "camera_auto_exposure": bool(params.camera.auto_exposure),
        "camera_exposure_compensation_ev": float(params.camera.exposure_compensation_ev),
        "input_exposure_gain": exposure_gain(float(recipe["stops_above_midgray"])),
        "enlarger_print_exposure": float(params.enlarger.print_exposure),
        "print_exposure_compensation": bool(params.enlarger.print_exposure_compensation),
        "normalize_print_exposure": bool(params.enlarger.normalize_print_exposure),
        "illuminant": str(params.enlarger.illuminant),
        "neutral_filters_from_database": bool(params.settings.neutral_print_filters_from_database),
        "neutral_cmy_filters": [float(params.enlarger.c_filter_neutral),
                                float(params.enlarger.m_filter_neutral),
                                float(params.enlarger.y_filter_neutral)],
        "y_filter_shift": float(params.enlarger.y_filter_shift),
        "m_filter_shift": float(params.enlarger.m_filter_shift),
        "scanner_white_correction": bool(params.scanner.white_correction),
        "scanner_black_correction": bool(params.scanner.black_correction),
        "scanner_white_level": float(params.scanner.white_level),
        "scanner_black_level": float(params.scanner.black_level),
        "input_gamut_compress": asdict(params.io.input_gamut_compress),
        "output_gamut_compress": asdict(params.io.output_gamut_compress),
    }


def recipe_manifest(recipe: dict | None = None) -> dict:
    recipe = GLOBAL_RECIPE if recipe is None else recipe
    return {
        **recipe,
        "input_color_space": INPUT_COLOR_SPACE,
        "output_color_space": OUTPUT_COLOR_SPACE,
        "input_cctf_decoding_at_boundary": True,
        "output_cctf_encoding_at_boundary": True,
        "input_exposure_gain": exposure_gain(float(recipe["stops_above_midgray"])),
        "grain_halation_diffusion_spatial_stochastic": False,
        "scanner_unsharp_mask": False,
        "positive_stocks": "direct film scan (io.scan_film=True)",
    }


def recipe_snapshot(resolution: int = LUT_RESOLUTION,
                    stops_above_midgray: float = STOPS_ABOVE_MIDGRAY,
                    overrides: dict | None = None) -> dict:
    recipe = _recipe_with_overrides(None, overrides)
    recipe["stops_above_midgray"] = stops_above_midgray
    spec = make_bundle_spec(load_stocks()[0], resolution=resolution, recipe=recipe)
    return {
        **recipe_manifest(recipe),
        "topology": "1lut", "resolution": resolution,
        "stops_above_midgray": stops_above_midgray,
        **physical_recipe(overrides),
        "camera_auto_exposure": False,
        "scan_film": "True for positive profiles, False otherwise",
        "input_gamut_compress": asdict(spec.input_gamut_compress),
        "output_gamut_compress": asdict(spec.output_gamut_compress),
        "spatial_stochastic_effects": False,
    }


def bake_manifest_path() -> Path:
    return BUILD_DIR / "bake_manifest.json"


def read_bake_manifest(path: Path | None = None) -> dict:
    path = path or bake_manifest_path()
    if not path.is_file():
        raise FileNotFoundError(f"Missing {path}; run tools/bake_luts.py first")
    return json.loads(path.read_text(encoding="utf-8"))
