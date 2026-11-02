#!/usr/bin/env python3

"""Create physical-vs-LUT triplets and an all-stocks phone-photo sheet."""
from __future__ import annotations

import gc
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from skimage.color import deltaE_ciede2000, rgb2lab

from image_fixtures import prepare_fixtures
from lut_apply import apply_strip_lut
from pipeline_config import LUT_DIR, ROOT, load_stocks, simulate_srgb

TRIPLET_OUTPUT = ROOT / "docs" / "lut-preview.jpg"
ALL_OUTPUT = ROOT / "docs" / "lut-all-stocks.jpg"
MAX_OUTPUT_BYTES = 800_000
PREVIEW_STOCKS = ("portra400", "ektar100", "velvia100")
PREVIEW_PHOTOS = ("p1025", "p1043")


def _font(size: int):
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    ):
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            pass
    return ImageFont.load_default()


def _load_sources() -> dict[str, np.ndarray]:
    fixtures = prepare_fixtures()
    sources = {}
    for photo_id in PREVIEW_PHOTOS:
        fixture = next(item for item in fixtures if item["id"] == f"phone_{photo_id}")
        with Image.open(fixture["path"]) as image:
            resized = image.convert("RGB").resize((400, 267), Image.Resampling.LANCZOS)
            sources[photo_id] = np.asarray(resized, dtype=np.uint8)
    return sources


def _tile(array: np.ndarray, title: str, width: int, height: int,
          label_height: int = 36) -> Image.Image:
    image = Image.fromarray(array, mode="RGB").resize((width, height), Image.Resampling.LANCZOS)
    tile = Image.new("RGB", (width, height + label_height), (20, 20, 23))
    tile.paste(image, (0, 0))
    draw = ImageDraw.Draw(tile)
    draw.text((7, height + 8), title, fill=(245, 245, 245), font=_font(15))
    return tile


def _save_bounded(sheet: Image.Image, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    for quality in (88, 84, 80, 76, 72, 68, 64):
        sheet.save(path, format="JPEG", quality=quality, subsampling=0, optimize=True)
        if path.stat().st_size < MAX_OUTPUT_BYTES:
            print(f"[contact] {path.name}: {sheet.width}x{sheet.height}, "
                  f"{path.stat().st_size:,} bytes, quality={quality}", flush=True)
            return quality
    raise RuntimeError(f"Could not keep {path} below {MAX_OUTPUT_BYTES} bytes")


def _difference_stats(reference: np.ndarray, applied: np.ndarray) -> dict:
    absolute = np.abs(reference - applied.astype(np.float64))
    de = deltaE_ciede2000(rgb2lab(np.clip(reference / 255.0, 0, 1)),
                          rgb2lab(applied.astype(np.float64) / 255.0))
    return {
        "mae8": float(np.mean(absolute)),
        "p95_abs8": float(np.percentile(absolute, 95)),
        "max_abs8": float(np.max(absolute)),
        "mean_dE2000": float(np.mean(de)),
        "channel_mae8": np.mean(absolute, axis=(0, 1)).tolist(),
    }


def make_triplets(stocks: list[dict], sources: dict[str, np.ndarray]) -> None:
    tile_width, tile_height = 400, 267
    image_label, stats_height = 34, 34
    row_height = tile_height + image_label + stats_height
    rows = len(PREVIEW_STOCKS) * len(PREVIEW_PHOTOS)
    sheet = Image.new("RGB", (3 * tile_width, rows * row_height), (20, 20, 23))
    draw = ImageDraw.Draw(sheet)
    row = 0
    all_stats = []
    for photo_id in PREVIEW_PHOTOS:
        source = sources[photo_id]
        for stock_id in PREVIEW_STOCKS:
            stock = next(item for item in stocks if item["id"] == stock_id)
            print(f"[contact] triplet {photo_id} / {stock_id}: full simulate", flush=True)
            full = simulate_srgb(source.astype(np.float64) / 255.0, stock)
            full8 = np.rint(np.clip(full, 0.0, 1.0) * 255.0).astype(np.uint8)
            lut = apply_strip_lut(source, LUT_DIR / f"{stock_id}.png")
            stats = _difference_stats(full8.astype(np.float64), lut)
            stats.update({"photo": photo_id, "stock": stock_id})
            all_stats.append(stats)
            y = row * row_height
            tiles = (
                _tile(source, f"{photo_id} | ORIGINAL", tile_width, tile_height, image_label),
                _tile(full8, f"{stock['name']} | FULL PHYSICAL", tile_width, tile_height, image_label),
                _tile(lut, f"{stock['name']} | LUT", tile_width, tile_height, image_label),
            )
            for column, tile in enumerate(tiles):
                sheet.paste(tile, (column * tile_width, y))
            text = (
                f"FULL vs LUT absolute: mean {stats['mae8']:.3f}, p95 {stats['p95_abs8']:.3f}, "
                f"max {stats['max_abs8']:.1f} codes; mean dE2000 {stats['mean_dE2000']:.4f}; "
                f"RGB MAE {stats['channel_mae8'][0]:.3f}/{stats['channel_mae8'][1]:.3f}/{stats['channel_mae8'][2]:.3f}"
            )
            draw.text((8, y + tile_height + image_label + 8), text,
                      fill=(220, 220, 225), font=_font(14))
            row += 1
            del full, full8, lut
            gc.collect()
    _save_bounded(sheet, TRIPLET_OUTPUT)
    (ROOT / "build" / "contact-difference-stats.json").write_text(
        json.dumps(all_stats, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )


def make_all_stocks(stocks: list[dict], source: np.ndarray) -> None:
    width, height, label = 360, 240, 36
    columns = 4
    count = len(stocks) + 1
    rows = math.ceil(count / columns)
    sheet = Image.new("RGB", (columns * width, rows * (height + label)), (20, 20, 23))
    tiles = [_tile(source, "p1025 | ORIGINAL (normal exposure)", width, height, label)]
    applied = []
    for stock in stocks:
        output = apply_strip_lut(source, LUT_DIR / f"{stock['id']}.png")
        if float(output.mean()) < 2.0 or float(output.std()) < 2.0:
            raise RuntimeError(f"{stock['id']}: black or flat all-stocks preview")
        applied.append(output)
        tiles.append(_tile(output, stock["name"], width, height, label))
    distances = [
        float(np.mean(np.abs(applied[a].astype(np.float32) - applied[b].astype(np.float32))))
        for a in range(len(applied)) for b in range(a + 1, len(applied))
    ]
    if distances and min(distances) < 0.05:
        raise RuntimeError("Two stock previews are effectively identical")
    for index, tile in enumerate(tiles):
        sheet.paste(tile, ((index % columns) * width, (index // columns) * (height + label)))
    _save_bounded(sheet, ALL_OUTPUT)
    print(f"[contact] all-stocks minimum pairwise MAE8={min(distances):.3f}", flush=True)


def main() -> None:
    stocks = load_stocks()
    manifest = json.loads((LUT_DIR / "luts.json").read_text(encoding="utf-8"))
    if len(manifest) != len(stocks):
        raise RuntimeError("Final LUT manifest does not contain all configured stocks")
    sources = _load_sources()
    make_triplets(stocks, sources)
    make_all_stocks(stocks, sources["p1025"])


if __name__ == "__main__":
    main()
