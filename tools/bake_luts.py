#!/usr/bin/env python3
"""Bake physical phone-photo LUT cubes with the spektrafilm-lut API."""
from __future__ import annotations

import argparse
import gc
import json
from pathlib import Path
from time import perf_counter

import numpy as np
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm_lut_creator.builders import BundleBuilder
from spektrafilm_lut_creator.formats import Lut

from pipeline_config import (
    BUILD_DIR,
    LUT_RESOLUTION,
    ROOT,
    STOPS_ABOVE_MIDGRAY,
    bake_manifest_path,
    load_stocks,
    make_bundle_spec,
    make_runtime_params,
    recipe_snapshot,
)


def _range_stats(encoded: np.ndarray, linear: np.ndarray) -> dict:
    encoded = np.asarray(encoded, dtype=np.float64)
    linear = np.asarray(linear, dtype=np.float64)
    outside = (encoded < 0.0) | (encoded > 1.0)
    linear_outside = (linear < 0.0) | (linear > 1.0)
    return {
        "nodes": int(encoded.shape[0] * encoded.shape[1] * encoded.shape[2]),
        "encoded_nodes_with_any_channel_outside_percent": float(
            np.mean(np.any(outside, axis=-1)) * 100.0
        ),
        "encoded_channel_samples_outside_percent": float(np.mean(outside) * 100.0),
        "encoded_channel_samples_below_zero_percent": float(
            np.mean(encoded < 0.0) * 100.0
        ),
        "encoded_channel_samples_above_one_percent": float(
            np.mean(encoded > 1.0) * 100.0
        ),
        "encoded_min": float(np.min(encoded)),
        "encoded_max": float(np.max(encoded)),
        "linear_channel_samples_outside_percent": float(
            np.mean(linear_outside) * 100.0
        ),
        "linear_min": float(np.min(linear)),
        "linear_max": float(np.max(linear)),
    }


class StockBundleBuilder(BundleBuilder):
    """Use the shared physical recipe and retain pre-clip edge diagnostics."""

    def __init__(self, spec):
        super().__init__(spec)
        self.edge_stats: dict[str, dict] = {}

    def _make_pipeline(self, spec, in_entry, out_entry, print_stock):
        return SimulationPipeline(make_runtime_params(spec, print_stock))

    def _bake_sublut(
        self, pipeline, spec, inject_tap, collect_tap,
        wires, rel_path, title,
    ):
        # Phase 1c uses only the combined rgb_in -> rgb_out recipe. Keeping
        # this small override lets us measure values before BundleBuilder's
        # required [0,1] cube clamp without forking the rest of its writer.
        if (inject_tap, collect_tap) != ("rgb_in", "rgb_out"):
            return super()._bake_sublut(
                pipeline, spec, inject_tap, collect_tap, wires, rel_path, title,
            )
        n = spec.resolution
        image = self._make_inject_image(n, inject_tap, wires, spec)
        raw_out = pipeline.process(image, inject=inject_tap, collect=collect_tap)
        code = self._encode_at_tap(raw_out, collect_tap, wires, spec)
        self.edge_stats[rel_path] = _range_stats(code, raw_out)
        table = np.clip(code, 0.0, 1.0).reshape(n, n, n, 3)
        return rel_path, Lut(table=table, title=title)


