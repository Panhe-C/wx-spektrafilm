"""Deterministic sRGB validation fixtures; sizeable files stay in build/."""
from __future__ import annotations

from pathlib import Path

import colour
import numpy as np
from PIL import Image

from pipeline_config import BUILD_DIR, SPEKTRAFILM_ROOT, TESTPHOTO_ROOT

FIXTURE_DIR = BUILD_DIR / "validation"
PORTRAIT_SOURCE = SPEKTRAFILM_ROOT / "img" / "test" / "portrait_leaves_32bit_linear_prophoto_rgb.tif"
CHART_SOURCE = SPEKTRAFILM_ROOT / "img" / "targets" / "it87_test_chart_2.jpg"
PHONE_PHOTOS = (
    ("p1015", "landscape/sky"), ("p1025", "forest/pug"),
    ("p1043", "Yosemite"), ("p1062", "indoors/high-key"),
    ("p237", "black dog/wood"), ("p433", "bear"),
)
PHONE_IDS = tuple(photo_id for photo_id, _ in PHONE_PHOTOS)
PHONE_SUBJECTS = dict(PHONE_PHOTOS)
_COLORCHECKER_SRGB = np.array([
    [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67],
    [133, 128, 177], [103, 189, 170], [214, 126, 44], [80, 91, 166],
    [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
    [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31],
    [187, 86, 149], [8, 133, 161], [243, 243, 242], [200, 200, 200],
    [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
], dtype=np.uint8)


def downscale_to_pixels(image: Image.Image, max_pixels: int = 1_200_000) -> Image.Image:
    width, height = image.size
    if width * height <= max_pixels:
        return image.copy()
    scale = (max_pixels / (width * height)) ** 0.5
    size = [max(1, int(width * scale)), max(1, int(height * scale))]
    while size[0] * size[1] > max_pixels:
        if size[0] / width >= size[1] / height:
            size[0] -= 1
        else:
            size[1] -= 1
    return image.resize(tuple(size), Image.Resampling.LANCZOS)


def _save_jpeg(image: Image.Image, path: Path) -> None:
    image.save(path, format="JPEG", quality=95, subsampling=0, optimize=True)


def make_portrait(path: Path, exposure_ev: float = 0.0, max_pixels: int = 1_200_000) -> None:
    from spektrafilm.utils.io import load_image_oiio
    linear_prophoto = load_image_oiio(str(PORTRAIT_SOURCE))
    linear_srgb = colour.RGB_to_RGB(
        linear_prophoto, "ProPhoto RGB", "sRGB",
        apply_cctf_decoding=False, apply_cctf_encoding=False,
    )
    if exposure_ev:
        linear_srgb = linear_srgb * (2.0 ** exposure_ev)
    encoded = colour.cctf_encoding(np.clip(linear_srgb, 0.0, 1.0), function="sRGB")
    pixels = np.rint(np.clip(encoded, 0.0, 1.0) * 255.0).astype(np.uint8)
    _save_jpeg(downscale_to_pixels(Image.fromarray(pixels, mode="RGB"), max_pixels), path)


def _make_chart(path: Path, max_pixels: int = 1_200_000) -> None:
    with Image.open(CHART_SOURCE) as source:
        image = source.convert("RGB")
        image.thumbnail((450, 450), Image.Resampling.LANCZOS)
        _save_jpeg(downscale_to_pixels(image, max_pixels), path)


def _make_synthetic(path: Path, width: int = 768, height: int = 512) -> None:
    pixels = np.zeros((height, width, 3), dtype=np.uint8)
    patch_height = height // 2
    for index, color in enumerate(_COLORCHECKER_SRGB):
        row, column = divmod(index, 6)
        y0, y1 = round(row * patch_height / 4), round((row + 1) * patch_height / 4)
        x0, x1 = round(column * width / 6), round((column + 1) * width / 6)
        shade = np.linspace(0.82, 1.0, y1 - y0, dtype=np.float32)[:, None, None]
        pixels[y0:y1, x0:x1] = np.clip(color[None, None, :] * shade, 0, 255).astype(np.uint8)
    endpoints = np.array([
        [[0, 0, 0], [255, 255, 255]], [[255, 0, 0], [0, 255, 0]],
        [[0, 255, 0], [0, 0, 255]], [[0, 0, 255], [255, 0, 255]],
    ], dtype=np.float32)
    t = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :, None]
    remaining = height - patch_height
    for band in range(4):
        y0 = patch_height + round(band * remaining / 4)
        y1 = patch_height + round((band + 1) * remaining / 4)
        ramp = endpoints[band, 0][None, None, :] * (1.0 - t) + endpoints[band, 1][None, None, :] * t
        vertical = np.linspace(0.70, 1.0, y1 - y0, dtype=np.float32)[:, None, None]
        pixels[y0:y1] = np.rint(ramp * vertical).astype(np.uint8)
    Image.fromarray(pixels, mode="RGB").save(path, format="PNG", optimize=True)


def prepare_phone_fixtures(directory: Path | None = None,
                           max_pixels: int = 1_200_000) -> list[dict]:
    directory = FIXTURE_DIR if directory is None else Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    fixtures = []
    for photo_id, description in PHONE_PHOTOS:
        source_path = TESTPHOTO_ROOT / f"{photo_id}.jpg"
        if not source_path.is_file():
            raise FileNotFoundError(f"Required on-box phone photo is missing: {source_path}")
        path = directory / f"{photo_id}.jpg"
        with Image.open(source_path) as source:
            image = downscale_to_pixels(source.convert("RGB"), max_pixels=max_pixels)
        _save_jpeg(image, path)
        fixtures.append({
            "id": f"phone_{photo_id}", "label": f"{photo_id} ({description})",
            "kind": "phone", "description": description, "path": path,
            "natural": True, "width": image.width, "height": image.height,
            "source": str(source_path),
        })
    return fixtures


def prepare_fixtures(max_pixels: int = 1_200_000) -> list[dict]:
    """Create six phone photos plus portrait, IT8 chart, and synthetic target."""
    fixtures = prepare_phone_fixtures(max_pixels=max_pixels)
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    portrait_path = FIXTURE_DIR / "portrait.jpg"
    make_portrait(portrait_path, max_pixels=max_pixels)
    chart_path = FIXTURE_DIR / "chart.jpg"
    _make_chart(chart_path, max_pixels)
    synthetic_path = FIXTURE_DIR / "synthetic.png"
    _make_synthetic(synthetic_path)
    for fixture_id, kind, path, natural, description in (
        ("portrait", "portrait", portrait_path, True, "ProPhoto-linear portrait converted to sRGB JPEG"),
        ("chart", "chart", chart_path, False, "IT8.7 test chart"),
        ("synthetic", "synthetic", synthetic_path, False, "24-patch-like colours and encoded-RGB gradients"),
    ):
        with Image.open(path) as image:
            size = image.size
        fixtures.append({"id": fixture_id, "label": description, "kind": kind,
                         "description": description, "path": path, "natural": natural,
                         "width": size[0], "height": size[1]})
    return fixtures


def load_fixture(fixture: dict) -> np.ndarray:
    with Image.open(fixture["path"]) as image:
        return np.asarray(image.convert("RGB"), dtype=np.uint8)
