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


def resolve_raster(ref: str) -> str:
    """Turn a STAC reference, URL or local path into a GDAL-readable href."""
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
    parts = ref.split("/")
    if len(parts) not in (2, 3):
        raise ProcessorExecuteError("raster must be collection/item[/asset], a URL, or a local data path")
    from pystac_client import Client

    item = Client.open(os.environ["STAC_API_URL"]).get_collection(parts[0]).get_item(parts[1])
    if item is None:
        raise ProcessorExecuteError(f"STAC item not found: {ref}")
    asset_key = parts[2] if len(parts) == 3 else next(iter(item.assets))
    href = item.assets[asset_key].href
    return "/vsis3/" + href[5:] if href.startswith("s3://") else href


def load_zones(zones) -> gpd.GeoDataFrame:
    if isinstance(zones, dict):
        if not zones.get("features"):
            raise ProcessorExecuteError("zones contain no features")
        gdf = gpd.GeoDataFrame.from_features(zones["features"], crs="EPSG:4326")
    elif isinstance(zones, str) and zones.lstrip().startswith("{"):
        return load_zones(json.loads(zones))
    elif isinstance(zones, str) and (zones.startswith(("http://", "https://")) or is_local_allowed(zones)):
        gdf = gpd.read_file(zones)
    else:
        raise ProcessorExecuteError("zones must be GeoJSON, a URL, or a path under " + ", ".join(DATA_ROOTS))
    if gdf.empty:
        raise ProcessorExecuteError("zones contain no features")
    if len(gdf) > MAX_ZONES:
        raise ProcessorExecuteError(f"too many zones ({len(gdf)}), limit is {MAX_ZONES}")
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
        href = resolve_raster(data["raster"])
        zones = load_zones(data["zones"])
        result = zonal_stats(href, zones, data.get("stats") or DEFAULT_STATS, int(data.get("band", 1)))
        return "application/geo+json", result

    def __repr__(self):
        return "<ZonalStatsProcessor>"
