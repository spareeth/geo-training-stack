# Shared GeoLibre sidecar (for the public web app)

Participants use the public GeoLibre web app (https://web.geolibre.app) in their browser and install
the **Remote Processing** plugin from this server. GeoLibre's own Processing tools (Whitebox Toolbox:
735 tools) and zonal statistics then run on this server instead of on the laptop. Participants
upload their own data; nothing needs installing on the laptop.

- [For participants](#for-participants): setup, running tools, zonal statistics, troubleshooting
- [For trainers](#for-trainers): deployment, before and after a course
- [Technical notes](#technical-notes)

---

# For participants

You need a laptop with a recent Chrome, Edge or Firefox, and two things from your trainer:
- the **server address**, e.g. `https://sidecar.example.org`
- the **access code**

## 1. Set up (once, about 2 minutes)
1. Open **https://web.geolibre.app**.
2. Install the plugin: **Settings > Manage Plugins**, open the **Settings** tab. Under **Manifest
   URLs** paste `<server address>/plugin/plugin.json` (e.g.
   `https://sidecar.example.org/plugin/plugin.json`) and click **Add**. Close the dialog.
3. Turn it on: **Plugins > Installed > Remote Processing**. A **Remote Processing** button appears
   in the top bar.
4. Open the panel: **Remote Processing > Server connection and files**.
5. Enter the **Server** address and the **Access code**, then **Save and connect**. The status line
   turns green: *Connected to ...*.

Leave **Measure in metres** ticked: areas then come out in m² and distances in metres, even when
your data is in latitude/longitude.

Use the same browser on the same laptop for the whole course. The plugin and your connection are
remembered there, so next time just open https://web.geolibre.app.

## 2. Your folder
The panel shows **Your folder**, e.g. `/data/u-7f3k9q2m1x`. This is your private space on the server:
your uploads and results go there, and other participants cannot overwrite them.

**Write your folder id down.** If you change browser or laptop, or clear your browsing data, the
plugin starts a new, empty folder. To get your files back, open **Use an existing folder id**, type
the old id and click **Use this folder**.

## 3. Course data: where it comes from and how to open it
Your trainer gives you the data in two ways:

| Data | Where it is | How you open it | How tools use it |
|---|---|---|---|
| **Course rasters** (DEM, land cover, imagery...) | Already on the server, under **Shared files** at the bottom of the panel | **Add to map** | **Copy path** and paste it into the tool, e.g. `/data/dem.tif` |
| **Course vectors** (study area, zones, roads...) | A zip file from your trainer: unzip it on your laptop | **Add Data > Vector Layer**, choose the file (GeoJSON or shapefile) | Pick the layer in the tool's input list: GeoLibre sends it with the job |
| **Your own rasters** | Your laptop | Upload first (below), then **Add to map** | **Copy path** (your folder, e.g. `/data/u-7f3k9q2m1x/my-dem.tif`) |
| **Your own vectors** | Your laptop, or draw them (**Plugins > GeoEditor**) | **Add Data > Vector Layer** | Pick the layer in the tool's input list |
| **Your results** | Your folder on the server | **Refresh**, then **Add to map** (or **Download**) | **Copy path**, to use as the next tool's input |

**Rasters must be on the server to be processed.** A raster you open from your laptop with **Add
Data > Raster Layer** can be viewed, but the server cannot read it. Use the server copy (Shared files
or your folder) for analysis. Vectors are different: any vector layer on the map can be used directly.

**Uploading your own rasters:** in the panel, **Upload your data** > choose the GeoTIFF(s) > **Upload
to server**. They appear under **Files on the server**. Uploading a name you already used asks before
replacing it. Clip large rasters to your study area first: smaller files upload and process faster.

**Viewing and styling.** **Add to map** opens a server raster as a normal GeoLibre layer (it streams
only the part you are looking at). Click the layer, or its palette icon in the Layers panel, to open
GeoLibre's raster settings:
- **Single band + colormap** with dozens of colour ramps (e.g. *terrain* for elevation, *viridis*),
  **RGB / composite** for multi-band imagery, or an **Index (normalized difference)** such as NDVI
- **Band**, **Rescale** (2-98 % or min/max), opacity, and **Inspect** to read pixel values

Styling only changes the display: tools always read the original file through its path. Vector
results open as normal vector layers: style them as usual and click a feature to see its attributes.

## 4. Run a Whitebox tool on the server
Example: slope from a DEM.
1. Upload `dem.tif` (step 3) and **Copy path**.
2. **Processing > Whitebox Toolbox**. Search `Slope` and select it.
3. **Untick "Run locally (WASM)"** (top right of the dialog). If it stays ticked, the tool runs on
   your laptop instead and cannot read files on the server.
4. **Input**: choose **Path** and paste the copied path, e.g. `/data/u-7f3k9q2m1x/dem.tif`.
5. **Output**: leave it on **Auto**, or type a name such as `slope` or `pop-clip.tif`. It is saved in
   your folder automatically (Auto names look like `slope-20261008-153000.tif`). A name you already
   used is overwritten.
6. **Run**. Wait for **Succeeded**.
7. The result appears in the panel's **Data** tab when the tool finishes: **Add to map** (or
   **Download**).

Tools with **vector inputs** (e.g. *Buffer Vector*, *Polygon Area*): pick the layer from the input
list instead of a path. Vector results are also added to the map by GeoLibre automatically.

Chaining tools: use one tool's output path as the next tool's input, e.g. *Breach Depressions Least
Cost* > *D8 Flow Accumulation* > *Extract Streams*.

## 5. Zonal statistics (raster values per polygon)
Use the **Zonal statistics** section of the plugin panel. (GeoLibre's own *GeoLibre Toolbox > Raster
> Zonal statistics* dialog only works in the desktop app.)
1. **Raster**: a raster in your folder (uploaded, or a tool result) or a shared raster.
2. **Zones**: a polygon layer on the map (loaded or drawn), or a GeoJSON file on the server. The zones
   do not need to be in the same projection as the raster.
3. Optional: **Band** (default 1) and **Field prefix** (e.g. `dem_` gives `dem_mean`).
4. Keep **Also download the table as CSV** ticked and click **Run zonal statistics on the server**.

You get, for every zone: count, min, max, mean, sum, std and median. The zones are added to the map
with these values (click a zone to see them) and the table downloads as a CSV for Excel.

## 6. Tips and troubleshooting
| Problem | What to do |
|---|---|
| The tool fails with "could not read input" or runs very slowly | Untick **Run locally (WASM)** in the tool dialog. |
| "Failed: Tool execution failed" | Check the input path (use **Copy path**), or pick the layer from the input list. Ask your trainer to look at the server log if it persists. |
| My result is not in the file list | Click **Refresh** in the Data tab. If it is still missing, the tool failed: check its message. |
| Status says *Wrong access code* or *Not connected* | Re-type the server address and code exactly, **Save and connect**. |
| My files are gone | You are probably in a new browser or cleared its data: enter your old id under **Use an existing folder id**. |
| The plugin disappeared after the trainer updated it | **Settings > Manage Plugins > Settings**: remove the plugin URL and add it again, then turn it on under **Plugins > Installed**. |
| "File too large" | Ask your trainer; the limit is set on the server (500 MB by default). Clip rasters to your study area first. |

Measurements: with **Measure in metres** on, results are in m² / metres. Downloaded vector results of
Whitebox tools are in UTM coordinates (the local metre grid); on the map they are shown in place.

---

# For trainers

## Deploy (Ubuntu with Docker, about 20 minutes)
1. DNS: point a name, e.g. `sidecar.example.org`, at the server. Open ports 80 and 443 only.
2. Install Docker: `curl -fsSL https://get.docker.com | sudo sh`
3. Get the code: `sudo git clone https://github.com/spareeth/geo-training-stack.git /opt/geo-training-stack`
4. `cd /opt/geo-training-stack/remote-sidecar && sudo cp .env.example .env`, then set in `.env`:
   `SIDECAR_SITE` (the DNS name), `ACME_EMAIL`, and a long random `ACCESS_CODE`.
5. `sudo docker compose up -d --build`. Caddy gets the HTTPS certificate on first start.
6. Check: `https://<SIDECAR_SITE>/plugin/plugin.json` opens in a browser, and
   `https://<SIDECAR_SITE>/sidecar/health` answers *Access code required*.

Sizing: Whitebox tools are CPU and memory heavy; 8+ cores and 16-32 GB RAM for a class of 20-30.

## Before each course
- [ ] Set a new `ACCESS_CODE` in `.env` and run `sudo docker compose up -d`.
- [ ] Prepare the data. **Rasters** go on the server as shared files (read-only for participants), so
      nobody uploads the same large file over the classroom Wi-Fi:
      `sudo docker compose cp dem.tif files:/data/` (repeat per file; clip to the study area and
      use GeoTIFF). **Vectors** go in a zip for participants (study area, zones, roads...), preferably
      as GeoJSON in latitude/longitude (EPSG:4326).
- [ ] Do the participant setup yourself on a laptop and run sections 4 and 5 once with the course
      data.
- [ ] Give participants: the server address, the access code, the vector zip, and the link to this
      guide ("For participants" above).
- [ ] Do not update the plugin during the course (GeoLibre drops an updated plugin until each
      participant re-adds it).

## After the course
- Change `ACCESS_CODE`.
- Delete participant folders and caches:
  `sudo docker compose exec files sh -c 'rm -rf /data/u-* /data/.display /data/.crs /data/.utm'`

## Updating
`cd ~/geo-training-stack && git pull && cd remote-sidecar && docker compose up -d --build && docker compose restart files`
(between courses only; see plugin pinning below). The file service's code is mounted from the
repo, so it must be restarted to pick up changes.

---

# Technical notes

```
web.geolibre.app (participant's browser)
  └─ Remote Processing plugin ── redirects GeoLibre's /sidecar requests, adds the access code,
        │                         the participant folder id and the "measure in metres" flag
        ▼  HTTPS
  this server: Caddy (TLS, CORS for web.geolibre.app, access code)
        ├─ /sidecar/whitebox/run, /sidecar/whitebox/output  file service (UTM auto-projection)
        ├─ /sidecar/*  GeoLibre image's Python sidecar (WhiteboxTools, rasterio, GeoPandas)
        ├─ /files      upload / list / delete / map-ready copies (same image)
        ├─ /data/*     files (downloads, map layers)
        └─ /plugin/*   the plugin itself (public, for installing)
```

Only `geolibre-plugin/remote-processing/` from the parent folder is used (mounted as the plugin).

- **How the redirect works.** GeoLibre's web build always calls `<its own address>/sidecar`; the
  plugin wraps the browser's `fetch` so those calls go to this server instead. This relies on GeoLibre
  internals and is not an official plugin API, so re-test after GeoLibre updates (tested with
  web.geolibre.app on 2026-10-08).
- **GeoLibre Toolbox > Raster** tools (hillshade, clip, reclassify, raster calculator, zonal...)
  cannot be started from GeoLibre's own dialog on the web (it requires the desktop app). Whitebox
  Toolbox tools cover the same operations and do run on the server. The plugin's Zonal statistics
  form calls GeoLibre's zonal tool on the sidecar directly (`/sidecar/raster/run`); results were
  checked against rasterio: identical. Whitebox *Zonal Statistics* also works but needs raster zones.
- **Units: automatic.** Whitebox measures in the units of the data's coordinates. With **Measure in
  metres** (default) the file service reprojects lat/lon vector inputs and geographic rasters of each
  Whitebox job to the UTM zone of the data's centre (rasters cached in `/data/.utm`), records the
  outputs' CRS (`/data/.crs`), and returns vector outputs in lat/lon to GeoLibre's own output layer
  and the plugin. Raster outputs stay in UTM. Data spanning several UTM zones is measured in the
  zone of its centre, with small distortion towards the edges.
- **Personal folders.** The plugin creates a folder id (`u-` + 10 random letters/digits) on first
  use and keeps it in the browser; it is sent as `X-Participant` and the file service confines
  uploads, listing, deletes and map copies to `/data/<id>/`. Uploads with `If-None-Match: *` are
  refused if the file exists (the plugin then asks). This prevents accidents, not misuse: anyone with
  the access code can type another folder's path into a GeoLibre tool.
- **Image fix.** The published GeoLibre image lacks `contourpy`, which its sidecar's raster runtime
  needs; `Dockerfile.geolibre` adds it. Remove it once the upstream image includes it.
- **Plugin pinning.** GeoLibre stops loading a plugin whose code changed until it is removed and
  re-added; do not change the plugin during a course.
- **Limits.** Upload: `MAX_UPLOAD_MB` (default 500). Vector layers sent with jobs: up to 200 MB
  (`nginx-body-size.conf`).
- **Local test.** `SIDECAR_SITE=localhost`, `HTTPS_PORT=8443`, then use `https://localhost:8443` in
  the plugin (accept the self-signed certificate in the browser first). Recent Chrome may ask before
  letting a public site reach `localhost`; this does not apply to a real server.
