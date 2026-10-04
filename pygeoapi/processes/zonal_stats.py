"""Zonal statistics as an OGC API Process (pygeoapi plugin).

Inputs:
  raster  - STAC item id ("collection/item[/asset]"), an s3:// or https:// COG URL,
            or a path under /data.
  zones   - GeoJSON FeatureCollection (inline), or a vector URL/path readable by GeoPandas.
  stats   - list of exactextract operations, default ["mean", "min", "max", "count"].
Output: GeoJSON FeatureCollection, zone attributes plus one column per statistic.
"""
import json
import os
import re

import geopandas as gpd
import rasterio
from exactextract import exact_extract
from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError

ALLOWED_STATS = {
    "mean", "min", "max", "sum", "count", "median", "stdev", "variance",
    "majority", "minority", "variety", "mode", "coverage",
}
DEFAULT_STATS = ["mean", "min", "max", "count"]
MAX_ZONES = 50_000
# Local directories trainees may read from. Anything else on the server is off limits.
DATA_ROOTS = [r for r in os.environ.get("DATA_ROOTS", "/data/,/outputs/").split(",") if r]


def is_local_allowed(ref: str) -> bool:
    path = os.path.realpath(ref)
    return any(path.startswith(os.path.realpath(root) + os.sep) for root in DATA_ROOTS)

PROCESS_METADATA = {
    "version": "0.1.0",
    "id": "zonal-statistics",
    "title": "Zonal statistics",
    "description": "Summarise raster values inside each polygon, computed on the server.",
    "jobControlOptions": ["sync-execute", "async-execute"],
    "keywords": ["zonal statistics", "raster"],
    "inputs": {
        "raster": {"title": "Raster", "schema": {"type": "string"}, "minOccurs": 1, "maxOccurs": 1},
        "zones": {"title": "Zones", "schema": {"oneOf": [{"type": "string"}, {"type": "object"}]},
                  "minOccurs": 1, "maxOccurs": 1},
        "stats": {"title": "Statistics", "schema": {"type": "array", "items": {"type": "string"}},
                  "minOccurs": 0, "maxOccurs": 1},
        "band": {"title": "Band (1-based)", "schema": {"type": "integer"}, "minOccurs": 0, "maxOccurs": 1},
    },
    "outputs": {
        "result": {"title": "Zones with statistics",
                   "schema": {"type": "object", "contentMediaType": "application/geo+json"}},
    },
    "example": {"inputs": {"raster": "landcover/2024/data", "zones": "/data/districts.geojson",
                           "stats": ["mean", "max"]}},
}


def is_catalogue_ref(ref: str) -> bool:
    return not ref.startswith(("/", "s3://", "http://", "https://", "{")) and len(ref.split("/")) in (2, 3)


def area_hrefs(collection: str, bbox) -> list[str]:
    """Asset hrefs of every catalogue item in a collection that overlaps bbox: for collections
    split into many files (e.g. Overture GeoParquet), referenced as "collection/*"."""
    if bbox is None:
        raise ProcessorExecuteError(f"{collection}/* covers large areas: give an area (current view or drawn shape)")
    from pystac_client import Client

    items = Client.open(os.environ["STAC_API_URL"]).search(collections=[collection], bbox=list(bbox), max_items=50)
    hrefs = [next(iter(i.assets.values())).href for i in items.items() if i.assets]
    if not hrefs:
        raise ProcessorExecuteError(f"no {collection} data covers this area")
    return hrefs


def catalogue_href(ref: str) -> str:
    """Asset href for a course catalogue reference "collection/item[/asset]"."""
    parts = ref.split("/")
    from pystac_client import Client

    item = Client.open(os.environ["STAC_API_URL"]).get_collection(parts[0]).get_item(parts[1])
    if item is None:
        raise ProcessorExecuteError(f"STAC item not found: {ref}")
    asset_key = parts[2] if len(parts) == 3 else next(iter(item.assets))
    if asset_key not in item.assets:
        raise ProcessorExecuteError(f"{ref}: no asset {asset_key!r} (has {', '.join(item.assets)})")
    return item.assets[asset_key].href


MOSAIC_REF = re.compile(r"^([A-Za-z0-9_.-]+)/\*(?:/([A-Za-z0-9_.-]+))?$")


def gdal_path(href: str) -> str:
    if href.startswith("s3://"):
        return "/vsis3/" + href[5:]
    if href.startswith(("http://", "https://")):
        return "/vsicurl/" + href
    return href


