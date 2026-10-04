# Geo training stack

Browser-only GIS for training. Trainees install nothing. Heavy analysis runs on this server.

| URL | What | Runs where |
| --- | --- | --- |
| `https://DOMAIN/` | GeoLibre (map, STAC browser, light analysis) | browser |
| `https://DOMAIN/stac/` | Course catalogue: standard STAC API (stac-fastapi-pgstac) over public datasets for IsDB countries, read-only | server |
| `https://DOMAIN/processes-api/` | pygeoapi, OGC API Processes: `whitebox` (all WhiteboxTools tools), `zonal-statistics`, `suitability`, `accessibility`, `buffer-screen`, `features` | server |
| `https://DOMAIN/plugins/server-analysis/plugin.json` | GeoLibre plugin: Data and Tools panels that run everything above on the server | browser UI |
| `https://DOMAIN/outputs/` | Result rasters (COG), loadable in GeoLibre | server |
| `http://mcp:8090/mcp` (internal) | MCP tools for an AI agent (any MCP client) | server |
| `https://DOMAIN/tiles/` | TiTiler, COG tiles | server |
| `https://DOMAIN/lab/` | JupyterHub, one container per trainee (2 CPU, 4 GB) | server |

GeoLibre's built-in tools run in the browser. The **Server Analysis** plugin gives trainees the
same WhiteboxTools toolbox plus zonal statistics, suitability, accessibility and buffer screening,
running on this server, with a catalogue browser. Results appear on the map. Install it once per
browser (tested in GeoLibre with the prebuilt image):
1. **Settings > Manage Plugins > Settings** tab, under **Manifest URLs** paste
   `https://DOMAIN/plugins/server-analysis/plugin.json` and click **Add**.
2. **Plugins > Server Analysis** to activate it. A **Server Analysis** button appears in the top bar.
3. **Server Analysis > Open data and analysis panel**.

**Updating the plugin:** GeoLibre pins the plugin's code when it is first trusted. After any change
to `dist/`, it silently stops loading the plugin (only a console warning) until each browser removes
the URL under **Settings > Manage Plugins > Settings** and adds it again. Freeze the plugin for the
length of a course, and if you must update mid-course, tell trainees to remove and re-add it.

## Login
- Web apps: one shared user/password (Caddy basic auth), from `.env`.
- JupyterHub: any username (use your name) plus the shared `JUPYTER_SHARED_PASSWORD`.
  Each username gets its own workspace, so ask trainees to keep the same name all course.

## Install (Ubuntu 22.04/24.04)
1. Install Docker Engine and the compose plugin. Point a DNS A record for `DOMAIN` at the server.
   Open only ports 80 and 443.
2. Clone this repo to `/opt/geo-training-stack`, `cp .env.example .env`, fill it in. Put the bcrypt
   hash in single quotes (`TRAINEE_PASSWORD_HASH='$2a$14$...'`): Docker Compose otherwise treats
   each `$` as a variable and the login silently breaks.
3. `docker network create geo`
4. Set `STAC_DB_PASSWORD` in `.env` (the course catalogue database; any long random string).
5. Notebook image: `docker build -t geo-training-singleuser:latest jupyterhub/singleuser`
6. `docker compose up -d --build`

## Course catalogue (public data, nothing copied)
The catalogue is filled from public sources listed in [`catalog/sources.yml`](catalog/sources.yml),
for the IsDB member countries. Only metadata is stored; every layer points at public cloud storage.

| Group | Collections |
| --- | --- |
| Terrain | Copernicus DEM 30 m |
| Land cover / water | ESA WorldCover 10 m, Impact Observatory annual 10 m, CLMS 10 m (CDSE), CGLS 100 m + cover fractions (CDSE), CLMS tree cover density 10 m (CDSE), JRC surface water |
| Population / socio-economic | Meta HRSL 30 m (total and 6 groups), Relative Wealth Index |
| Boundaries | geoBoundaries Open ADM0-ADM4, Humanitarian (UN OCHA CODs), Authoritative (UN SALB) |
| OpenStreetMap (HOT exports on HDX) | health, education, roads, buildings, waterways, populated places, financial services, points of interest, airports/ports/railways |
| Overture Maps (GeoParquet, global) | buildings (OSM + Microsoft + Google), roads, places (schools, clinics, shops), admin areas, infrastructure (power, water, telecom), land use, water |

