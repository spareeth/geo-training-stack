"""MCP tools for the STAC GIS AI agent: browse sector presets, explain criteria, compute AHP
weights, and run the server-side analysis processes.

The model never does the maths. It picks layers and weights with the user, then calls these
tools, which run deterministic processes on the server and return reproducible results.
"""
import json
import os
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP

from processes import mcda

PROCESSES_URL = os.environ.get("PROCESSES_URL", "http://pygeoapi:80").rstrip("/")
STAC_API_URL = os.environ.get("STAC_API_URL", "").rstrip("/")
PRESETS_DIR = Path(os.environ.get("PRESETS_DIR", Path(__file__).parent / "presets"))
TIMEOUT = float(os.environ.get("PROCESS_TIMEOUT_S", "900"))

mcp = FastMCP("geida-analysis", host="0.0.0.0", port=int(os.environ.get("PORT", "8090")))


def load_presets() -> dict[str, dict]:
    return {p.stem: json.loads(p.read_text()) for p in sorted(PRESETS_DIR.glob("*.json"))}


def execute(process: str, inputs: dict) -> dict:
    r = httpx.post(f"{PROCESSES_URL}/processes/{process}/execution", json={"inputs": inputs},
                   timeout=TIMEOUT)
    if r.status_code >= 400:
        try:
            detail = r.json().get("description") or r.text
        except ValueError:
            detail = r.text
        return {"error": f"{process} failed: {detail}"}
    return r.json()


def merge_inputs(base: dict, overrides: dict | None) -> dict:
    """Shallow merge, plus per-criterion weight overrides by name: {"weights": {"Flat land": 5}}."""
    out = json.loads(json.dumps(base))
    overrides = dict(overrides or {})
    weights = overrides.pop("weights", None) or {}
    out.update(overrides)
    for c in out.get("criteria", []):
        if c["name"] in weights:
            c["weight"] = float(weights[c["name"]])
    unknown = set(weights) - {c["name"] for c in out.get("criteria", [])}
    if unknown:
        raise ValueError(f"no criteria named {sorted(unknown)}")
    return out


@mcp.tool()
def list_presets(sector: str | None = None) -> list[dict]:
    """List ready-made analysis templates (water, agriculture, roads, education, health,
    nature-based solutions). Each has a planning question, a process and editable criteria."""
    rows = []
    for pid, p in load_presets().items():
        if sector and sector.lower() not in p["sector"].lower():
            continue
        rows.append({"id": pid, "sector": p["sector"], "title": p["title"], "question": p["question"],
                     "process": p["process"],
                     "criteria": [c["name"] for c in p["inputs"].get("criteria", [])]
                     or [layer["name"] for layer in p["inputs"].get("layers", [])]})
    return rows


@mcp.tool()
def get_preset(preset_id: str) -> dict:
    """Full definition of a preset: every criterion with its data source, scoring rule and weight,
    and the exclusion constraints. Show this to the user before running."""
    presets = load_presets()
    if preset_id not in presets:
        return {"error": f"unknown preset; choose from {sorted(presets)}"}
    return presets[preset_id]


@mcp.tool()
def compute_ahp_weights(criteria: list[str], matrix: list[list[float]]) -> dict:
    """Analytic Hierarchy Process. matrix[i][j] says how much more important criteria[i] is than
    criteria[j] on Saaty's 1 to 9 scale (reciprocals below the diagonal). Returns normalised weights
    and the consistency ratio; CR above 0.10 means the judgements contradict each other."""
    try:
        w, cr = mcda.ahp_weights(matrix)
    except mcda.MCDAError as e:
        return {"error": str(e)}
    if len(w) != len(criteria):
        return {"error": "one row per criterion is required"}
    return {"weights": {c: round(float(x), 4) for c, x in zip(criteria, w)},
            "consistency_ratio": round(cr, 4), "consistent": cr < 0.10}


