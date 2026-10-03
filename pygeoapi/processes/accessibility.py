"""Accessibility: distance to nearest facility and population within / beyond a limit."""
import numpy as np
from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError

from . import mcda
from .common import grid_bbox_wgs84, load_aoi, new_output, read_source
from .osm import fetch_osm
from .zonal_stats import load_zones

PROCESS_METADATA = {
    "version": "0.1.0",
    "id": "accessibility",
    "title": "Accessibility to facilities",
    "description": (
        "Distance from every cell to the nearest facility (school, clinic, water point, market) "
        "and, with a population raster, how many people live within and beyond the limit."),
    "jobControlOptions": ["sync-execute", "async-execute"],
    "keywords": ["accessibility", "catchment", "health", "education", "WASH"],
    "inputs": {
        "aoi": {"title": "Area of interest", "schema": {"oneOf": [{"type": "array"}, {"type": "object"},
                                                                 {"type": "string"}]}},
        "facilities": {"title": "Facilities: GeoJSON, vector ref, or {\"osm\": \"health\"}", "schema": {"oneOf": [{"type": "object"},
                                                                           {"type": "string"}]}},
        "population": {"title": "Population raster ref or collection source (e.g. WorldPop)",
                       "schema": {"oneOf": [{"type": "string"}, {"type": "object"}]},
                       "minOccurs": 0},
        "limit_m": {"title": "Distance limit in metres", "schema": {"type": "number", "default": 5000}},
        "resolution": {"title": "Cell size in metres (not finer than the population raster)", "schema": {"type": "number", "default": 100}},
    },
    "outputs": {"result": {"title": "Accessibility summary",
                           "schema": {"type": "object", "contentMediaType": "application/json"}}},
}


def run_accessibility(data: dict) -> dict:
    aoi = load_aoi(data["aoi"])
    grid = mcda.build_grid(aoi, float(data.get("resolution", 100)))
    inside = mcda.aoi_mask(aoi, grid)
    fac = data["facilities"]
    gdf = fetch_osm(fac["osm"], grid_bbox_wgs84(grid)) if isinstance(fac, dict) and "osm" in fac \
        else load_zones(fac)
    dist = mcda.distance_to_features(gdf, grid)
    limit = float(data.get("limit_m", 5000))

    path, url = new_output("distance", "tif")
    mcda.write_cog(path, np.ma.array(dist, mask=~inside), grid)
    out = {"distance_raster": url, "limit_m": limit,
           "max_distance_m": float(dist[inside].max()) if inside.any() else None,
           "area_beyond_share": float((dist[inside] > limit).mean()) if inside.any() else None}
    if data.get("population"):
        src = data["population"]
        src = {**src, "counts": True} if isinstance(src, dict) else {"raster": src, "counts": True}
        pop = read_source(src, grid)
        pop = np.ma.array(pop, mask=np.ma.getmaskarray(pop) | ~inside)
        out["population"] = mcda.population_beyond(pop, dist, limit)
    return out


class AccessibilityProcessor(BaseProcessor):
    def __init__(self, processor_def):
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data, outputs=None):
        try:
            return "application/json", run_accessibility(data)
        except (mcda.MCDAError, KeyError) as e:
            raise ProcessorExecuteError(str(e))

    def __repr__(self):
        return "<AccessibilityProcessor>"
