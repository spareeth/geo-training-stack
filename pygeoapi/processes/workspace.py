"""Shared workspace between this server's processes and GeoLibre's own tools.

GeoLibre's Processing menu (Whitebox Toolbox, GeoLibre Toolbox) runs on the GeoLibre container's
Python sidecar when "Run locally (WASM)" is off. That sidecar reads and writes files under its /data
folder only. The "workspace" volume is mounted there, here at /workspace, read-only in TiTiler, and
served by Caddy at /workspace/ for downloads, so:

  prepare  copies a raster (catalogue ref, URL or result), clipped to an area, into the workspace as
           a COG and returns the path to type in GeoLibre's tools (/data/<name>.tif)
  list     shows workspace files (inputs prepared here and outputs GeoLibre's tools wrote), with the
           path this server and TiTiler read them by (/workspace/<name>)
"""
import os
import re
import tempfile
import time

import rasterio
import rasterio.shutil
from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError
from rasterio.warp import transform_bounds
from rasterio.windows import Window, from_bounds

from .common import load_aoi
from .zonal_stats import resolve_raster

WORKSPACE = os.environ.get("WORKSPACE_DIR", "/workspace")
GEOLIBRE_ROOT = "/data"  # the same folder as seen by GeoLibre's sidecar
MAX_PIXELS = int(os.environ.get("WORKSPACE_MAX_PIXELS", str(60_000_000)))
SUFFIXES = (".tif", ".tiff", ".geojson", ".gpkg", ".shp", ".csv", ".json", ".txt", ".html", ".fgb", ".parquet")

PROCESS_METADATA = {
    "version": "0.1.0", "id": "workspace", "title": "Workspace for GeoLibre tools",
    "description": "Prepare rasters for GeoLibre's own Processing tools (run on the server) and list "
                   "the files they produce.",
    "jobControlOptions": ["sync-execute"],
    "keywords": ["workspace", "geolibre", "whitebox"],
    "inputs": {
        "action": {"title": "list or prepare", "schema": {"type": "string", "enum": ["list", "prepare"]}},
        "raster": {"title": "prepare: raster ref, URL or path", "schema": {"type": "string"}, "minOccurs": 0},
        "aoi": {"title": "prepare: area to clip to", "schema": {"oneOf": [{"type": "array"}, {"type": "object"}]},
                "minOccurs": 0},
        "name": {"title": "prepare: file name (letters, digits, - and _)", "schema": {"type": "string"}, "minOccurs": 0},
        "band": {"title": "prepare: band (default: all)", "schema": {"type": "integer"}, "minOccurs": 0},
    },
    "outputs": {"result": {"title": "Result", "schema": {"type": "object"}}},
}


def safe_name(name: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", (name or "").strip()).strip("-_").lower()[:60]
    return stem or f"raster-{int(time.time())}"


def list_files() -> dict:
    files = []
    if os.path.isdir(WORKSPACE):
        for entry in sorted(os.scandir(WORKSPACE), key=lambda e: e.stat().st_mtime, reverse=True):
            if entry.is_file() and entry.name.lower().endswith(SUFFIXES):
                st = entry.stat()
                files.append({"name": entry.name, "size_mb": round(st.st_size / 1e6, 2),
                              "modified": time.strftime("%Y-%m-%d %H:%M", time.gmtime(st.st_mtime)),
                              "path": f"{WORKSPACE}/{entry.name}", "geolibre_path": f"{GEOLIBRE_ROOT}/{entry.name}",
                              "url": f"/workspace/{entry.name}",
                              "kind": "raster" if entry.name.lower().endswith((".tif", ".tiff")) else "file"})
    return {"files": files, "geolibre_folder": GEOLIBRE_ROOT}


def prepare(data: dict) -> dict:
    if not data.get("raster"):
        raise ProcessorExecuteError("raster is required")
    if not data.get("aoi"):
        raise ProcessorExecuteError("aoi is required (current view or a drawn shape)")
    aoi = load_aoi(data["aoi"])
    href = resolve_raster(data["raster"], tuple(aoi.total_bounds))
    if href.startswith(("http://", "https://")):
        href = "/vsicurl/" + href
    name = safe_name(data.get("name") or os.path.splitext(os.path.basename(str(data["raster"])))[0])
    os.makedirs(WORKSPACE, exist_ok=True)
    dst = os.path.join(WORKSPACE, f"{name}.tif")
    with rasterio.open(href) as src:
        bounds = transform_bounds("EPSG:4326", src.crs, *aoi.total_bounds, densify_pts=21)
        win = from_bounds(*bounds, transform=src.transform).round_offsets().round_lengths()
        try:
            win = win.intersection(Window(0, 0, src.width, src.height))
        except rasterio.errors.WindowError:
            win = None
        if win is None or win.width < 1 or win.height < 1:
            raise ProcessorExecuteError("the raster does not cover this area")
        bands = [int(data["band"])] if data.get("band") else list(range(1, src.count + 1))
        if win.width * win.height * len(bands) > MAX_PIXELS:
            raise ProcessorExecuteError(f"area too large ({int(win.width)} x {int(win.height)} pixels); zoom in or draw a smaller area")
        profile = src.profile.copy()
        profile.update(driver="GTiff", width=int(win.width), height=int(win.height), count=len(bands),
                       transform=src.window_transform(win), tiled=True, blockxsize=256, blockysize=256,
                       compress="deflate")
        with tempfile.TemporaryDirectory(dir=WORKSPACE) as tmp:
            raw = os.path.join(tmp, "clip.tif")
            with rasterio.open(raw, "w", **profile) as out:
                out.write(src.read(bands, window=win))
            rasterio.shutil.copy(raw, dst, driver="COG", compress="DEFLATE")
    return {"name": f"{name}.tif", "geolibre_path": f"{GEOLIBRE_ROOT}/{name}.tif",
            "path": f"{WORKSPACE}/{name}.tif", "url": f"/workspace/{name}.tif",
            "size": [int(win.width), int(win.height)], "bands": len(bands)}


class WorkspaceProcessor(BaseProcessor):
    def __init__(self, processor_def):
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data, outputs=None):
        action = data.get("action", "list")
        if action == "list":
            return "application/json", list_files()
        if action == "prepare":
            try:
                return "application/json", prepare(data)
            except rasterio.errors.RasterioIOError as e:
                raise ProcessorExecuteError(f"could not read the raster: {e}")
        raise ProcessorExecuteError("action must be list or prepare")

    def __repr__(self):
        return "<WorkspaceProcessor>"
