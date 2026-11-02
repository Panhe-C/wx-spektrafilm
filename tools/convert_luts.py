#!/usr/bin/env python3
"""Convert baked Adobe cubes to compact 8-column tiled-grid RGB PNGs."""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image
from spektrafilm_lut_creator.formats import get_format

from pipeline_config import (
    BUILD_DIR,
    LUT_COLS,
    LUT_DIR,
    MAX_LUT_DIRECTORY_BYTES,
    MAX_TEXTURE_SIDE,
    ROOT,
    load_stocks,
    read_bake_manifest,
)


def cube_to_grid(cube_path: Path, output_path: Path, cols: int = LUT_COLS) -> dict:
    lut = get_format("cube").read(cube_path)
    n = lut.resolution
    table = np.asarray(lut.table, dtype=np.float64)
    if table.shape != (n, n, n, 3):
        raise ValueError(f"{cube_path}: unexpected cube shape {table.shape}")
    rows = (n + cols - 1) // cols
    width, height = cols * n, rows * n
    if max(width, height) > MAX_TEXTURE_SIDE:
        raise RuntimeError(f"{output_path}: {width}x{height} exceeds {MAX_TEXTURE_SIDE}")

    quantized = np.rint(np.clip(table, 0.0, 1.0) * 255.0).astype(np.uint8)
    grid = np.zeros((height, width, 3), dtype=np.uint8)
    for b in range(n):
        row, column = divmod(b, cols)
        grid[row*n:(row+1)*n, column*n:(column+1)*n] = quantized[b]
    Image.fromarray(grid, mode="RGB").save(output_path, format="PNG", optimize=True)
    _assert_no_color_chunks(output_path)

    with Image.open(output_path) as check:
        if check.mode != "RGB" or check.size != (width, height):
            raise RuntimeError(f"{output_path}: invalid grid {check.mode} {check.size}")
        actual = np.asarray(check)
    for b in range(n):
        row, column = divmod(b, cols)
        tile = actual[row*n:(row+1)*n, column*n:(column+1)*n]
        if not np.array_equal(tile, quantized[b]):
            raise RuntimeError(f"{output_path}: blue slice {b} failed round-trip verification")
    return {
        "size": n, "cols": cols, "rows": rows,
        "width": width, "height": height, "bytes": output_path.stat().st_size,
    }


def _assert_no_color_chunks(path: Path) -> None:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError(f"{path}: not a PNG")
    offset = 8
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        chunk_type = data[offset + 4:offset + 8]
        if chunk_type in {b"gAMA", b"iCCP"}:
            raise RuntimeError(f"{path}: forbidden PNG chunk {chunk_type.decode()}")
        offset += 12 + length
        if chunk_type == b"IEND":
            return
    raise RuntimeError(f"{path}: incomplete PNG")


def convert_manifest(manifest_path: Path, output_dir: Path, clean: bool = False) -> dict:
    bake = read_bake_manifest(manifest_path)
    records_by_id = {record["id"]: record for record in bake["stocks"]}
    stocks = [stock for stock in load_stocks() if stock["id"] in records_by_id]
    if not stocks:
        raise RuntimeError("Bake manifest contains no configured stocks")
    output_dir.mkdir(parents=True, exist_ok=True)
    if clean:
        for old in output_dir.glob("*.png"):
            old.unlink()

    manifest = []
    for stock in stocks:
        record = records_by_id[stock["id"]]
        output = output_dir / f"{stock['id']}.png"
        geometry = cube_to_grid(ROOT / record["cube"], output)
        manifest.append({
            "id": stock["id"], "name": stock["name"], "iso": stock["iso"],
            "category": stock["category"], "file": output.name,
            "film": stock["film"], "print": stock["print"], **geometry,
        })
        print(
            f"[convert] N={geometry['size']} {stock['id']}: "
            f"{geometry['width']}x{geometry['height']}, {geometry['bytes']:,} bytes",
            flush=True,
        )
    manifest_path_out = output_dir / "luts.json"
    manifest_path_out.write_text(
        json.dumps(manifest, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    json.loads(manifest_path_out.read_text(encoding="utf-8"))
    total = sum(path.stat().st_size for path in output_dir.iterdir() if path.is_file())
    result = {
        "resolution": int(bake["settings"]["resolution"]),
        "output_dir": str(output_dir),
        "stock_count": len(manifest),
        "png_bytes": sum(item["bytes"] for item in manifest),
        "total_bytes": total,
    }
    print(
        f"[convert] N={result['resolution']} total={total:,} bytes "
        f"({total / 1024:.1f} KiB) -> {output_dir}", flush=True,
    )
    if output_dir.resolve() == LUT_DIR.resolve() and total >= MAX_LUT_DIRECTORY_BYTES:
        raise RuntimeError(
            f"LUT subpackage is {total:,} bytes; limit is {MAX_LUT_DIRECTORY_BYTES:,}"
        )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=BUILD_DIR / "bake_manifest.json")
    parser.add_argument("--output-dir", type=Path, default=LUT_DIR)
    parser.add_argument("--clean", action="store_true")
    args = parser.parse_args()
    convert_manifest(args.manifest.resolve(), args.output_dir.resolve(), clean=args.clean)


if __name__ == "__main__":
    main()
