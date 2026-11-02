#!/usr/bin/env python3
"""Static Mini Program and package-size checks that require no AppID."""
from __future__ import annotations

import json
import re
import struct
from pathlib import Path

from embed_shaders import DESTINATION as SHADER_DESTINATION
from embed_shaders import generate as generate_shaders

ROOT = Path(__file__).resolve().parents[1]
MAIN_PACKAGE_LIMIT = 2 * 1024 * 1024
NODE_BUILTINS = {
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
    "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
    "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
    "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "timers",
    "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
}
REQUIRE_PATTERN = re.compile(r"\brequire\s*\(\s*['\"]([^'\"]+)['\"]\s*\)")
EXCLUDED_WALK_DIRS = {".git", "node_modules", "build", "__pycache__"}


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def source_json_files() -> list[Path]:
    result = []
    for path in ROOT.rglob("*.json"):
        relative = path.relative_to(ROOT)
        if any(part in EXCLUDED_WALK_DIRS for part in relative.parts):
            continue
        if relative.parts[:2] == ("harness", "out"):
            continue
        result.append(path)
    return sorted(result)


def page_entries(app: dict) -> list[str]:
    entries = list(app.get("pages", []))
    for package in app.get("subpackages", app.get("subPackages", [])):
        root = package["root"].rstrip("/")
        entries.extend(f"{root}/{page}" for page in package.get("pages", []))
    return entries


def package_ignores(project: dict) -> tuple[set[str], set[str]]:
    folders = set()
    files = set()
    for item in project.get("packOptions", {}).get("ignore", []):
        value = item.get("value", "").strip("/")
        if item.get("type") == "folder":
            folders.add(value)
        elif item.get("type") == "file":
            files.add(value)
    return folders, files


def is_ignored(relative: Path, folders: set[str], files: set[str]) -> bool:
    name = relative.as_posix()
    if name in files or any(part == "node_modules" for part in relative.parts):
        return True
    return any(name == folder or name.startswith(f"{folder}/") for folder in folders)


def package_files(root: Path, ignored_folders=set(), ignored_files=set()) -> list[Path]:
    files = []
    if not root.exists():
        return files
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT)
        if ".git" in relative.parts or "__pycache__" in relative.parts:
            continue
        if root == ROOT and is_ignored(relative, ignored_folders, ignored_files):
            continue
        files.append(path)
    return sorted(files)


def check_png_geometry(manifest: list[dict], package_root: Path, errors: list[str]) -> None:
    for stock in manifest:
        path = package_root / stock["file"]
        try:
            with path.open("rb") as stream:
                header = stream.read(26)
            if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
                raise ValueError("not a PNG")
            width, height = struct.unpack(">II", header[16:24])
            expected = (stock["cols"] * stock["size"], stock["rows"] * stock["size"])
            if (width, height) != expected:
                raise ValueError(f"dimensions {width}x{height}, expected {expected[0]}x{expected[1]}")
            if header[24] != 8 or header[25] != 2:
                raise ValueError("expected 8-bit RGB PNG (colour type 2)")
        except (OSError, ValueError, KeyError, struct.error) as error:
            errors.append(f"Invalid LUT {path.relative_to(ROOT)}: {error}")


def main() -> int:
    errors = []
    json_files = source_json_files()
    for path in json_files:
        try:
            load_json(path)
        except (OSError, json.JSONDecodeError) as error:
            errors.append(f"JSON {path.relative_to(ROOT)}: {error}")
    try:
        app = load_json(ROOT / "app.json")
        project = load_json(ROOT / "project.config.json")
    except (OSError, json.JSONDecodeError) as error:
        print(f"Cannot continue: {error}")
        return 1

    packages = app.get("subpackages", app.get("subPackages", []))
    for package in packages:
        if not isinstance(package.get("pages"), list) or not package["pages"]:
            errors.append(f"Subpackage {package.get('root', '?')} must declare a nonempty pages list")

    # page_entries() prefixes each subpackage page with its root before these
    # existence checks, so both main-package and subpackage pages are covered.
    pages = page_entries(app)
    for entry in pages:
        for extension in ("js", "json", "wxml", "wxss"):
            path = ROOT / f"{entry}.{extension}"
            if not path.is_file():
                errors.append(f"Missing page file: {path.relative_to(ROOT)}")

    runtime_files = [ROOT / "app.js"]
    for directory in ("pages", "utils", "renderer"):
        runtime_files.extend((ROOT / directory).rglob("*.js"))
    for package in app.get("subpackages", app.get("subPackages", [])):
        runtime_files.extend((ROOT / package["root"]).rglob("*.js"))
    for path in runtime_files:
        if not path.is_file():
            continue
        for imported in REQUIRE_PATTERN.findall(path.read_text(encoding="utf-8")):
            normalized = imported.removeprefix("node:").split("/")[0]
            if imported.startswith("node:") or normalized in NODE_BUILTINS:
                errors.append(f"Node builtin require '{imported}' in {path.relative_to(ROOT)}")

    if not SHADER_DESTINATION.exists() or SHADER_DESTINATION.read_text(encoding="utf-8") != generate_shaders():
        errors.append("utils/shaders.js is stale; run python3 tools/embed_shaders.py")

    ignored_folders, ignored_files = package_ignores(project)
    for package in app.get("subpackages", app.get("subPackages", [])):
        root = package["root"].strip("/")
        ignored_folders.add(root)
    main_files = package_files(ROOT, ignored_folders, ignored_files)
    main_size = sum(path.stat().st_size for path in main_files)
    if main_size >= MAIN_PACKAGE_LIMIT:
        errors.append(f"Main package is {main_size} bytes; limit is < {MAIN_PACKAGE_LIMIT}")

    lut_sizes = {}
    for package in app.get("subpackages", app.get("subPackages", [])):
        root = ROOT / package["root"]
        size = sum(path.stat().st_size for path in package_files(root))
        lut_sizes[package.get("name", package["root"])] = size
        if package.get("name") == "luts":
            try:
                manifest = load_json(root / "luts.json")
                check_png_geometry(manifest, root, errors)
            except (OSError, json.JSONDecodeError) as error:
                errors.append(f"LUT manifest: {error}")

    print(f"JSON files parsed: {len(json_files)}")
    print(f"Page entries checked: {len(pages)}")
    print(f"Main package: {main_size} bytes ({main_size / 1024:.1f} KiB), {len(main_files)} files")
    for name, size in lut_sizes.items():
        print(f"Subpackage {name}: {size} bytes ({size / 1024:.1f} KiB)")
    print("Shader embedding: current" if not errors else "Shader embedding: see errors")
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        print("Static checks: FAIL")
        return 1
    print("Static checks: PASS (miniprogram-ci intentionally skipped: requires AppID/private key)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
