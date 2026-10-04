"""Populate the course catalogue from public sources listed in catalog/sources.yml.

Registers metadata only; assets point at public cloud storage. Run inside the pygeoapi image from
the repo root (it has pystac-client, requests, shapely, GDAL):

  docker compose run --rm -v "$PWD/catalog:/catalog" -v "$PWD/scripts:/scripts:ro" \\
    --entrypoint /venv/bin/python pygeoapi /scripts/harvest_catalog.py

Options: --only id1,id2 (collections), --countries SEN,PAK (subset), --dry-run.
Country outlines are cached in catalog/.cache so re-runs are fast.
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import json
import math
import os
import re
import sys
import time

import requests
import yaml
from osgeo import gdal
from pystac_client import Client
from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

ap = argparse.ArgumentParser()
ap.add_argument("--sources", default="/catalog/sources.yml")
ap.add_argument("--cache", default="/catalog/.cache")
ap.add_argument("--api", default=os.environ.get("STAC_API_URL", "http://stac-api:8080/stac"))
ap.add_argument("--only", help="comma separated collection ids")
ap.add_argument("--countries", help="comma separated ISO3 subset")
ap.add_argument("--dry-run", action="store_true")
args = ap.parse_args()

gdal.UseExceptions()
gdal.SetConfigOption("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
cfg = yaml.safe_load(open(args.sources))
COUNTRIES = [c.upper() for c in (args.countries.split(",") if args.countries else cfg["countries"])]
ONLY = set(args.only.split(",")) if args.only else None
API = args.api.rstrip("/")
NOW = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
HTTP = requests.Session()
HTTP.headers["User-Agent"] = "geo-training-stack/1.0"  # HDX rejects agents containing "harvester"
os.makedirs(args.cache, exist_ok=True)


def log(*a):
    print(*a, flush=True)


def get_json(url, **kw):
    for attempt in range(4):
        try:
            r = HTTP.get(url, timeout=60, **kw)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json()
        except requests.RequestException:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


# ---------------- country outlines ----------------

def gb_meta(iso, level):
    return get_json(f"https://www.geoboundaries.org/api/current/gbOpen/{iso}/{level}/")


def country_shape(iso):
    """Simplified ADM0 outline from geoBoundaries, cached."""
    path = os.path.join(args.cache, f"{iso}.geojson")
    if not os.path.exists(path):
        meta = gb_meta(iso, "ADM0")
        if not meta:
            raise SystemExit(f"geoBoundaries has no ADM0 for {iso}")
        gj = HTTP.get(meta["simplifiedGeometryGeoJSON"], timeout=120).json()
        geom = unary_union([shape(f["geometry"]) for f in gj["features"]]).buffer(0).simplify(0.02)
        json.dump(mapping(geom), open(path, "w"))
    return shape(json.load(open(path)))


# ---------------- writing ----------------

def ensure_collection(c, bbox):
    body = {
        "type": "Collection", "stac_version": "1.0.0", "id": c["id"], "title": c["title"],
        "description": c.get("description", c["title"]), "license": c.get("license", "other"),
        "keywords": c.get("keywords", []), "links": [],
        "extent": {"spatial": {"bbox": [list(bbox)]}, "temporal": {"interval": [[None, None]]}},
    }
    if args.dry_run:
        return
    r = HTTP.post(f"{API}/collections", json=body, timeout=60)
    if r.status_code == 409:
        r = HTTP.put(f"{API}/collections/{c['id']}", json=body, timeout=60)
    r.raise_for_status()


def upsert(cid, items):
    items = list({i["id"]: i for i in items}.values())
    if args.dry_run or not items:
        return len(items)
    for i in range(0, len(items), 500):
        chunk = {it["id"]: {**it, "collection": cid} for it in items[i:i + 500]}
        r = HTTP.post(f"{API}/collections/{cid}/bulk_items", json={"items": chunk, "method": "upsert"}, timeout=300)
        if r.status_code >= 400:
            raise SystemExit(f"{cid}: bulk upsert failed {r.status_code}: {r.text[:500]}")
    return len(items)


def item(iid, geom, assets, props=None):
    g = geom if isinstance(geom, dict) else mapping(geom)
    bounds = shape(g).bounds
    return {"type": "Feature", "stac_version": "1.0.0", "id": iid, "geometry": g, "bbox": list(bounds),
            "properties": {"datetime": NOW, **(props or {})}, "assets": assets, "links": []}


def is_gpkg_member(name):
    return name.lower().endswith(".gpkg")


def zip_member(url):
    """Name of the GeoPackage inside a remote zip (one ranged read of the zip directory)."""
    try:
        names = gdal.ReadDir(f"/vsizip//vsicurl/{url}") or []
    except RuntimeError:
        return None
    return next((n for n in names if is_gpkg_member(n)), None)


# ---------------- source kinds ----------------

def harvest_stac_mirror(c, region):
    cat = Client.open(c["source"])
    keep = c.get("assets")
    rules = [(re.compile(a), b) for a, b in c.get("rewrite", [])]
    out = {}
    for iso in COUNTRIES:
        geom = country_shape(iso)
        search = cat.search(collections=[c["remote_collection"]], intersects=mapping(geom.simplify(0.1)), limit=500)
        for it in search.items_as_dicts():
            if it["id"] in out:
                continue
            assets = {}
            for k, a in it["assets"].items():
                if keep and k not in keep:
                    continue
                href = a["href"]
                for rx, rep in rules:
                    href = rx.sub(rep, href)
                if href.startswith("s3://"):
                    bucket, _, key = href[5:].partition("/")
                    href = f"https://{bucket}.s3.amazonaws.com/{key}"
                assets[k] = {kk: vv for kk, vv in {**a, "href": href}.items() if not kk.startswith("alternate")}
            if assets:
                out[it["id"]] = {**it, "assets": assets, "links": []}
        log(f"  {c['id']} {iso}: {len(out)} items so far")
    return list(out.values())


def harvest_tile_grid(c, region):
    step = c["tile_degrees"]
    items = []
    minx, miny, maxx, maxy = region.bounds
    for lon in range(int(math.floor(minx / step) * step), int(math.ceil(maxx / step) * step), step):
        for top in range(int(math.ceil(maxy / step) * step), int(math.floor(miny / step) * step), -step):
            tile = box(lon, top - step, lon + step, top)
            if not tile.intersects(region):
                continue
            lon_s = f"{abs(lon)}{'E' if lon >= 0 else 'W'}"
            lat_s = f"{abs(top)}{'N' if top >= 0 else 'S'}"
            assets = {k: {"href": u.format(lon=lon_s, lat=lat_s), "type": "image/tiff; application=geotiff",
                          "roles": ["data"], "title": k} for k, u in c["assets"].items()}
            items.append(item(f"{lon_s}_{lat_s}", tile, assets))
    return items


def harvest_global(c, region):
    return [item(e["id"], region.envelope, {"data": {
        "href": c["asset"].format(id=e["id"]), "type": "image/tiff; application=geotiff",
        "roles": ["data"], "title": e["title"]}}, {"title": e["title"]}) for e in c["items"]]


def harvest_geoboundaries(c, region):
    def one(iso_level):
        iso, level = iso_level
        meta = gb_meta(iso, level)
        if not meta:
            return None
        return item(f"{iso}-{level}", country_shape(iso), {"data": {
            "href": meta["gjDownloadURL"], "type": "application/geo+json", "roles": ["data"],
            "title": f"{meta.get('boundaryName', iso)} {level}"}},
            {"title": f"{meta.get('boundaryName', iso)} {level}", "country": iso, "admin_level": level,
             "source_year": meta.get("boundaryYearRepresented")})
    jobs = [(iso, lv) for iso in COUNTRIES for lv in c.get("levels", ["ADM0", "ADM1", "ADM2"])]
    with cf.ThreadPoolExecutor(8) as ex:
        return [i for i in ex.map(one, jobs) if i]


def hdx_package(name):
    d = get_json("https://data.humdata.org/api/3/action/package_show", params={"id": name})
    return d["result"] if d and d.get("success") else None


def harvest_hdx_hot(c, region):
    themes = c.get("themes") or [c["theme"]]

    def one(iso):
        assets, updated = {}, None
        for theme in themes:
            pkg = hdx_package(f"hotosm_{iso.lower()}_{theme}")
            if not pkg:
                continue
            updated = max(filter(None, [updated, pkg.get("last_modified")]), default=None)
            for res in pkg["resources"]:
                if res.get("format") != "Geopackage":
                    continue
                url = res["url"]
                # .../ISO3/PAK/roads/lines/hotosm_pak_roads_lines_gpkg.zip -> geometry type "lines"
                parts = url.split("/")
                geom_type = parts[-2] if parts[-2] in ("points", "lines", "polygons") else None
                member = zip_member(url)
                if not member:
                    continue
                key = "_".join(filter(None, [theme if len(themes) > 1 else None, geom_type])) or "data"
                assets[key] = {"href": f"{url}#{member}", "type": "application/geopackage+sqlite3",
                               "roles": ["data"], "title": key.replace("_", " "),
                               "file:size": res.get("size")}
        if not assets:
            return None
        return item(f"{iso}", country_shape(iso), assets, {"title": f"{c['title']} {iso}", "country": iso,
                                                           "source_updated": updated})
    with cf.ThreadPoolExecutor(6) as ex:
        return [i for i in ex.map(one, COUNTRIES) if i]


def harvest_hdx_csv(c, region):
    pkg = hdx_package(c["dataset"])
    items = []
    for res in pkg["resources"]:
        if res.get("format", "").upper() != "CSV":
            continue
        fname = res["url"].rsplit("/", 1)[-1].lower()
        isos = [t.upper() for t in re.findall(r"[a-z]{3}", fname.split("_relative")[0])]
        for iso in isos:
            if iso in COUNTRIES:
                items.append(item(iso, country_shape(iso), {"data": {
                    "href": res["url"], "type": "text/csv", "roles": ["data"], "title": res.get("name", iso)}},
                    {"title": f"{c['title']} {iso}", "country": iso}))
    return items


KINDS = {"stac-mirror": harvest_stac_mirror, "tile-grid": harvest_tile_grid, "global": harvest_global,
         "geoboundaries": harvest_geoboundaries, "hdx-hot": harvest_hdx_hot, "hdx-csv": harvest_hdx_csv}


def main():
    log(f"countries: {len(COUNTRIES)}; loading outlines")
    with cf.ThreadPoolExecutor(8) as ex:
        shapes = list(ex.map(country_shape, COUNTRIES))
    region = unary_union(shapes)
    failed = []
    for c in cfg["collections"]:
        if ONLY and c["id"] not in ONLY:
            continue
        t = time.time()
        log(f"{c['id']} ({c['kind']})")
        try:
            items = KINDS[c["kind"]](c, region)
            ensure_collection(c, region.bounds)
            n = upsert(c["id"], items)
            log(f"  -> {n} items in {time.time() - t:.0f}s")
        except Exception as e:  # keep going; report at the end
            log(f"  !! {c['id']} failed: {e}")
            failed.append(c["id"])
    if failed:
        log("FAILED:", ", ".join(failed))
        sys.exit(1)


main()
