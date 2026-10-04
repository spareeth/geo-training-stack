"""Run any WhiteboxTools tool on the server: the same toolbox GeoLibre runs in the browser,
here with server CPU and memory.

Two processes:
  whitebox-tools  list tools, or the parameters of one tool (drives the GeoLibre plugin forms)
  whitebox        run one tool. Raster/vector inputs may be catalogue refs, URLs, earlier
                  outputs, or inline GeoJSON; an optional AOI clips rasters before running.
"""
import functools
import json
import os
import re
import shutil
import subprocess
import tempfile

import geopandas as gpd
import numpy as np
import rasterio
from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds

from . import mcda
from .common import load_aoi, new_output
from .zonal_stats import load_zones, resolve_raster

WBT = os.environ.get("WHITEBOX_TOOLS", "/opt/whitebox/whitebox_tools")
TIMEOUT_S = int(os.environ.get("WHITEBOX_TIMEOUT_S", "1800"))
MAX_INPUT_CELLS = int(os.environ.get("WHITEBOX_MAX_INPUT_CELLS", "100000000"))
MAX_INLINE_FEATURES = 20_000
TOOL_NAME = re.compile(r"^[A-Za-z0-9]+$")


class WhiteboxError(mcda.MCDAError):
    pass


def _wbt(*args: str) -> str:
    try:
        r = subprocess.run([WBT, *args], capture_output=True, text=True, timeout=TIMEOUT_S)
    except FileNotFoundError:
        raise WhiteboxError("WhiteboxTools is not installed on the server")
    except subprocess.TimeoutExpired:
        raise WhiteboxError(f"tool ran longer than {TIMEOUT_S} s; use a smaller area")
    if r.returncode != 0:
        raise WhiteboxError((r.stderr or r.stdout).strip()[-2000:] or "tool failed")
    return r.stdout


@functools.lru_cache(maxsize=1)
def list_tools() -> dict[str, str]:
    """{ToolName: description}, parsed from `whitebox_tools --listtools`."""
    tools = {}
    for line in _wbt("--listtools").splitlines():
        m = re.match(r"^\s*([A-Za-z0-9]+):\s*(.*)$", line)
        if m and not line.lower().startswith("all"):
            tools[m.group(1)] = m.group(2).strip()
    return tools


def canonical_tool(name: str) -> str:
    if not TOOL_NAME.match(name or ""):
        raise WhiteboxError("tool names are letters and digits only, e.g. Slope or ZonalStatistics")
    lookup = {t.lower(): t for t in list_tools()}
    key = name.lower().replace("_", "")
    if key not in lookup:
        raise WhiteboxError(f"unknown WhiteboxTools tool: {name}")
    return lookup[key]


@functools.lru_cache(maxsize=2048)
def tool_parameters(tool: str) -> list[dict]:
    """Parameters of one tool: [{name, flag, description, kind, data, optional, default}].
    kind: in_raster, in_vector, in_file, in_raster_or_number, out_raster, out_vector, out_file,
    boolean, number, integer, choice, string, in_raster_list."""
    raw = json.loads(_wbt(f"--toolparameters={tool}"))
    params = []
    for p in raw.get("parameters", []):
        flag = max(p["flags"], key=len)
        ptype = p.get("parameter_type")
        kind, data = classify(ptype)
        params.append({"name": flag.lstrip("-"), "flag": flag, "label": p.get("name"),
                       "description": p.get("description", ""), "kind": kind, "data": data,
                       "optional": bool(p.get("optional")), "default": p.get("default_value")})
    return params


def file_kind(val) -> str:
    """'raster', 'vector' or 'file' from a WhiteboxTools file type such as "Raster",
    {"Vector": "Polygon"} or "Csv"."""
    text = json.dumps(val)
    return "raster" if "Raster" in text else "vector" if "Vector" in text else "file"


def classify(ptype) -> tuple[str, object]:
    """Map WhiteboxTools parameter_type JSON to a simple kind for forms and file handling."""
    if isinstance(ptype, str):
        return {"Boolean": "boolean", "Float": "number", "Integer": "integer"}.get(ptype, "string"), None
    (key, val), = ptype.items()
    if key == "OptionList":
        return "choice", val
    if key == "ExistingFile":
        return {"raster": "in_raster", "vector": "in_vector"}.get(file_kind(val), "in_file"), val
    if key == "ExistingFileOrFloat":
        return ("in_raster_or_number" if file_kind(val) == "raster" else "in_file"), val
    if key == "FileList":
        return ("in_raster_list" if file_kind(val) == "raster" else "in_file_list"), val
    if key == "NewFile":
        return {"raster": "out_raster", "vector": "out_vector"}.get(file_kind(val), "out_file"), val
    return "string", val


