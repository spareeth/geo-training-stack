# Server-side analysis: suitability, accessibility, screening

All analysis runs on the server. Trainees normally use it from GeoLibre through the
**Server Analysis** plugin (`geolibre-plugin/server-analysis`). JupyterHub, the processes API and
an AI agent (via MCP) use the same processes.

## Processes (`/processes-api/processes/<id>/execution`)

| id | What it answers |
| --- | --- |
| `whitebox` | Any WhiteboxTools tool (terrain, hydrology, image analysis, GIS overlay, classification, LiDAR), same names as in GeoLibre. Inputs are clipped to an optional area first |
| `whitebox-tools` | Lists tools, or one tool's parameters (the plugin builds its forms from this) |
| `features` | A catalogue vector dataset as GeoJSON for the map, clipped to an area |
| `suitability` | Where is the best land for X? Weighted overlay of scored criteria, AHP weights optional, exclusions, ranked candidate sites |
| `accessibility` | How far is everyone from the nearest school / clinic / water point, and how many people are beyond a limit? |
| `buffer-screen` | What does a road, pipeline or site buffer contain (land cover, change, flood proxy, slope, population)? |
| `zonal-statistics` | Raster summary per polygon (district, catchment, project area) |

Every analysis runs on one grid built from the area of interest, in the local UTM zone, so
distances and areas are in metres.

## Choosing layers: sources

A criterion, constraint or screening layer can come from anywhere in the catalogue:

| Source | Example |
| --- | --- |
| Course catalogue collection | `{"collection": "worldpop", "catalog": "local", "asset": "data", "counts": true}` |
| Public catalogues | `{"collection": "cop-dem-glo-30", "catalog": "earth-search", "asset": "data", "derive": "slope"}`, `{"collection": "esa-worldcover", "catalog": "planetary-computer", "asset": "map", "categorical": true}` |
| OpenStreetMap, fetched for the AOI | `{"osm": "schools"}`; layers: roads, major_roads, schools, health, hospitals, water_points, rivers, markets, settlements, power_lines |
| Single raster or vector | `{"raster": "/data/x.tif"}`, `{"vector": "/data/roads.fgb"}` |

Collections are mosaicked automatically over any AOI, so templates work in any country.
Options: `derive: "slope"` (degrees, from a DEM), `categorical` (class codes, nearest neighbour),
`counts` (population, summed when resampling), `datetime` (e.g. `"2017"`).

## Scoring rules (value to 0..1)
- `linear`: `{"min": 0, "max": 5000, "direction": "lower"}` (closer is better)
- `thresholds`: `{"breaks": [2, 8, 15], "scores": [0.6, 1, 0.4, 0]}`
- `classes`: `{"map": {"40": 1, "30": 0.9}, "default": 0}`

## Constraints (excluded areas)
`{"source": {...}, "classes": [80, 90]}`, `{"source": {...}, "op": ">", "value": 15}`,
`{"vector": ref}` (inside polygons), `{"osm": "rivers", "within_m": 100}`.

## Optional worked examples (`presets/`)

| Template | Process | Question |
| --- | --- | --- |
| water-rainwater-harvesting | suitability | Sites for small reservoirs near people |
| agriculture-irrigation | suitability | Flat non-built land near water and roads |
| roads-corridor-screening | buffer-screen | What the alignment crosses, change 2017 to 2023, flood proxy, population |
| education-school-siting | suitability, then accessibility | Where many people live far from a school |
| health-catchment-gaps | accessibility, then suitability | People beyond 10 km of care, best new sites |
| nbs-restoration | suitability | Degraded land, erosion-prone slopes, riparian zones |

These are optional examples for the AI agent and the notebook. The GeoLibre plugin does not need
them: trainees build any analysis from the catalogue and the tool list.

## Data to load into the course catalogue
Public catalogues cover DEM, land cover, land-use change and surface water. Load these locally
(`scripts/register_cog.py`, one collection each, asset key `data`):
- `worldpop`: WorldPop population counts, 100 m (https://hub.worldpop.org), per country.
- `chirps-annual`: CHIRPS annual rainfall (mm), https://data.chc.ucsb.edu/products/CHIRPS-2.0/.

Before a class, run each demo once for the class areas so OSM responses are cached
(`/outputs/osm-cache`). Public Overpass servers are sometimes busy; the code tries mirrors, and
`OVERPASS_URLS` can point to your own Overpass instance.

## AI agent (MCP)
`mcp` service, streamable HTTP at `http://mcp:8090/mcp` on the `geo` network. Register it as an
MCP server in your AI agent's configuration (any MCP client that supports streamable HTTP).
Tools: `list_presets`, `get_preset`, `search_catalog`, `compute_ahp_weights`, `run_preset`,
`run_suitability`, `run_accessibility`, `run_buffer_screen`, `zonal_statistics`.

The model chooses tools, proposes weights, and explains. All calculations run in the processes,
so every answer is reproducible: each result includes the exact inputs used.
CPU only: use a small tool-calling model (e.g. `qwen2.5:7b` in Ollama) and allow 20 to 60 s per
reply.

Example prompts for the showcase:
- "Which templates do you have for health?" then "Run it for this area: 39.1, 21.4, 39.3, 21.6."
- "I care twice as much about rainfall as about roads. Compute AHP weights for these criteria."
- "Screen this road alignment with a 2 km buffer. How much built area was added since 2017?"
- "Find suitable irrigation land in this district, but exclude anything within 200 m of rivers."

## Real-data check (3 Oct 2026, laptop CPU)
- School siting, Jeddah 7 x 7 km, 200 m grid: 16 s, 5 candidate sites.
- Health accessibility, same area, OSM clinics: 7 s.
- Road corridor screening, 17 km line, 1 km buffer, 30 m grid, 5 layers: 26 s.