def mosaic_href(ref: str, bbox) -> str:
    """'collection/*[/asset]': a GDAL VRT over every catalogue item of the collection that overlaps
    bbox, so an analysis area spanning several tiles (e.g. 1-degree DEM tiles) reads as one raster."""
    coll, asset = MOSAIC_REF.match(ref).groups()
    if bbox is None:
        raise ProcessorExecuteError(f"{ref} needs an area (current view, drawn shape or zones)")
    from osgeo import gdal
    from pystac_client import Client

    items = list(Client.open(os.environ["STAC_API_URL"]).search(collections=[coll], bbox=list(bbox), max_items=200).items())
    hrefs = [(i.assets.get(asset) if asset else next(iter(i.assets.values()), None)) for i in items]
    paths = [gdal_path(a.href) for a in hrefs if a is not None]
    if not paths:
        raise ProcessorExecuteError(f"no {coll} data covers this area")
    if len(paths) == 1:
        return paths[0]
    import tempfile
    vrt = tempfile.NamedTemporaryFile(suffix=".vrt", delete=False).name
    gdal.UseExceptions()
    try:
        ds = gdal.BuildVRT(vrt, paths)
        ds = None  # noqa: F841  (flush to disk)
    except RuntimeError as e:
        raise ProcessorExecuteError(f"{coll}: tiles cannot be mosaicked ({e}); pick a single item instead")
    return vrt


def resolve_raster(ref: str, bbox=None) -> str:
    """Turn a STAC reference, URL or local path into a GDAL-readable href. 'collection/*' is a
    mosaic of the collection's items over bbox (WGS 84)."""
    if MOSAIC_REF.match(ref):
        return mosaic_href(ref, bbox)
    base = os.environ.get("OUTPUT_BASE_URL", "").rstrip("/")
    if base and ref.startswith(base + "/"):
        # Our own earlier output: read it from disk instead of through the auth proxy.
        ref = os.path.join(os.environ.get("OUTPUT_DIR", "/outputs"), ref[len(base) + 1:])
    if ref.startswith(("s3://", "http://", "https://")):
        return ref if not ref.startswith("s3://") else "/vsis3/" + ref[5:]
    if ref.startswith("/"):
        if not is_local_allowed(ref):
            raise ProcessorExecuteError("local paths must be under " + ", ".join(DATA_ROOTS))
        return ref
    if not is_catalogue_ref(ref):
        raise ProcessorExecuteError("raster must be collection/item[/asset], a URL, or a local data path")
    href = catalogue_href(ref)
    return "/vsis3/" + href[5:] if href.startswith("s3://") else href


def vector_path(href: str) -> tuple[str, dict]:
    """GDAL path and open options for a vector href. "x.zip#member.gpkg" reads one file inside a
    (remote) zip; remote files use ranged reads so only the needed part is downloaded; CSVs with
    latitude/longitude columns open as points."""
    member = None
    if "#" in href:
        href, member = href.split("#", 1)
    remote = href.startswith(("http://", "https://"))
    path = f"/vsicurl/{href}" if remote else href
    if href.lower().endswith(".zip"):
        path = f"/vsizip/{path}" + (f"/{member}" if member else "")
    opts = {}
    if href.lower().endswith(".csv"):
        opts = {"X_POSSIBLE_NAMES": "longitude,lon,x", "Y_POSSIBLE_NAMES": "latitude,lat,y",
                "KEEP_GEOM_COLUMNS": "NO", "AUTODETECT_TYPE": "YES"}
    return path, opts


def read_vector(href: str, bbox=None) -> gpd.GeoDataFrame:
    """Read a vector href, only the part inside bbox (WGS 84) when given."""
    import pyogrio

    from .vector_cache import local_copy

    if href.split("?")[0].lower().endswith(".parquet"):
        from .geoparquet import read_geoparquet
        try:
            return read_geoparquet([href], bbox, max_features=MAX_ZONES)
        except (OSError, ValueError) as e:
            raise ProcessorExecuteError(f"could not read {href}: {e}")
    if href.startswith(("http://", "https://")):
        # Remote vector files are read from a local copy (see vector_cache).
        url, _, member = href.partition("#")
        try:
            href = local_copy(url, member or None)
        except Exception as e:
            raise ProcessorExecuteError(f"could not download {url}: {e}")
    path, opts = vector_path(href)
    try:
        info = pyogrio.read_info(path, **opts)
        kw = {}
        if bbox is not None:
            crs = info.get("crs")
            if crs and crs.upper() not in ("EPSG:4326", "OGC:CRS84"):
                from pyproj import Transformer
                bbox = Transformer.from_crs(4326, crs, always_xy=True).transform_bounds(*bbox)
            kw["bbox"] = tuple(bbox)
        gdf = pyogrio.read_dataframe(path, max_features=MAX_ZONES + 1, **kw, **opts)
    except (pyogrio.errors.DataSourceError, pyogrio.errors.DataLayerError) as e:
        raise ProcessorExecuteError(f"could not read {href}: {e}")
    if gdf.crs is None and opts:
        gdf = gdf.set_crs(4326)
    return gdf