def _relative_or_absolute(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def bake_stock(stock: dict, resolution: int, stops: float, out_root: Path) -> dict:
    spec = make_bundle_spec(stock, resolution=resolution, stops_above_midgray=stops)
    params = make_runtime_params(spec, stock["print"])
    stock_parameters = {
        "scan_film": bool(params.io.scan_film),
        "camera_exposure_compensation_ev": float(params.camera.exposure_compensation_ev),
        "enlarger_print_exposure": float(params.enlarger.print_exposure),
        "enlarger_print_exposure_compensation": bool(
            params.enlarger.print_exposure_compensation
        ),
        "enlarger_normalize_print_exposure": bool(
            params.enlarger.normalize_print_exposure
        ),
        "enlarger_illuminant": str(params.enlarger.illuminant),
        "neutral_cmy_filters": [
            float(params.enlarger.c_filter_neutral),
            float(params.enlarger.m_filter_neutral),
            float(params.enlarger.y_filter_neutral),
        ],
        "scanner_white_correction": bool(params.scanner.white_correction),
        "scanner_black_correction": bool(params.scanner.black_correction),
        "scanner_white_level": float(params.scanner.white_level),
        "scanner_black_level": float(params.scanner.black_level),
        "output_gamut_algorithm": str(params.io.output_gamut_compress.algorithm),
    }
    del params

    builder = StockBundleBuilder(spec)
    out_dir = out_root / stock["id"]
    started = perf_counter()
    bundle = builder.build()
    written = builder.write(bundle, out_dir=out_dir)
    elapsed = perf_counter() - started
    cubes = sorted(written.glob("*.cube"))
    if len(cubes) != 1:
        raise RuntimeError(f"{stock['id']}: expected one cube, found {len(cubes)}")
    edge = builder.edge_stats.get(cubes[0].name)
    if edge is None:
        # Writer paths and builder paths share the canonical cube filename.
        edge = next(iter(builder.edge_stats.values()))
    record = {
        "id": stock["id"],
        "film": stock["film"],
        "print": stock["print"],
        "resolution": resolution,
        "cube": _relative_or_absolute(cubes[0]),
        "bundle": _relative_or_absolute(written),
        "seconds": round(elapsed, 3),
        "parameters": stock_parameters,
        "preclip_edge": edge,
    }
    print(
        f"[timing] {stock['id']}: {elapsed:.2f}s -> {_relative_or_absolute(cubes[0])}; "
        f"preclip nodes outside={edge['encoded_nodes_with_any_channel_outside_percent']:.5f}%",
        flush=True,
    )
    del bundle, builder
    gc.collect()
    return record


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resolution", type=int, default=LUT_RESOLUTION)
    parser.add_argument("--stops-above-midgray", type=float, default=STOPS_ABOVE_MIDGRAY)
    parser.add_argument("--stock", action="append", dest="stock_ids")
    parser.add_argument(
        "--output-dir", type=Path, default=BUILD_DIR / "luts",
        help="Per-stock bundle parent (default: build/luts)",
    )
    parser.add_argument("--manifest", type=Path, default=None)
    args = parser.parse_args()
    if args.resolution < 2:
        parser.error("--resolution must be at least 2")

    stocks = load_stocks()
    if args.stock_ids:
        requested = set(args.stock_ids)
        unknown = requested - {stock["id"] for stock in stocks}
        if unknown:
            parser.error(f"unknown stock ids: {', '.join(sorted(unknown))}")
        stocks = [stock for stock in stocks if stock["id"] in requested]

    out_root = args.output_dir.resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    records = []
    total_started = perf_counter()
    settings = recipe_snapshot(
        resolution=args.resolution,
        stops_above_midgray=args.stops_above_midgray,
    )
    print(
        f"Baking {len(stocks)} stocks: sRGB -> sRGB, 1lut {args.resolution}^3, "
        f"stops={args.stops_above_midgray:.12f}, gain={settings['input_exposure_gain']:.6f}, "
        f"camera EV={settings['camera_exposure_compensation_ev']:+.7f}, "
        f"scanner W/B={settings['scanner_white_correction']}/{settings['scanner_black_correction']}",
        flush=True,
    )
    for stock in stocks:
        records.append(bake_stock(stock, args.resolution, args.stops_above_midgray, out_root))

    manifest = {
        "settings": settings,
        "stocks": records,
        "total_seconds": round(perf_counter() - total_started, 3),
    }
    path = (args.manifest or bake_manifest_path()).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"[done] {len(records)} stocks in {manifest['total_seconds']:.2f}s; wrote {path}")


if __name__ == "__main__":
    main()