@mcp.tool()
def search_catalog(query: str = "", bbox: list[float] | None = None, limit: int = 20) -> list[dict]:
    """Find datasets in the course STAC catalogue to use as criteria or constraints.
    bbox is [min_lon, min_lat, max_lon, max_lat]."""
    r = httpx.get(f"{STAC_API_URL}/collections", timeout=30)
    r.raise_for_status()
    q = query.lower()
    out = []
    for c in r.json().get("collections", []):
        text = " ".join([c.get("id", ""), c.get("title", ""), c.get("description", ""),
                         " ".join(c.get("keywords", []))]).lower()
        if q and q not in text:
            continue
        if bbox:
            cb = (c.get("extent", {}).get("spatial", {}).get("bbox") or [[-180, -90, 180, 90]])[0]
            if cb[0] > bbox[2] or cb[2] < bbox[0] or cb[1] > bbox[3] or cb[3] < bbox[1]:
                continue
        out.append({"collection": c["id"], "title": c.get("title"), "catalog": "local",
                    "criterion": c.get("geida:criterion"),
                    "assets": list((c.get("item_assets") or {}).keys())})
    return out[:limit]


@mcp.tool()
def run_preset(preset_id: str, aoi: list[float] | dict | str, overrides: dict | None = None,
               follow_up: bool = False) -> dict:
    """Run a preset for an area of interest (bbox [min_lon, min_lat, max_lon, max_lat], GeoJSON,
    or a catalogue vector). overrides may change any input, e.g. {"threshold": 0.8,
    "weights": {"Flat land": 5}}. Set follow_up=true to run the preset's follow-up analysis."""
    p = load_presets().get(preset_id)
    if p is None:
        return {"error": f"unknown preset {preset_id!r}"}
    if follow_up and "follow_up" not in p:
        return {"error": "this preset has no follow-up step"}
    step = p["follow_up"] if follow_up else p
    try:
        inputs = merge_inputs(step["inputs"], overrides)
    except ValueError as e:
        return {"error": str(e)}
    key = "features" if step["process"] == "buffer-screen" else "aoi"
    inputs[key] = aoi
    return {"preset": preset_id, "process": step["process"], "inputs_used": inputs,
            "result": execute(step["process"], inputs)}


@mcp.tool()
def run_suitability(aoi: list[float] | dict | str, criteria: list[dict], constraints: list[dict] | None = None,
                    ahp: list[list[float]] | None = None, resolution: float = 100,
                    threshold: float = 0.7, min_area_ha: float = 0, top_n: int = 10) -> dict:
    """Custom multi-criteria suitability. Each criterion: {name, source, rule, weight}.
    source: {"osm": "roads"} | {"collection": id, "catalog": ..., "asset": ..., "derive": "slope"} |
    {"raster": ref}. rule: linear {min, max, direction higher|lower}, thresholds {breaks, scores}
    or classes {map}. Returns a suitability raster URL and ranked candidate sites."""
    inputs = {"aoi": aoi, "criteria": criteria, "constraints": constraints or [], "resolution": resolution,
              "threshold": threshold, "min_area_ha": min_area_ha, "top_n": top_n}
    if ahp:
        inputs["ahp"] = ahp
    return execute("suitability", inputs)


@mcp.tool()
def run_accessibility(aoi: list[float] | dict | str, facilities: dict | str, population: dict | str | None = None,
                      limit_m: float = 5000, resolution: float = 100) -> dict:
    """Distance to the nearest facility and people within / beyond limit_m.
    facilities: {"osm": "health"} or a vector ref. population: e.g. {"collection": "worldpop",
    "catalog": "local", "asset": "data"}."""
    inputs = {"aoi": aoi, "facilities": facilities, "limit_m": limit_m, "resolution": resolution}
    if population:
        inputs["population"] = population
    return execute("accessibility", inputs)


@mcp.tool()
def run_buffer_screen(features: dict | str, layers: list[dict], distance_m: float = 1000) -> dict:
    """Buffer a road, pipeline or site and report land cover shares, flood exposure, slope and
    population inside the buffer."""
    return execute("buffer-screen", {"features": features, "layers": layers, "distance_m": distance_m})


@mcp.tool()
def zonal_statistics(raster: str, zones: dict | str, stats: list[str] | None = None) -> dict:
    """Summarise a raster inside each polygon (district, catchment, project area)."""
    return execute("zonal-statistics", {"raster": raster, "zones": zones,
                                        "stats": stats or ["mean", "min", "max", "count"]})


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
