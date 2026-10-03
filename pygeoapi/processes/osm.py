"""On-demand OpenStreetMap layers for any AOI, via the Overpass API, cached on disk.

A criterion source {"osm": "schools"} works anywhere in the world without pre-loading data.
"""
import hashlib
import json
import os

import geopandas as gpd
import requests
from shapely.geometry import LineString, Point

from . import mcda

# Tried in order. Public servers get busy, so keep mirrors (or run your own Overpass).
OVERPASS_URLS = os.environ.get("OVERPASS_URLS", ",".join([
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
])).split(",")
CACHE_DIR = os.environ.get("OSM_CACHE_DIR", "/outputs/osm-cache")
# Overpass refuses generic client user agents.
USER_AGENT = os.environ.get("OSM_USER_AGENT", "geida-training-stack/0.1 (spatial analysis training)")

# Overpass filters per layer. Ways come back as lines, nodes as points; both work for distance.
LAYERS = {
    "roads": ['way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)$"]'],
    "major_roads": ['way["highway"~"^(motorway|trunk|primary|secondary)$"]'],
    "schools": ['nwr["amenity"~"^(school|kindergarten)$"]'],
    "health": ['nwr["amenity"~"^(hospital|clinic|doctors|health_post)$"]', 'nwr["healthcare"]'],
    "hospitals": ['nwr["amenity"="hospital"]'],
    "water_points": ['nwr["amenity"="drinking_water"]', 'nwr["man_made"~"^(water_well|water_tap|borehole)$"]'],
    "rivers": ['way["waterway"~"^(river|stream|canal)$"]'],
    "markets": ['nwr["amenity"="marketplace"]'],
    "settlements": ['node["place"~"^(city|town|village|hamlet)$"]'],
    "power_lines": ['way["power"="line"]'],
}


def overpass_query(layer: str, bbox) -> str:
    s, w, n, e = bbox[1], bbox[0], bbox[3], bbox[2]
    parts = "".join(f"{f}({s},{w},{n},{e});" for f in LAYERS[layer])
    return f"[out:json][timeout:120];({parts});out geom;"


def elements_to_gdf(elements: list) -> gpd.GeoDataFrame:
    rows = []
    for el in elements:
        tags = el.get("tags", {})
        if el["type"] == "node":
            geom = Point(el["lon"], el["lat"])
        elif "geometry" in el and len(el["geometry"]) >= 2:
            geom = LineString([(p["lon"], p["lat"]) for p in el["geometry"]])
        elif "center" in el:
            geom = Point(el["center"]["lon"], el["center"]["lat"])
        else:
            continue
        rows.append({"osm_id": f"{el['type']}/{el['id']}", "name": tags.get("name"), "geometry": geom})
    return gpd.GeoDataFrame(rows, geometry="geometry", crs="EPSG:4326") if rows else \
        gpd.GeoDataFrame({"osm_id": [], "name": []}, geometry=[], crs="EPSG:4326")


def fetch_osm(layer: str, bbox) -> gpd.GeoDataFrame:
    if layer not in LAYERS:
        raise mcda.MCDAError(f"unknown OSM layer {layer!r}; choose from {sorted(LAYERS)}")
    key = hashlib.sha1(f"{layer}:{[round(float(v), 4) for v in bbox]}".encode()).hexdigest()[:16]
    path = os.path.join(CACHE_DIR, f"{layer}-{key}.geojson")
    if os.path.exists(path):
        return gpd.read_file(path)
    errors = []
    for url in OVERPASS_URLS:
        try:
            r = requests.post(url, data={"data": overpass_query(layer, bbox)},
                              headers={"User-Agent": USER_AGENT}, timeout=180)
            r.raise_for_status()
            elements = r.json().get("elements", [])
            break
        except (requests.RequestException, ValueError) as e:
            errors.append(f"{url}: {e}")
    else:
        raise mcda.MCDAError(f"could not fetch OSM {layer} (try again, or a smaller area): "
                             + "; ".join(errors))
    gdf = elements_to_gdf(elements)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "w") as f:
        json.dump(json.loads(gdf.to_json(drop_id=True)), f)
    return gdf
