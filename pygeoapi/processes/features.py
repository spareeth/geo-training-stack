"""Return a vector dataset (catalogue ref, server path or URL) as GeoJSON for the map,
optionally clipped to an area. Lets the browser show data stored in MinIO or on disk."""
import json

from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError

from . import mcda
from .common import load_aoi
from .zonal_stats import load_zones

MAX_FEATURES = 50_000

PROCESS_METADATA = {
    "version": "0.1.0", "id": "features", "title": "Get features",
    "description": "Load a vector dataset as GeoJSON (WGS 84), optionally clipped to an area.",
    "jobControlOptions": ["sync-execute"],
    "keywords": ["vector", "data access"],
    "inputs": {
        "source": {"title": "Vector ref, path or URL", "schema": {"type": "string"}},
        "aoi": {"title": "Optional clip area", "schema": {"oneOf": [{"type": "array"}, {"type": "object"}]},
                "minOccurs": 0},
    },
    "outputs": {"result": {"title": "Features", "schema": {"type": "object", "contentMediaType": "application/geo+json"}}},
}


def run_features(data: dict) -> dict:
    gdf = load_zones(data["source"])
    if gdf.crs is not None:
        gdf = gdf.to_crs(4326)
    if data.get("aoi"):
        gdf = gdf.clip(load_aoi(data["aoi"]))
    if len(gdf) > MAX_FEATURES:
        raise mcda.MCDAError(f"{len(gdf)} features; zoom in or draw an area to clip (limit {MAX_FEATURES})")
    return json.loads(gdf.to_json(drop_id=True))


class FeaturesProcessor(BaseProcessor):
    def __init__(self, processor_def):
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data, outputs=None):
        try:
            return "application/geo+json", run_features(data)
        except (mcda.MCDAError, KeyError) as e:
            raise ProcessorExecuteError(str(e))

    def __repr__(self):
        return "<FeaturesProcessor>"
