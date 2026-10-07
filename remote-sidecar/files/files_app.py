"""File service for the shared GeoLibre sidecar.

GeoLibre's sidecar reads and writes only its /data folder, and its raster tools take file paths. This
small API lets participants put their own data there from the browser and get results back:

  GET    /files                 list files in /data
  PUT    /files/{name}          upload (raw request body; the plugin sends the file as-is)
  DELETE /files/{name}          delete
  POST   /files/{name}/display  make a map-ready copy (Cloud Optimized GeoTIFF in EPSG:3857 tiling)
                                of a raster and return its URL path under /data/

Runs from the GeoLibre image (FastAPI, rasterio, rio-cogeo are already there). Access control,
CORS and HTTPS are handled by Caddy in front of it.
"""
import os
import re
import shutil
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request

DATA = Path(os.environ.get("DATA_DIR", "/data"))
MAX_UPLOAD = int(os.environ.get("MAX_UPLOAD_MB", "500")) * 1024 * 1024
DISPLAY_DIR = ".display"  # map-ready copies, hidden from the list
ALLOWED = (".tif", ".tiff", ".geojson", ".json", ".gpkg", ".fgb", ".csv", ".zip", ".shp", ".shx", ".dbf",
           ".prj", ".cpg", ".parquet", ".txt", ".html", ".las", ".laz")

app = FastAPI(title="GeoLibre shared sidecar files", docs_url=None, redoc_url=None)


def safe_name(name: str) -> str:
    base = os.path.basename(name or "").strip()
    stem, ext = os.path.splitext(base)
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", stem).strip("-.")[:80]
    ext = ext.lower()
    if not stem or ext not in ALLOWED:
        raise HTTPException(400, f"file name must end with one of: {', '.join(ALLOWED)}")
    return stem + ext


def target(name: str) -> Path:
    path = (DATA / safe_name(name)).resolve()
    if path.parent != DATA.resolve():
        raise HTTPException(400, "invalid file name")
    return path


@app.get("/files")
def list_files():
    DATA.mkdir(parents=True, exist_ok=True)
    out = []
    for p in sorted(DATA.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if p.is_file() and not p.name.startswith("."):
            st = p.stat()
            out.append({"name": p.name, "path": f"/data/{p.name}", "size_mb": round(st.st_size / 1e6, 2),
                        "modified": time.strftime("%Y-%m-%d %H:%M", time.gmtime(st.st_mtime)),
                        "kind": "raster" if p.suffix.lower() in (".tif", ".tiff") else
                                "vector" if p.suffix.lower() in (".geojson", ".json", ".gpkg", ".fgb", ".parquet") else "file"})
    return {"files": out, "folder": "/data"}


@app.put("/files/{name}")
async def upload(name: str, request: Request):
    path = target(name)
    declared = int(request.headers.get("content-length") or 0)
    if declared > MAX_UPLOAD:
        raise HTTPException(413, f"file too large (limit {MAX_UPLOAD // 1024 // 1024} MB)")
    DATA.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DATA, prefix=".upload-")
    size = 0
    try:
        with os.fdopen(fd, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, f"file too large (limit {MAX_UPLOAD // 1024 // 1024} MB)")
                f.write(chunk)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return {"name": path.name, "path": f"/data/{path.name}", "size_mb": round(size / 1e6, 2)}


@app.delete("/files/{name}")
def delete(name: str):
    path = target(name)
    if not path.exists():
        raise HTTPException(404, "no such file")
    path.unlink()
    shutil.rmtree(DATA / DISPLAY_DIR / path.stem, ignore_errors=True)
    return {"deleted": path.name}


@app.post("/files/{name}/display")
def display(name: str):
    """Map-ready copy: GeoLibre draws rasters in the browser from Cloud Optimized GeoTIFFs, while
    Whitebox writes plain GeoTIFFs. The copy is cached until the source changes."""
    src = target(name)
    if not src.exists() or src.suffix.lower() not in (".tif", ".tiff"):
        raise HTTPException(404, "no such raster")
    out_dir = DATA / DISPLAY_DIR / src.stem
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
    return {"url": f"/data/{DISPLAY_DIR}/{src.stem}/{out.name}", **stats}


@app.get("/health")
def health():
    return {"ok": True, "folder": str(DATA)}
