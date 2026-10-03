"""Multi-criteria suitability (weighted overlay with optional AHP) as an OGC API Process."""
import json

import numpy as np
from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError

from . import mcda
from .common import constraint_mask, criterion_values, load_aoi, new_output

PROCESS_METADATA = {
    "version": "0.1.0",
    "id": "suitability",
    "title": "Multi-criteria suitability",
    "description": (
        "Score each criterion 0 to 1, combine with weights (or an AHP matrix), remove excluded "
        "areas, and return a suitability raster plus the best candidate sites."),
    "jobControlOptions": ["sync-execute", "async-execute"],
    "keywords": ["suitability", "MCDA", "AHP", "site selection"],
    "inputs": {
        "aoi": {"title": "Area of interest (bbox, GeoJSON or vector ref)",
                "schema": {"oneOf": [{"type": "array"}, {"type": "object"}, {"type": "string"}]}},
        "resolution": {"title": "Cell size in metres", "schema": {"type": "number", "default": 100}},
        "criteria": {"title": "Criteria: [{name, source, rule, weight}]", "schema": {"type": "array"}},
        "ahp": {"title": "Optional AHP pairwise matrix (overrides weights)", "schema": {"type": "array"},
                "minOccurs": 0},
        "constraints": {"title": "Exclusions", "schema": {"type": "array"}, "minOccurs": 0},
        "threshold": {"title": "Score for candidate sites", "schema": {"type": "number", "default": 0.7}},
        "min_area_ha": {"title": "Minimum site area (ha)", "schema": {"type": "number", "default": 0}},
        "top_n": {"title": "Number of sites", "schema": {"type": "integer", "default": 10}},
    },
    "outputs": {"result": {"title": "Suitability summary",
                           "schema": {"type": "object", "contentMediaType": "application/json"}}},
    "example": {"inputs": {
        "aoi": [55.0, 24.8, 55.4, 25.1], "resolution": 100,
        "criteria": [
            {"name": "slope", "source": {"raster": "cop-dem-glo-30/item", "derive": "slope"},
             "rule": {"type": "linear", "min": 0, "max": 15, "direction": "lower"}, "weight": 2},
            {"name": "road distance", "source": {"vector": "/data/roads.fgb", "derive": "distance"},
             "rule": {"type": "linear", "min": 0, "max": 5000, "direction": "lower"}, "weight": 1}],
        "constraints": [{"vector": "/data/protected_areas.fgb"}],
        "threshold": 0.7, "min_area_ha": 5}},
}


def run_suitability(data: dict) -> dict:
    criteria = data.get("criteria") or []
    if not criteria:
        raise mcda.MCDAError("at least one criterion is required")
    aoi = load_aoi(data["aoi"])
    grid = mcda.build_grid(aoi, float(data.get("resolution", 100)))

    cr = None
    if data.get("ahp"):
        weights, cr = mcda.ahp_weights(data["ahp"])
        if len(weights) != len(criteria):
            raise mcda.MCDAError("AHP matrix size must equal the number of criteria")
    else:
        weights = mcda.normalise_weights([c.get("weight", 1) for c in criteria])

    scores, summary = [], []
    for c, w in zip(criteria, weights):
        vals = criterion_values(c["source"], grid)
        s = np.ma.array(mcda.score(vals.filled(np.nan), c["rule"]), mask=np.ma.getmaskarray(vals))
        scores.append(s)
        summary.append({"name": c.get("name", "criterion"), "weight": round(float(w), 4),
                        "mean_score": float(s.mean()) if s.count() else None})

    exclude = ~mcda.aoi_mask(aoi, grid)
    for con in data.get("constraints") or []:
        exclude |= constraint_mask(con, grid)

    suit = mcda.weighted_overlay(scores, weights, exclude)
    raster_path, raster_url = new_output("suitability", "tif")
    mcda.write_cog(raster_path, suit, grid)

    sites = mcda.top_sites(suit, grid, float(data.get("threshold", 0.7)),
                           float(data.get("min_area_ha", 0)) * 10_000, int(data.get("top_n", 10)))
    valid = suit.count()
    return {
        "suitability_raster": raster_url,
        "grid": {"crs": grid.crs.to_string(), "resolution_m": grid.resolution,
                 "width": grid.width, "height": grid.height},
        "criteria": summary,
        "ahp_consistency_ratio": cr,
        "ahp_consistent": None if cr is None else cr < 0.10,
        "excluded_share": float(1 - valid / suit.size),
        "score_stats": {"min": float(suit.min()), "mean": float(suit.mean()), "max": float(suit.max())}
        if valid else None,
        "sites": json.loads(sites.to_json(drop_id=True)),
    }


class SuitabilityProcessor(BaseProcessor):
    def __init__(self, processor_def):
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data, outputs=None):
        try:
            return "application/json", run_suitability(data)
        except (mcda.MCDAError, KeyError) as e:
            raise ProcessorExecuteError(str(e))

    def __repr__(self):
        return "<SuitabilityProcessor>"
