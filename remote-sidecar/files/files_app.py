"""File service for the shared GeoLibre sidecar.

GeoLibre's sidecar reads and writes only its /data folder, and its raster tools take file paths. This
small API lets participants put their own data there from the browser and get results back:

  GET    /files                 the participant's files (/data/u-<id>) and the shared files (/data)
  PUT    /files/{name}          upload to the participant's folder (raw body; "If-None-Match: *"
                                refuses to replace an existing file)
  DELETE /files/{name}          delete from the participant's folder
  POST   /files/{name}/display  map-ready copy (Cloud Optimized GeoTIFF) of a raster, ?scope=shared
  GET    /files/{name}/geojson  a vector file in lat/lon for the map, ?scope=shared

Each plugin installation sends its own folder id (X-Participant: u-<random>), so participants do not
overwrite each other's files. Files at the top of /data are shared and read-only through this API.

Runs from the GeoLibre image (FastAPI, rasterio, rio-cogeo are already there). Access control,
CORS and HTTPS are handled by Caddy in front of it.
"""
import os
import re
import shutil
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response

DATA = Path(os.environ.get("DATA_DIR", "/data"))
MAX_UPLOAD = int(os.environ.get("MAX_UPLOAD_MB", "500")) * 1024 * 1024
DISPLAY_DIR = ".display"  # map-ready copies, hidden from the list
ALLOWED = (".tif", ".tiff", ".geojson", ".json", ".gpkg", ".fgb", ".csv", ".zip", ".shp", ".shx", ".dbf",
           ".prj", ".cpg", ".parquet", ".txt", ".html", ".las", ".laz")

app = FastAPI(title="GeoLibre shared sidecar files", docs_url=None, redoc_url=None)


PARTICIPANT = re.compile(r"^u-[a-z0-9]{6,32}$")
CRS_DIR = ".crs"
RASTER_EXT = (".tif", ".tiff")
VECTOR_EXT = (".geojson", ".json", ".gpkg", ".fgb", ".parquet")


def safe_name(name: str) -> str:
    base = os.path.basename(name or "").strip()
    stem, ext = os.path.splitext(base)
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", stem).strip("-.")[:80]
    ext = ext.lower()
    if not stem or ext not in ALLOWED:
        raise HTTPException(400, f"file name must end with one of: {', '.join(ALLOWED)}")
    return stem + ext


def participant_dir(request: Request) -> Path:
    """Each plugin installation has its own folder /data/u-<random id> (sent as X-Participant)."""
    pid = (request.headers.get("x-participant") or "").strip().lower()
    if not PARTICIPANT.match(pid):
        raise HTTPException(400, "missing or invalid participant folder id (update the plugin)")
    folder = DATA / pid
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def target(name: str, folder: Path) -> Path:
    path = (folder / safe_name(name)).resolve()
    if path.parent != folder.resolve():
        raise HTTPException(400, "invalid file name")
    return path


def readable(name: str, request: Request, scope: str) -> Path:
    """Own folder by default; scope=shared reads files the trainer put at the top of /data."""
    return target(name, DATA if scope == "shared" else participant_dir(request))


def crs_meta(path: Path) -> Path:
    """Where the projection of an auto-projected job output is recorded (unique per full path)."""
    rel = Path(path).resolve().relative_to(DATA.resolve())
    return DATA / CRS_DIR / ("__".join(rel.parts) + ".json")


def describe(p: Path) -> dict:
    st = p.stat()
    ext = p.suffix.lower()
    return {"name": p.name, "path": "/" + str(Path("data") / p.resolve().relative_to(DATA.resolve())),
            "size_mb": round(st.st_size / 1e6, 2),
            "modified": time.strftime("%Y-%m-%d %H:%M", time.gmtime(st.st_mtime)),
            "kind": "raster" if ext in RASTER_EXT else "vector" if ext in VECTOR_EXT else "file"}


