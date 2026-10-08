# Shared GeoLibre sidecar (for the public web app)

Participants use the public GeoLibre web app (https://web.geolibre.app) in their browser and install
the **Remote Processing** plugin from this server. GeoLibre's own Processing tools (Whitebox Toolbox:
735 tools, GeoLibre Toolbox) then run on this server instead of in the browser. Participants upload
their own data from the plugin; nothing is bundled.

```
web.geolibre.app (participant's browser)
  └─ Remote Processing plugin ── redirects GeoLibre's /sidecar requests, adds the access code
        │
        ▼  HTTPS
  this server: Caddy (TLS, CORS for web.geolibre.app, access code)
        ├─ /sidecar/*  GeoLibre image's Python sidecar (WhiteboxTools, rasterio, GeoPandas)
        ├─ /files      upload / list / delete / map-ready copies (same image)
        ├─ /data/*     files in the shared folder (downloads, map layers)
        └─ /plugin/*   the plugin itself (public, for installing)
```

## Deploy (Ubuntu with Docker)
1. DNS: point a name, e.g. `sidecar.example.org`, at the server. Open ports 80 and 443.
2. Install Docker: `curl -fsSL https://get.docker.com | sudo sh`
3. Get this repo onto the server, then `cd remote-sidecar && cp .env.example .env` and set
   `SIDECAR_SITE`, `ACME_EMAIL` and a long random `ACCESS_CODE`.
4. `sudo docker compose up -d`. Caddy gets the HTTPS certificate on first start.
5. Check: `https://<SIDECAR_SITE>/plugin/plugin.json` opens; `/sidecar/health` answers 401 without
   the code.

Only `geolibre-plugin/remote-processing/` from the parent folder is used (mounted as the plugin).

## Participants (once per browser)
1. Open https://web.geolibre.app
2. **Settings > Manage Plugins > Settings** tab: under **Manifest URLs** paste
   `https://<SIDECAR_SITE>/plugin/plugin.json`, **Add**.
3. **Plugins > Installed > Remote Processing** to activate it, then **Remote Processing > Server
   connection and files** in the top bar.
4. Enter the server address and the access code, **Save and connect**.

## Running a tool on the server
1. **Upload** rasters in the plugin (vector layers already on the map need no upload: GeoLibre sends
   them with the job).
2. **Processing > Whitebox Toolbox** (or GeoLibre Toolbox), pick a tool, **untick "Run locally
   (WASM)"**.
3. Raster inputs: the server path, e.g. `/data/dem.tif` (**Copy path** in the plugin). Output: a new
   path under `/data`, e.g. `/data/ab-slope.tif`. Without one, the output goes to a temporary folder
   the plugin cannot list.
4. **Run**, then **Refresh** in the plugin and **Add to map** or **Download**.

## Zonal statistics (raster + vector zones)
Use the plugin's **Zonal statistics** section, not GeoLibre's **GeoLibre Toolbox > Raster > Zonal
statistics** dialog: GeoLibre locks its whole Raster tools dialog to the desktop app on the web,
even when a sidecar is available. The plugin calls the same GeoLibre code on the sidecar directly.
1. Raster: a raster on the server (uploaded, or written by a Whitebox tool under `/data`).
2. Zones: any polygon layer on the map (drawn with GeoEditor or loaded with **Add Data > Vector
   Layer**; the plugin sends it to the server) or an uploaded GeoJSON. Zones are reprojected to the
   raster's CRS automatically.
3. Optional band and field prefix (`dem_` gives `dem_mean`...). **Run zonal statistics on the server**.
4. Result: the zones with count, min, max, mean, sum, std and median are added to the map (click a
   zone to see its values) and, if ticked, downloaded as CSV. Tested against rasterio: identical.

Whitebox **Zonal Statistics** in the Whitebox Toolbox also works, but it takes the zones as a raster.

## Notes and limits
- **GeoLibre Toolbox > Raster** tools (hillshade, clip, reclassify, raster calculator, zonal...)
  cannot be started from GeoLibre's own dialog on the web (desktop only). Whitebox Toolbox tools,
  which cover the same operations, do run on the server. The plugin's Zonal statistics form is the
  route for zonal statistics with polygon zones.
- **Units: automatic.** Whitebox measures in the units of the data's coordinates, so latitude/longitude
  data would give areas in square degrees. With the plugin's **Measure in metres** option (on by
  default) the server reprojects lat/lon vector inputs and geographic rasters of each Whitebox job to
  the local UTM zone (picked from the data's centre), so areas come out in m² and lengths/distances
  in metres (e.g. a buffer distance of 500 means 500 m). Results return to the map in lat/lon,
  through GeoLibre's own output layer and the plugin's **Add to map**; raster outputs stay in UTM
  (they display correctly). Downloads are the raw files: vector results of these jobs are in UTM.
  Data spanning several UTM zones (a whole large country) is measured in the zone of its centre,
  with small distortion towards the edges. Untick the option to keep the data's own CRS.
- **Image fix.** The published GeoLibre image lacks `contourpy`, which its sidecar's raster runtime
  needs; `Dockerfile.geolibre` adds it. Remove it once the upstream image includes it.
- **Shared folder.** Everyone with the access code sees the same `/data`. Ask participants to prefix
  file names with their initials. Change `ACCESS_CODE` per course; clear old files with
  `sudo docker compose exec files sh -c 'rm -rf /data/*'`.
- **How it works.** GeoLibre's web build always calls `<its own address>/sidecar`; the plugin wraps
  the browser's `fetch` so those calls go to this server instead. This relies on GeoLibre internals
  and is not an official plugin API, so re-test after GeoLibre updates (tested with
  web.geolibre.app on 2026-10-07).
- **Plugin pinning.** GeoLibre stops loading a plugin whose code changed until it is removed and
  re-added; do not change the plugin during a course.
- **Upload limit** `MAX_UPLOAD_MB` (default 500). Vector layers sent with jobs: up to 200 MB
  (`nginx-body-size.conf`).
- **Sizing.** Whitebox tools are CPU and memory heavy: 8+ cores and 16-32 GB RAM for a class of 20-30.
- **Local test.** `SIDECAR_SITE=localhost`, `HTTPS_PORT=8443`, then use `https://localhost:8443` in
  the plugin (accept the self-signed certificate in the browser first). Recent Chrome may ask
  before letting a public site reach `localhost`; this does not apply to a real server.
