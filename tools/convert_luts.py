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

from lut_manifest import write_manifest
from pipeline_config import (
    BUILD_DIR,
    LUT_COLS,
    LUT_DIR,
    MAX_LUT_DIRECTORY_BYTES,
    MAX_PHASE4_LUT_DIRECTORY_BYTES,
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


def convert_manifest(manifest_path: Path, output_dir: Path, clean: bool = False,
                     extended_manifest_path: Path | None = None,
                     extended_headroom_ev: float = 2.0) -> dict:
    bake = read_bake_manifest(manifest_path)
    records_by_id = {record["id"]: record for record in bake["stocks"]}
    extended_bake = (read_bake_manifest(extended_manifest_path)
                     if extended_manifest_path else None)
    extended_by_id = ({record["id"]: record for record in extended_bake["stocks"]}
                      if extended_bake else {})
    if extended_bake and set(extended_by_id) != set(records_by_id):
        raise ValueError("Base and extended bake manifests must contain identical stock ids")
    if extended_bake and extended_headroom_ev <= 0:
        raise ValueError("extended_headroom_ev must be positive")
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
        item = {
            "id": stock["id"], "name": stock["name"], "iso": stock["iso"],
            "category": stock["category"], "file": output.name,
            "film": stock["film"], "print": stock["print"], **geometry,
        }
        if extended_bake:
            extended_output = output_dir / f"{stock['id']}.ev{extended_headroom_ev:g}.png"
            extended_geometry = cube_to_grid(
                ROOT / extended_by_id[stock["id"]]["cube"], extended_output,
            )
            item["extended"] = {
                "file": extended_output.name,
                "headroomEv": float(extended_headroom_ev),
                **extended_geometry,
            }
        manifest.append(item)
        print(
            f"[convert] N={geometry['size']} {stock['id']}: "
            f"{geometry['width']}x{geometry['height']}, {geometry['bytes']:,} bytes",
            flush=True,
        )
    write_manifest(output_dir, manifest)
    json.loads((output_dir / "luts.json").read_text(encoding="utf-8"))
    total = sum(path.stat().st_size for path in output_dir.iterdir() if path.is_file())
    result = {
        "resolution": int(bake["settings"]["resolution"]),
        "output_dir": str(output_dir),
        "stock_count": len(manifest),
        "png_bytes": sum(
            item["bytes"] + (item.get("extended", {}).get("bytes", 0)) for item in manifest
        ),
        "total_bytes": total,
        "extended_resolution": int(extended_bake["settings"]["resolution"]) if extended_bake else None,
        "extended_headroom_ev": float(extended_headroom_ev) if extended_bake else None,
    }
    print(
        f"[convert] N={result['resolution']} total={total:,} bytes "
        f"({total / 1024:.1f} KiB) -> {output_dir}", flush=True,
    )
    size_limit = MAX_PHASE4_LUT_DIRECTORY_BYTES if extended_bake else MAX_LUT_DIRECTORY_BYTES
    if output_dir.resolve() == LUT_DIR.resolve() and total >= size_limit:
        raise RuntimeError(
            f"LUT directory is {total:,} bytes; limit is {size_limit:,}"
        )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=BUILD_DIR / "bake_manifest.json")
    parser.add_argument("--output-dir", type=Path, default=LUT_DIR)
    parser.add_argument("--clean", action="store_true")
    parser.add_argument(
        "--extended-manifest", type=Path, default=None,
        help="Optional +headroom EV0 bake; adds one nested extended LUT per stock",
    )
    parser.add_argument("--extended-headroom-ev", type=float, default=2.0)
    args = parser.parse_args()
    convert_manifest(
        args.manifest.resolve(), args.output_dir.resolve(), clean=args.clean,
        extended_manifest_path=(args.extended_manifest.resolve() if args.extended_manifest else None),
        extended_headroom_ev=args.extended_headroom_ev,
    )


if __name__ == "__main__":
    main()