def files_in(folder: Path) -> list:
    if not folder.is_dir():
        return []
    return [describe(p) for p in sorted(folder.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
            if p.is_file() and not p.name.startswith(".")]


@app.get("/files")
def list_files(request: Request):
    folder = participant_dir(request)
    return {"folder": f"/data/{folder.name}", "files": files_in(folder), "shared": files_in(DATA)}


@app.put("/files/{name}")
async def upload(name: str, request: Request):
    folder = participant_dir(request)
    path = target(name, folder)
    if request.headers.get("if-none-match") == "*" and path.exists():
        raise HTTPException(412, f"{path.name} already exists in your folder")
    declared = int(request.headers.get("content-length") or 0)
    if declared > MAX_UPLOAD:
        raise HTTPException(413, f"file too large (limit {MAX_UPLOAD // 1024 // 1024} MB)")
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".upload-")
    size = 0
    try:
        with os.fdopen(fd, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, f"file too large (limit {MAX_UPLOAD // 1024 // 1024} MB)")
                f.write(chunk)
        os.replace(tmp, path)
        crs_meta(path).unlink(missing_ok=True)  # a new upload is in its own CRS
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return {**describe(path), "size_mb": round(size / 1e6, 2)}


@app.delete("/files/{name}")
def delete(name: str, request: Request):
    folder = participant_dir(request)
    path = target(name, folder)
    if not path.exists():
        raise HTTPException(404, "no such file")
    path.unlink()
    shutil.rmtree(DATA / DISPLAY_DIR / folder.name / path.stem, ignore_errors=True)
    crs_meta(path).unlink(missing_ok=True)
    return {"deleted": path.name}


@app.post("/files/{name}/display")
def display(name: str, request: Request, scope: str = "own"):
    """Map-ready copy: GeoLibre draws rasters in the browser from Cloud Optimized GeoTIFFs, while
    Whitebox writes plain GeoTIFFs. The copy is cached until the source changes."""
    src = readable(name, request, scope)
    if not src.exists() or src.suffix.lower() not in RASTER_EXT:
        raise HTTPException(404, "no such raster")
    owner = "_shared" if scope == "shared" else src.parent.name
    out_dir = DATA / DISPLAY_DIR / owner / src.stem
    out = out_dir / f"{int(src.stat().st_mtime)}.tif"
    if not out.exists():
        from rio_cogeo.cogeo import cog_translate
        from rio_cogeo.profiles import cog_profiles

        shutil.rmtree(out_dir, ignore_errors=True)
        out_dir.mkdir(parents=True)
        try:
            cog_translate(str(src), str(out), cog_profiles.get("deflate"), web_optimized=True, quiet=True)
        except Exception as e:  # report unreadable rasters to the plugin
            shutil.rmtree(out_dir, ignore_errors=True)
            raise HTTPException(422, f"could not prepare {src.name} for display: {e}")
    import rasterio

    with rasterio.open(out) as ds:
        band = ds.read(1, masked=True, out_shape=(1, min(ds.height, 512), min(ds.width, 512)))
        stats = {"min": float(band.min()), "max": float(band.max())} if band.count() else {}
    return {"url": f"/data/{DISPLAY_DIR}/{owner}/{src.stem}/{out.name}", **stats}


# ---------------- automatic projection for Whitebox jobs ----------------
# Whitebox measures in the units of the data's coordinates, so latitude/longitude inputs give areas in
# square degrees and distances in degrees. When the plugin sends "X-Auto-Project: utm", jobs are
# intercepted here (Caddy routes POST /sidecar/whitebox/run to this service): geographic vector inputs
# and rasters are reprojected to the local UTM zone, the job is forwarded to the sidecar, and the
# projection of each output is recorded so /files/{name}/display can return vectors in lat/lon.

import json
import math
import urllib.error
import urllib.request

SIDECAR = os.environ.get("SIDECAR_URL", "http://geolibre:80/sidecar")
UTM_DIR = ".utm"
_tool_kinds: dict = {}


def utm_epsg(lon: float, lat: float) -> int:
    zone = min(60, max(1, int(math.floor((lon + 180) / 6)) + 1))
    return (32600 if lat >= 0 else 32700) + zone