# --- input staging -----------------------------------------------------------------------

def stage_raster(ref: str, workdir: str, name: str, aoi: gpd.GeoDataFrame | None) -> str:
    """Copy (and clip to the AOI) a raster into the work dir as GeoTIFF."""
    href = resolve_raster(ref, tuple(aoi.to_crs(4326).total_bounds) if aoi is not None else None)
    out = os.path.join(workdir, f"{name}.tif")
    with rasterio.open(href) as src:
        window = None
        if aoi is not None:
            b = transform_bounds("EPSG:4326", src.crs, *aoi.to_crs(4326).total_bounds)
            window = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
            window = window.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
        w = window.width if window else src.width
        h = window.height if window else src.height
        if w * h * src.count > MAX_INPUT_CELLS:
            raise WhiteboxError(f"input '{name}' is too large ({int(w)} x {int(h)}); draw a smaller area")
        data = src.read(window=window)
        profile = src.profile.copy()
        profile.update(driver="GTiff", width=data.shape[2], height=data.shape[1], compress="deflate",
                       transform=src.window_transform(window) if window else src.transform)
        profile.pop("blockxsize", None), profile.pop("blockysize", None), profile.pop("tiled", None)
        if profile.get("nodata") is None and np.issubdtype(data.dtype, np.floating):
            profile["nodata"] = np.nan
    with rasterio.open(out, "w", **profile) as dst:
        dst.write(data)
    return out


def stage_vector(ref, workdir: str, name: str, aoi: gpd.GeoDataFrame | None) -> str:
    gdf = load_zones(ref)
    if aoi is not None:
        gdf = gdf.clip(aoi.to_crs(gdf.crs))
    out = os.path.join(workdir, f"{name}.shp")
    gdf.to_file(out)
    return out


def build_command(tool: str, args: dict, workdir: str, aoi) -> tuple[list[str], dict]:
    params = {p["name"]: p for p in tool_parameters(tool)}
    unknown = set(args) - set(params)
    if unknown:
        raise WhiteboxError(f"{tool} has no parameters {sorted(unknown)}; valid: {sorted(params)}")
    cmd, outputs = [f"--run={tool}", f"--wd={workdir}"], {}
    for name, p in params.items():
        if p["kind"].startswith("out_"):
            ext = {"out_raster": "tif", "out_vector": "shp"}.get(p["kind"], "txt")
            if p["kind"] == "out_file" and isinstance(p["data"], str):
                ext = {"Html": "html", "Csv": "csv", "Lidar": "las"}.get(p["data"], "txt")
            path = os.path.join(workdir, f"out_{name}.{ext}")
            cmd.append(f"{p['flag']}={path}")
            outputs[name] = (p["kind"], path)
            continue
        if name not in args:
            if not p["optional"] and p["default"] is None:
                raise WhiteboxError(f"missing required parameter '{name}': {p['description']}")
            continue
        v = args[name]
        if p["kind"] == "in_raster":
            v = stage_raster(v, workdir, name, aoi)
        elif p["kind"] == "in_vector":
            v = stage_vector(v, workdir, name, aoi)
        elif p["kind"] == "in_raster_or_number" and not isinstance(v, (int, float)):
            v = stage_raster(v, workdir, name, aoi)
        elif p["kind"] == "in_raster_list":
            v = ";".join(stage_raster(r, workdir, f"{name}_{i}", aoi) for i, r in enumerate(v))
        elif p["kind"] == "boolean":
            if v in (True, "true", "True", 1):
                cmd.append(p["flag"])
            continue
        elif p["kind"] in ("in_file", "in_file_list"):
            raise WhiteboxError(f"parameter '{name}' needs a file type the server tool does not accept yet")
        v = str(v)
        if "\n" in v or "\0" in v:
            raise WhiteboxError(f"invalid value for '{name}'")
        cmd.append(f"{p['flag']}={v}")
    return cmd, outputs


