"""Local copies of remote vector files (HOT exports, geoBoundaries, CSVs).

Zipped GeoPackages cannot be read in ranges (the member is compressed), so a remote read of one
city in a country-wide file downloads most of it every time. The first use downloads and unzips the
file into VECTOR_CACHE_DIR; later reads use the GeoPackage spatial index on local disk.

Prewarm before a class (inside the pygeoapi container):
  python -m training_processes.vector_cache osm-roads/SEN osm-buildings/SEN admin-boundaries/SEN-ADM2
  python -m training_processes.vector_cache --countries SEN,PAK   # every vector collection
"""
import fcntl
import hashlib
import os
import shutil
import sys
import tempfile
import time
import zipfile

import requests

CACHE_DIR = os.environ.get("VECTOR_CACHE_DIR", "/cache/vectors")
MAX_AGE_S = float(os.environ.get("VECTOR_CACHE_MAX_AGE_DAYS", "30")) * 86400
UA = {"User-Agent": "geo-training-stack/1.0"}


def _paths(url: str, member: str | None) -> tuple[str, str]:
    key = hashlib.sha256(url.encode()).hexdigest()[:16]
    name = os.path.basename(member or url.split("?")[0]) or "data"
    folder = os.path.join(CACHE_DIR, key)
    return folder, os.path.join(folder, name)


def local_copy(url: str, member: str | None = None) -> str:
    """Path of a fresh local copy of url (or of member inside the zip at url)."""
    folder, path = _paths(url, member)
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < MAX_AGE_S:
        return path
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, ".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # one download per file, other requests wait for it
        if os.path.exists(path) and time.time() - os.path.getmtime(path) < MAX_AGE_S:
            return path
        with tempfile.TemporaryDirectory(dir=folder) as tmp:
            raw = os.path.join(tmp, "download")
            with requests.get(url, stream=True, timeout=(30, 300), headers=UA) as r:
                r.raise_for_status()
                with open(raw, "wb") as f:
                    shutil.copyfileobj(r.raw, f, 1 << 20)
            if url.lower().split("?")[0].endswith(".zip"):
                with zipfile.ZipFile(raw) as z:
                    names = z.namelist()
                    want = member or next((n for n in names if n.lower().endswith((".gpkg", ".geojson", ".fgb"))), None)
                    if want not in names:
                        raise FileNotFoundError(f"{want} not in {url}")
                    with z.open(want) as src, open(os.path.join(tmp, "out"), "wb") as dst:
                        shutil.copyfileobj(src, dst, 1 << 20)
                os.replace(os.path.join(tmp, "out"), path)
            else:
                os.replace(raw, path)
    return path


def _main(argv):
    refs = [a for a in argv if not a.startswith("--")]
    if "--countries" in argv:
        import yaml
        isos = argv[argv.index("--countries") + 1].upper().split(",")
        refs = [r for r in refs if r not in isos]
        cfg = yaml.safe_load(open(os.environ.get("CATALOG_SOURCES", "/catalog/sources.yml")))
        for c in cfg["collections"]:
            if c["kind"] in ("hdx-hot", "hdx-csv"):
                refs += [f"{c['id']}/{iso}" for iso in isos]
            elif c["kind"] == "geoboundaries":
                refs += [f"{c['id']}/{iso}-{lv}" for iso in isos for lv in c.get("levels", [])]
    from pystac_client import Client
    api = Client.open(os.environ["STAC_API_URL"])
    for ref in refs:
        coll, iid = ref.split("/")[:2]
        try:
            item = api.get_collection(coll).get_item(iid)
        except Exception:
            item = None
        if item is None:
            print(f"skip {ref}: not in catalogue", flush=True)
            continue
        for key, asset in item.assets.items():
            url, _, member = asset.href.partition("#")
            if not url.startswith(("http://", "https://")):
                continue
            t = time.time()
            try:
                p = local_copy(url, member or None)
            except Exception as e:  # keep warming the rest; report the failure
                print(f"FAILED {ref}/{key}: {e}", flush=True)
                continue
            print(f"{ref}/{key}: {os.path.getsize(p) / 1e6:.0f} MB in {time.time() - t:.0f}s", flush=True)


if __name__ == "__main__":
    _main(sys.argv[1:])