def param_kinds(tool_id: str, tool: dict | None) -> dict:
    """Parameter name -> kind (raster_in, vector_in, raster_out, vector_out, ...)."""
    if tool and tool.get("params"):
        return {p["name"]: p.get("kind", "") for p in tool["params"]}
    if not _tool_kinds:
        with urllib.request.urlopen(f"{SIDECAR}/whitebox/tools", timeout=60) as r:
            body = json.load(r)
        for t in body if isinstance(body, list) else body.get("tools", []):
            _tool_kinds[t["id"]] = {p["name"]: p.get("kind", "") for p in t.get("params", [])}
    return _tool_kinds.get(tool_id, {})


def _geojson_center(gj: dict):
    import geopandas as gpd

    gdf = gpd.GeoDataFrame.from_features(gj.get("features", []), crs=4326)
    if gdf.empty:
        return None
    x0, y0, x1, y1 = gdf.total_bounds
    return (x0 + x1) / 2, (y0 + y1) / 2


def _is_lonlat_geojson(gj: dict) -> bool:
    name = (((gj.get("crs") or {}).get("properties") or {}).get("name") or "").upper()
    return not name or "4326" in name or "CRS84" in name


def _reproject_geojson(gj: dict, epsg: int) -> dict:
    import geopandas as gpd

    gdf = gpd.GeoDataFrame.from_features(gj.get("features", []), crs=4326).to_crs(epsg)
    out = json.loads(gdf.to_json(drop_id=True))
    out["crs"] = {"type": "name", "properties": {"name": f"urn:ogc:def:crs:EPSG::{epsg}"}}
    return out


def _raster_geographic(path: str):
    import rasterio

    with rasterio.open(path) as ds:
        if ds.crs and ds.crs.is_geographic:
            from rasterio.warp import transform_bounds
            x0, y0, x1, y1 = transform_bounds(ds.crs, "EPSG:4326", *ds.bounds)
            return (x0 + x1) / 2, (y0 + y1) / 2
    return None


def _warp_to_utm(path: str, epsg: int) -> str:
    """Cached UTM copy of a geographic raster (refreshed when the source changes)."""
    import rasterio
    from rasterio.warp import Resampling, calculate_default_transform, reproject

    src_path = Path(path)
    key = "__".join(src_path.resolve().relative_to(DATA.resolve()).with_suffix("").parts)
    out = DATA / UTM_DIR / f"{key}-{epsg}-{int(src_path.stat().st_mtime)}.tif"
    if out.exists():
        return str(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path) as src:
        transform, width, height = calculate_default_transform(src.crs, f"EPSG:{epsg}", src.width, src.height, *src.bounds)
        profile = src.profile.copy()
        profile.update(crs=f"EPSG:{epsg}", transform=transform, width=width, height=height, driver="GTiff",
                       tiled=True, blockxsize=256, blockysize=256, compress="deflate")
        with rasterio.open(out, "w", **profile) as dst:
            for b in range(1, src.count + 1):
                reproject(rasterio.band(src, b), rasterio.band(dst, b), resampling=Resampling.bilinear)
    return str(out)


def auto_project(req: dict) -> tuple[dict, int | None, list[str]]:
    """Reproject geographic inputs of a Whitebox request to UTM. Returns the new request, the EPSG
    used (None if nothing was geographic) and the notes for the job log."""
    kinds = param_kinds(req.get("tool_id", ""), req.get("tool"))
    params = dict(req.get("parameters") or {})
    layers = dict(req.get("layer_inputs") or {})
    center = None
    for value in layers.values():
        for layer in value if isinstance(value, list) else [value]:
            gj = (layer or {}).get("geojson")
            if isinstance(gj, dict) and _is_lonlat_geojson(gj):
                center = center or _geojson_center(gj)
    raster_inputs = [k for k, v in params.items() if kinds.get(k) == "raster_in" and isinstance(v, str) and v.startswith("/data/")]
    geo_rasters = {}
    for k in raster_inputs:
        if os.path.exists(params[k]):
            c = _raster_geographic(params[k])
            if c:
                geo_rasters[k] = c
                center = center or c
    if center is None:
        return req, None, []
    epsg = utm_epsg(*center)
    notes = []
    for name, value in layers.items():
        items = value if isinstance(value, list) else [value]
        new = []
        for layer in items:
            gj = (layer or {}).get("geojson")
            if isinstance(gj, dict) and _is_lonlat_geojson(gj):
                layer = {**layer, "geojson": _reproject_geojson(gj, epsg)}
                notes.append(f"{name}: reprojected to EPSG:{epsg}")
            new.append(layer)
        layers[name] = new if isinstance(value, list) else new[0]
    for k in geo_rasters:
        params[k] = _warp_to_utm(params[k], epsg)
        notes.append(f"{k}: reprojected to EPSG:{epsg}")
    return {**req, "parameters": params, "layer_inputs": layers}, epsg, notes


