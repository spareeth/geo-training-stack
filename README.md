# Geo training stack

Browser-only GIS for training. Trainees install nothing. Heavy analysis runs on this server.

| URL | What | Runs where |
| --- | --- | --- |
| `https://DOMAIN/` | GeoLibre (map, STAC browser, light analysis) | browser |
| `https://DOMAIN/catalog/`, `/stac/` | STAC GIS core (catalog, raster pipelines, local AI) | server |
| `https://DOMAIN/processes-api/` | pygeoapi, OGC API Processes: `whitebox` (all WhiteboxTools tools), `zonal-statistics`, `suitability`, `accessibility`, `buffer-screen`, `features` | server |
| `https://DOMAIN/plugins/server-analysis/plugin.json` | GeoLibre plugin: Data and Tools panels that run everything above on the server | browser UI |
| `https://DOMAIN/outputs/` | Result rasters (COG), loadable in GeoLibre | server |
| `http://mcp:8090/mcp` (internal) | MCP tools for the STAC GIS AI agent | server |
| `https://DOMAIN/tiles/` | TiTiler, COG tiles | server |
| `https://DOMAIN/lab/` | JupyterHub, one container per trainee (2 CPU, 4 GB) | server |

GeoLibre's built-in tools run in the browser. The **Server Analysis** plugin gives trainees the
same WhiteboxTools toolbox plus zonal statistics, suitability, accessibility and buffer screening,
running on this server, with a catalogue browser. Results appear on the map. Install it once per
browser: GeoLibre, Plugins, Install from URL, `https://DOMAIN/plugins/server-analysis/plugin.json`.

## Login
- Web apps: one shared user/password (Caddy basic auth), from `.env`.
- JupyterHub: any username (use your name) plus the shared `JUPYTER_SHARED_PASSWORD`.
  Each username gets its own workspace, so ask trainees to keep the same name all course.

## Install (Ubuntu 22.04/24.04)
1. Install Docker Engine and the compose plugin. Point a DNS A record for `DOMAIN` at the server.
   Open only ports 80 and 443.
2. Clone this repo to `/opt/geo-training-stack`, `cp .env.example .env`, fill it in.
3. `docker network create geo`
4. STAC GIS core:
   ```
   git clone https://codeberg.org/stac-gis/core /opt/stac-gis
   cd /opt/stac-gis && cp .env.example .env   # set secrets
   ```
   Add the external `geo` network to its backend, frontend and minio services (compose override),
   and name the containers `stac-gis-backend`, `stac-gis-frontend`, `minio`, or edit `caddy/Caddyfile`
   to match. Then `docker compose up -d --build`.
5. Notebook image: `docker build -t geo-training-singleuser:latest jupyterhub/singleuser`
6. `docker compose up -d --build`

## Load data
```
python scripts/register_cog.py dem.tif --collection dem --item dem-30m
```
Vectors: convert to GeoParquet or FlatGeobuf, place in `data/` or MinIO, register in STAC.

## Zonal statistics (server-side)
```
curl -u trainee:PASS -X POST https://DOMAIN/processes-api/processes/zonal-statistics/execution \
  -H 'Content-Type: application/json' \
  -d '{"inputs": {"raster": "dem/dem-30m", "zones": "/data/districts.geojson", "stats": ["mean","max"]}}'
```
`raster`: `collection/item[/asset]`, a COG URL, or a `/data` path. `zones`: inline GeoJSON or a
path/URL. Returns GeoJSON, which can be dropped straight into GeoLibre. Add header
`Prefer: respond-async` for long jobs. Zones are reprojected to the raster CRS automatically.

## Analysis details and optional examples
See [docs/ANALYSIS.md](docs/ANALYSIS.md) for the processes, layer sources, scoring rules, AHP and the
AI agent tools. `presets/` and `examples/sector_showcase.ipynb` hold optional worked examples
(water, agriculture, roads, education, health, nature-based solutions); nothing depends on them.

## Tests
```
cd pygeoapi && pip install -r requirements-dev.txt && pytest
cd .. && pip install -r mcp/requirements-dev.txt && pytest mcp/tests
cd geolibre-plugin/server-analysis && node build.mjs && node --test test/core.test.mjs
```

## Licences to check before a public course
GeoLibre and STAC GIS: read their LICENSE files. pygeoapi (MIT), TiTiler (MIT), WhiteboxTools open core (MIT), exactextract
(Apache-2.0), JupyterHub (BSD-3), Caddy (Apache-2.0), MCP Python SDK (MIT), planetary-computer (MIT),
scipy (BSD-3). Data: Copernicus DEM (free licence, attribution), ESA WorldCover (CC BY 4.0),
Impact Observatory LULC (CC BY 4.0), JRC GSW (free, attribution), OSM (ODbL, attribution required),
WorldPop (CC BY 4.0), CHIRPS (public domain).