def collect_outputs(outputs: dict, tool: str) -> dict:
    res = {}
    for name, (kind, path) in outputs.items():
        if not os.path.exists(path):
            continue
        if kind == "out_raster":
            dest, url = new_output(tool.lower(), "tif")
            with rasterio.open(path) as src:
                profile = src.profile.copy()
                profile.update(driver="COG", compress="deflate")
                for k in ("blockxsize", "blockysize", "tiled", "interleave"):
                    profile.pop(k, None)
                data = src.read()
                valid = np.ma.masked_invalid(src.read(1, masked=True))
            with rasterio.open(dest, "w", **profile) as dst:
                dst.write(data)
            res[name] = {"type": "raster", "url": url}
            if valid.count():
                # Lets the map pick a sensible colour stretch straight away.
                res[name]["stats"] = {"min": float(valid.min()), "max": float(valid.max())}
        elif kind == "out_vector":
            gdf = gpd.read_file(path)
            if gdf.crs is not None:
                gdf = gdf.to_crs(4326)
            dest, url = new_output(tool.lower(), "geojson")
            gdf.to_file(dest, driver="GeoJSON")
            item = {"type": "vector", "url": url, "feature_count": len(gdf)}
            if len(gdf) <= MAX_INLINE_FEATURES:
                item["geojson"] = json.loads(gdf.to_json(drop_id=True))
            res[name] = item
        else:
            with open(path, errors="replace") as f:
                res[name] = {"type": "text", "content": f.read()[:200_000]}
    return res


def run_whitebox(data: dict) -> dict:
    tool = canonical_tool(data.get("tool", ""))
    aoi = load_aoi(data["aoi"]) if data.get("aoi") else None
    workdir = tempfile.mkdtemp(prefix="wbt-")
    try:
        cmd, outputs = build_command(tool, data.get("args") or {}, workdir, aoi)
        log = _wbt(*cmd)
        return {"tool": tool, "outputs": collect_outputs(outputs, tool), "log": log[-4000:]}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def run_list(data: dict) -> dict:
    if data.get("tool"):
        tool = canonical_tool(data["tool"])
        return {"tool": tool, "description": list_tools()[tool], "parameters": tool_parameters(tool)}
    q = (data.get("search") or "").lower()
    tools = [{"tool": t, "description": d} for t, d in list_tools().items()
             if not q or q in t.lower() or q in d.lower()]
    # Exact name first, then names starting with / containing the text, then description matches.
    tools.sort(key=lambda x: (x["tool"].lower() != q, not x["tool"].lower().startswith(q),
                              q not in x["tool"].lower()))
    return {"count": len(tools), "tools": tools}


RUN_METADATA = {
    "version": "0.1.0", "id": "whitebox", "title": "WhiteboxTools (server)",
    "description": "Run any of the WhiteboxTools geoprocessing tools on the server.",
    "jobControlOptions": ["sync-execute", "async-execute"],
    "keywords": ["whitebox", "terrain", "hydrology", "raster", "vector", "geoprocessing"],
    "inputs": {
        "tool": {"title": "Tool name, e.g. Slope", "schema": {"type": "string"}},
        "args": {"title": "Parameters by name (see whitebox-tools)", "schema": {"type": "object"}},
        "aoi": {"title": "Optional area: rasters and vectors are clipped to it first",
                "schema": {"oneOf": [{"type": "array"}, {"type": "object"}, {"type": "string"}]},
                "minOccurs": 0},
    },
    "outputs": {"result": {"title": "Outputs", "schema": {"type": "object", "contentMediaType": "application/json"}}},
    "example": {"inputs": {"tool": "Slope", "args": {"dem": "cop-dem/item/data"}, "aoi": [39.1, 21.4, 39.3, 21.6]}},
}

LIST_METADATA = {
    "version": "0.1.0", "id": "whitebox-tools", "title": "List WhiteboxTools tools",
    "description": "List the server tools (optionally filtered), or the parameters of one tool.",
    "jobControlOptions": ["sync-execute"],
    "keywords": ["whitebox"],
    "inputs": {
        "search": {"title": "Filter text", "schema": {"type": "string"}, "minOccurs": 0},
        "tool": {"title": "Tool name for its parameters", "schema": {"type": "string"}, "minOccurs": 0},
    },
    "outputs": {"result": {"title": "Tools", "schema": {"type": "object", "contentMediaType": "application/json"}}},
}


class WhiteboxProcessor(BaseProcessor):
    def __init__(self, processor_def):
        super().__init__(processor_def, RUN_METADATA)

    def execute(self, data, outputs=None):
        try:
            return "application/json", run_whitebox(data)
        except (mcda.MCDAError, KeyError) as e:
            raise ProcessorExecuteError(str(e))

    def __repr__(self):
        return "<WhiteboxProcessor>"


class WhiteboxListProcessor(BaseProcessor):
    def __init__(self, processor_def):
        super().__init__(processor_def, LIST_METADATA)

    def execute(self, data, outputs=None):
        try:
            return "application/json", run_list(data)
        except mcda.MCDAError as e:
            raise ProcessorExecuteError(str(e))

    def __repr__(self):
        return "<WhiteboxListProcessor>"