Fill or refresh it (first run takes a while; re-runs replace items):
```
docker compose run --rm -v "$PWD/scripts:/scripts:ro" \
  --entrypoint /venv/bin/python pygeoapi /scripts/harvest_catalog.py
```
`--only osm-roads,admin-boundaries` and `--countries SEN,PAK` limit a run. Add sources by editing
`sources.yml`; any public STAC API can be mirrored with `kind: stac-mirror`.

The plugin's **Data** tab has a search box (all words must match title, description or keywords),
**All / Raster / Vector** tabs with counts, and a catalogue picker: Course catalogue, **Earth Search**
and **Copernicus Data Space (CDSE)** (searched live, for time series: Sentinel-2/1, Landsat,
Sentinel-2 quarterly mosaics, CLMS NDVI...) or **All catalogues** at once.

Overture collections are GeoParquet files split by area: they show **Add for current view**, which
reads only the files and row groups covering the view (central Dakar, 2.5 km: 11,666 buildings in
about 10 s). Views with more than 50,000 features are refused with a "zoom in" message; analysis
tools use their own area the same way. Bump `release:` in `sources.yml` to move to a newer
Overture release.

**CDSE** files need the server's CDSE S3 keys: create them at
https://eodata-s3keysmanager.dataspace.copernicus.eu/ and set `CDSE_S3_ACCESS_KEY` /
`CDSE_S3_SECRET_KEY` in `.env`. Keys expire; renew them before a course. Trainees never see them.

**Before each course, prewarm the vector cache** for the class countries. Country-wide OSM files
(roads, buildings) are zipped, so the first read downloads them; prewarmed, a city view loads in
seconds instead of minutes:
```
docker compose exec pygeoapi /venv/bin/python -m training_processes.vector_cache --countries SEN,PAK
```
Copies refresh after 30 days (`VECTOR_CACHE_MAX_AGE_DAYS`).

### Own data (optional)
Rasters can still be added with `scripts/register_cog.py`:
```
docker compose run --rm -v "$PWD/data:/data-rw" -v "$PWD/scripts:/scripts:ro" \
  --entrypoint /venv/bin/python pygeoapi /scripts/register_cog.py \
  /data-rw/incoming/dem.tif --collection dem --item dem-30m --title "Elevation 30 m"
```
It writes a COG to `data/catalog/<collection>/<item>.tif` and registers it. Vectors: place
GeoPackage/FlatGeobuf files in `data/`; processes read them by path.

The catalogue is read-only from outside: Caddy only allows reads and `POST /search`. Writes go to
`127.0.0.1:8082` on the server, which the scripts reach over the internal network.

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
GeoLibre: read its LICENSE file. stac-fastapi-pgstac and pgstac (MIT), pygeoapi (MIT), TiTiler (MIT), WhiteboxTools open core (MIT), exactextract
(Apache-2.0), JupyterHub (BSD-3), Caddy (Apache-2.0), MCP Python SDK (MIT), planetary-computer (MIT),
scipy (BSD-3). Data: Copernicus DEM (free licence, attribution), ESA WorldCover (CC BY 4.0),
Impact Observatory LULC (CC BY 4.0), JRC GSW (free, attribution), OSM (ODbL, attribution required),
WorldPop (CC BY 4.0), CHIRPS (public domain), Copernicus CLMS/CGLS and Sentinel via CDSE (Copernicus
free and open licence, attribution; also check CDSE terms for serving data to a class through one
account), Meta HRSL (CC BY 4.0), Relative Wealth Index (CC BY-NC 4.0: non-commercial use only),
geoBoundaries (per-country licences, mostly CC BY 4.0), HOT OSM exports (ODbL).