def record_output_crs(req: dict, epsg: int) -> None:
    kinds = param_kinds(req.get("tool_id", ""), req.get("tool"))
    for k, v in (req.get("parameters") or {}).items():
        if kinds.get(k, "").endswith("_out") and isinstance(v, str) and v.startswith("/data/"):
            meta = crs_meta(Path(v))
            meta.parent.mkdir(parents=True, exist_ok=True)
            meta.write_text(json.dumps({"epsg": epsg}))


@app.post("/sidecar/whitebox/run")
async def whitebox_run(request: Request):
    raw = await request.body()
    body = raw
    if request.headers.get("x-auto-project", "").lower() == "utm":
        try:
            req = json.loads(raw)
            new, epsg, _ = auto_project(req)
            if epsg:
                record_output_crs(new, epsg)
                body = json.dumps(new).encode()
        except HTTPException:
            raise
        except Exception as e:  # never block a job because of the projection helper
            print(f"auto-project skipped: {e}", flush=True)
    fwd = urllib.request.Request(f"{SIDECAR}/whitebox/run", data=body, method="POST",
                                 headers={"Content-Type": request.headers.get("content-type", "application/json")})
    try:
        with urllib.request.urlopen(fwd, timeout=600) as r:
            return Response(r.read(), status_code=r.status, media_type=r.headers.get("content-type"))
    except urllib.error.HTTPError as e:
        return Response(e.read(), status_code=e.code, media_type=e.headers.get("content-type"))


def vector_display(src: Path) -> dict:
    """GeoJSON in lat/lon for the map. Outputs of auto-projected jobs carry their recorded CRS."""
    import geopandas as gpd

    meta = crs_meta(src)
    gdf = gpd.read_file(src)
    if meta.exists():
        gdf = gdf.set_crs(json.loads(meta.read_text())["epsg"], allow_override=True)
    elif gdf.crs is None:
        gdf = gdf.set_crs(4326)
    return json.loads(gdf.to_crs(4326).to_json(drop_id=True))


@app.get("/sidecar/whitebox/output")
def whitebox_output(path: str):
    """GeoLibre loads vector outputs of Whitebox jobs through this sidecar route. Outputs of
    auto-projected jobs are in UTM: return them in lat/lon so the layer lands in the right place."""
    p = Path(path)
    inside = p.resolve().is_relative_to(DATA.resolve())
    if inside and p.exists() and crs_meta(p).exists():
        try:
            return vector_display(p)
        except Exception as e:
            print(f"auto-project output conversion skipped: {e}", flush=True)
    from urllib.parse import quote
    try:
        with urllib.request.urlopen(f"{SIDECAR}/whitebox/output?path={quote(path)}", timeout=120) as r:
            return Response(r.read(), status_code=r.status, media_type=r.headers.get("content-type"))
    except urllib.error.HTTPError as e:
        return Response(e.read(), status_code=e.code, media_type=e.headers.get("content-type"))


@app.get("/files/{name}/geojson")
def geojson_for_map(name: str, request: Request, scope: str = "own"):
    src = readable(name, request, scope)
    if not src.exists():
        raise HTTPException(404, "no such file")
    try:
        return vector_display(src)
    except Exception as e:
        raise HTTPException(422, f"could not read {src.name} as vector data: {e}")


@app.get("/health")
def health():
    return {"ok": True, "folder": str(DATA)}
