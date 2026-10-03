"""Buffer screening: buffer a project line/point and summarise layers inside the buffer.
Built for road corridor and site screening (flood, land cover, forest loss, population)."""
import geopandas as gpd
import numpy as np
from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError

from . import mcda
from .common import criterion_values
from .zonal_stats import load_zones

PROCESS_METADATA = {
    "version": "0.1.0",
    "id": "buffer-screen",
    "title": "Buffer screening",
    "description": (
        "Buffer a road, pipeline or site by a distance in metres and report what lies inside: "
        "class shares for categorical layers (land cover, flood zones) and statistics for "
        "continuous ones (population sum, rainfall mean, slope max)."),
    "jobControlOptions": ["sync-execute", "async-execute"],
    "keywords": ["buffer", "corridor", "screening", "safeguards"],
    "inputs": {
        "features": {"title": "Project features", "schema": {"oneOf": [{"type": "object"}, {"type": "string"}]}},
        "distance_m": {"title": "Buffer distance in metres", "schema": {"type": "number", "default": 1000}},
        "layers": {"title": "[{name, raster | collection+catalog+asset, categorical, counts, stats, class_names}]",
                   "schema": {"type": "array"}},
        "resolution": {"title": "Cell size in metres", "schema": {"type": "number", "default": 30}},
    },
    "outputs": {"result": {"title": "Screening report",
                           "schema": {"type": "object", "contentMediaType": "application/json"}}},
}


def buffer_metric(gdf: gpd.GeoDataFrame, distance_m: float) -> gpd.GeoDataFrame:
    """Buffer in a local metric CRS, dissolved into one corridor polygon."""
    if distance_m <= 0:
        raise mcda.MCDAError("distance_m must be positive")
    utm = gdf.estimate_utm_crs()
    buf = gdf.to_crs(utm).buffer(distance_m).union_all()
    return gpd.GeoDataFrame({"area_ha": [buf.area / 10_000]}, geometry=[buf], crs=utm)


STATS = {"mean": np.ma.mean, "min": np.ma.min, "max": np.ma.max, "sum": np.ma.sum,
         "median": np.ma.median, "std": np.ma.std}


def screen_layer(layer: dict, zone: gpd.GeoDataFrame, grid: mcda.Grid, inside: np.ndarray) -> dict:
    source = {k: v for k, v in layer.items() if k in ("raster", "collection", "catalog", "asset", "band",
                                                       "categorical", "counts", "datetime", "derive")}
    vals = criterion_values(source, grid)
    vals = np.ma.array(vals, mask=np.ma.getmaskarray(vals) | ~inside)
    if vals.count() == 0:
        return {"note": "no data inside the buffer"}
    if layer.get("categorical"):
        codes, n = np.unique(vals.compressed(), return_counts=True)
        names = {str(k): v for k, v in (layer.get("class_names") or {}).items()}
        shares = [{"class": names.get(str(int(c)), str(int(c))), "share": round(float(k / n.sum()), 4),
                   "area_ha": round(float(k * grid.resolution ** 2 / 10_000), 2)}
                  for c, k in zip(codes, n)]
        return {"class_shares": sorted(shares, key=lambda d: -d["share"])}
    stats = layer.get("stats") or ["mean", "max"]
    bad = set(stats) - set(STATS)
    if bad:
        raise mcda.MCDAError(f"unsupported statistics: {sorted(bad)}")
    return {s: float(STATS[s](vals)) for s in stats}


def run_buffer_screen(data: dict) -> dict:
    zone = buffer_metric(load_zones(data["features"]), float(data.get("distance_m", 1000)))
    grid = mcda.build_grid(zone, float(data.get("resolution", 30)))
    inside = mcda.aoi_mask(zone, grid)
    report = {"buffer_m": float(data.get("distance_m", 1000)),
              "area_ha": round(float(zone["area_ha"].iloc[0]), 2), "layers": []}
    for layer in data.get("layers") or []:
        name = layer.get("name") or layer.get("raster") or layer.get("collection")
        report["layers"].append({"name": name, **screen_layer(layer, zone, grid, inside)})
    report["buffer"] = zone.to_crs("EPSG:4326").geometry.iloc[0].__geo_interface__
    return report


class BufferScreenProcessor(BaseProcessor):
    def __init__(self, processor_def):
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data, outputs=None):
        try:
            return "application/json", run_buffer_screen(data)
        except (mcda.MCDAError, KeyError) as e:
            raise ProcessorExecuteError(str(e))

    def __repr__(self):
        return "<BufferScreenProcessor>"
