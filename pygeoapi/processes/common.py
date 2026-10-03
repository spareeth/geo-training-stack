"""Shared input handling for the training processes: AOI, layer sources, outputs."""
import os
import uuid

import geopandas as gpd
import numpy as np
from pyproj import Transformer
from shapely.geometry import box

from . import mcda
from .osm import fetch_osm
from .zonal_stats import load_zones, resolve_raster

OUTPUT_DIR = os.environ.get("OUTPUT_DIR", "/outputs")
MAX_ITEMS = 200

# Catalogues a criterion may name. "local" is the course STAC catalogue.
CATALOGS = {
    "local": os.environ.get("STAC_API_URL", ""),
    "earth-search": "https://earth-search.aws.element84.com/v1",
    "planetary-computer": "https://planetarycomputer.microsoft.com/api/stac/v1",
}
OUTPUT_BASE_URL = os.environ.get("OUTPUT_BASE_URL", "")  # e.g. https://geo.example.org/outputs


def load_aoi(aoi) -> gpd.GeoDataFrame:
    """AOI as bbox [minx, miny, maxx, maxy] (WGS 84), inline GeoJSON, or a vector path/URL."""
    if isinstance(aoi, (list, tuple)) and len(aoi) == 4:
        return gpd.GeoDataFrame(geometry=[box(*map(float, aoi))], crs="EPSG:4326")
    return load_zones(aoi).dissolve()


def grid_bbox_wgs84(grid: mcda.Grid) -> tuple:
    t = grid.transform
    minx, maxy = t.c, t.f
    maxx, miny = minx + grid.width * t.a, maxy + grid.height * t.e
    return Transformer.from_crs(grid.crs, "EPSG:4326", always_xy=True).transform_bounds(minx, miny, maxx, maxy)


def collection_hrefs(source: dict, grid: mcda.Grid) -> list[str]:
    """Asset hrefs of every item in a STAC collection that touches the grid."""
    from pystac_client import Client

    url = CATALOGS.get(source.get("catalog", "local"))
    if not url:
        raise mcda.MCDAError(f"unknown catalog: {source.get('catalog')!r}")
    bbox = grid_bbox_wgs84(grid)
    modifier = None
    if source.get("catalog") == "planetary-computer":
        import planetary_computer
        modifier = planetary_computer.sign_inplace
    search = Client.open(url, modifier=modifier).search(
        collections=[source["collection"]], bbox=bbox, datetime=source.get("datetime"),
        max_items=MAX_ITEMS)
    items = list(search.items())
    if not items:
        raise mcda.MCDAError(f"no {source['collection']} data covers this area")
    asset = source.get("asset") or next(iter(items[0].assets))
    hrefs = [i.assets[asset].href for i in items if asset in i.assets]
    if source.get("catalog", "local") != "local":
        # External catalogues point at public AWS buckets; read them over HTTPS so no S3
        # credentials or endpoint settings are needed.
        hrefs = [public_https(h) for h in hrefs]
    return [resolve_raster(h) for h in hrefs]


def public_https(href: str) -> str:
    if href.startswith("s3://"):
        bucket, _, key = href[5:].partition("/")
        return f"https://{bucket}.s3.amazonaws.com/{key}"
    return href


def read_source(source: dict, grid: mcda.Grid) -> np.ma.MaskedArray:
    """Raster values on the grid from a single raster ref or a mosaic of a STAC collection."""
    band, categorical = int(source.get("band", 1)), bool(source.get("categorical"))
    counts = bool(source.get("counts"))
    if "collection" in source:
        out = None
        for href in collection_hrefs(source, grid):
            part = mcda.read_to_grid(href, grid, band, categorical, counts)
            out = part if out is None else np.ma.where(np.ma.getmaskarray(out), part, out)
        return out
    return mcda.read_to_grid(resolve_raster(source["raster"]), grid, band, categorical, counts)


def criterion_values(source: dict, grid: mcda.Grid) -> np.ma.MaskedArray:
    """Turn a criterion source into values on the grid.

    {"collection": id, "catalog": "local"|"earth-search"|"planetary-computer", "asset": key}
                                            mosaic of every item over the AOI (any raster
                                            option below also works with a collection)
    {"raster": ref}                         raw values (continuous)
    {"raster": ref, "categorical": true}    class codes, nearest neighbour
    {"raster": ref, "derive": "slope"}      slope in degrees from a DEM
    {"vector": ref, "derive": "distance"}   distance in metres to features
    {"osm": "schools"}                      distance in metres to OSM features, fetched for the AOI
    """
    if "osm" in source:
        return np.ma.asarray(mcda.distance_to_features(fetch_osm(source["osm"], grid_bbox_wgs84(grid)), grid))
    if "vector" in source:
        if source.get("derive", "distance") != "distance":
            raise mcda.MCDAError("vector sources support derive: distance only")
        return np.ma.asarray(mcda.distance_to_features(load_zones(source["vector"]), grid))
    if "raster" not in source and "collection" not in source:
        raise mcda.MCDAError("each source needs 'raster', 'collection' or 'vector'")
    vals = read_source(source, grid)
    if source.get("derive") == "slope":
        dy, dx = np.gradient(vals.filled(np.nan), grid.resolution)
        vals = np.ma.masked_invalid(np.degrees(np.arctan(np.hypot(dx, dy))))
    elif source.get("derive"):
        raise mcda.MCDAError(f"unknown derive for raster: {source['derive']!r}")
    return vals


def constraint_mask(c: dict, grid: mcda.Grid) -> np.ndarray:
    """True where a site is NOT allowed.

    {"vector": ref}                                 exclude inside polygons
    {"vector": ref, "within_m": 500}                exclude within 500 m of features
    {"osm": "rivers", "within_m": 100}              same, with OSM features for the AOI
    {"source": {...}, "op": ">", "value": 15}       exclude where value op threshold
    {"source": {...}, "classes": [80, 50]}          exclude these class codes
    """
    if "osm" in c and "source" not in c:
        if "within_m" not in c:
            raise mcda.MCDAError("OSM constraints need within_m")
        gdf = fetch_osm(c["osm"], grid_bbox_wgs84(grid))
        if gdf.empty:
            return np.zeros(grid.shape, bool)
        return mcda.distance_to_features(gdf, grid) <= float(c["within_m"])
    if "vector" in c and "source" not in c:
        gdf = load_zones(c["vector"])
        if "within_m" in c:
            return mcda.distance_to_features(gdf, grid) <= float(c["within_m"])
        return mcda.aoi_mask(gdf, grid)
    vals = criterion_values(c["source"], grid).filled(np.nan)
    if "classes" in c:
        return np.isin(vals, [float(x) for x in c["classes"]])
    ops = {">": np.greater, ">=": np.greater_equal, "<": np.less, "<=": np.less_equal, "==": np.equal}
    if c.get("op") not in ops:
        raise mcda.MCDAError("constraint op must be one of > >= < <= ==")
    with np.errstate(invalid="ignore"):
        return ops[c["op"]](vals, float(c["value"]))


def new_output(prefix: str, ext: str) -> tuple[str, str]:
    """Local path and public URL for a new output file."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    name = f"{prefix}-{uuid.uuid4().hex[:12]}.{ext}"
    return os.path.join(OUTPUT_DIR, name), f"{OUTPUT_BASE_URL.rstrip('/')}/{name}" if OUTPUT_BASE_URL else name