def load_zones(zones, bbox=None) -> gpd.GeoDataFrame:
    """Vector input as a GeoDataFrame: inline GeoJSON, a catalogue ref, a URL or an allowed path.
    bbox (WGS 84) limits reading to an area, which matters for country-wide files."""
    if isinstance(zones, dict):
        if not zones.get("features"):
            raise ProcessorExecuteError("zones contain no features")
        gdf = gpd.GeoDataFrame.from_features(zones["features"], crs="EPSG:4326")
    elif isinstance(zones, str) and zones.lstrip().startswith("{"):
        return load_zones(json.loads(zones), bbox)
    elif isinstance(zones, str) and zones.startswith(("http://", "https://")):
        gdf = read_vector(zones, bbox)
    elif isinstance(zones, str) and zones.startswith("/"):
        if not is_local_allowed(zones.split("#", 1)[0]):
            raise ProcessorExecuteError("local paths must be under " + ", ".join(DATA_ROOTS))
        gdf = read_vector(zones, bbox)
    elif isinstance(zones, str) and zones.endswith("/*") and is_catalogue_ref(zones):
        hrefs = area_hrefs(zones[:-2], bbox)
        if all(h.split("?")[0].lower().endswith(".parquet") for h in hrefs):
            from .geoparquet import read_geoparquet
            gdf = read_geoparquet(hrefs, bbox, max_features=MAX_ZONES)
        else:
            import pandas as pd
            gdf = gpd.GeoDataFrame(pd.concat([read_vector(h, bbox).to_crs(4326) for h in hrefs], ignore_index=True), crs=4326)
    elif isinstance(zones, str) and is_catalogue_ref(zones):
        gdf = read_vector(catalogue_href(zones), bbox)
    else:
        raise ProcessorExecuteError("zones must be GeoJSON, a catalogue ref (collection/item[/asset]), a URL, "
                                    "or a path under " + ", ".join(DATA_ROOTS))
    if gdf.empty:
        raise ProcessorExecuteError("zones contain no features")
    if len(gdf) > MAX_ZONES:
        raise ProcessorExecuteError(f"too many features (over {MAX_ZONES}); zoom in or draw a smaller area")
    return gdf


def zonal_stats(raster_href: str, zones: gpd.GeoDataFrame, stats: list[str], band: int = 1) -> dict:
    bad = set(stats) - ALLOWED_STATS
    if bad:
        raise ProcessorExecuteError(f"unsupported statistics: {sorted(bad)}")
    with rasterio.open(raster_href) as src:
        if not 1 <= band <= src.count:
            raise ProcessorExecuteError(f"band must be between 1 and {src.count}")
        multiband = src.count > 1
        zones_r = zones.to_crs(src.crs) if zones.crs and src.crs and zones.crs != src.crs else zones
        result = exact_extract(src, zones_r, stats, output="pandas")
    if multiband:
        prefix = f"band_{band}_"
        result = result[[c for c in result.columns if c.startswith(prefix)]]
        result.columns = [c[len(prefix):] for c in result.columns]
    result.index = zones.index
    out = zones.drop(columns=[c for c in stats if c in zones.columns]).join(result)
    return json.loads(out.to_crs("EPSG:4326").to_json(drop_id=True))


class ZonalStatsProcessor(BaseProcessor):
    def __init__(self, processor_def):
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data, outputs=None):
        if "raster" not in data or "zones" not in data:
            raise ProcessorExecuteError("inputs 'raster' and 'zones' are required")
        zones = load_zones(data["zones"])
        href = resolve_raster(data["raster"], tuple(zones.to_crs(4326).total_bounds))
        result = zonal_stats(href, zones, data.get("stats") or DEFAULT_STATS, int(data.get("band", 1)))
        return "application/geo+json", result

    def __repr__(self):
        return "<ZonalStatsProcessor>"
