# Case studies: server-side analysis in GeoLibre

Five worked workflows for the training. The projects and the organisations named in them are
**hypothetical**, written to give each exercise a realistic purpose; the places and data are real.
All data comes from the **Course catalogue** (public datasets, nothing to upload) and every step
runs on the server, so it works on any laptop with a browser.

Numbers quoted under "What you should see" come from test runs in October 2026. Your results will
differ a little if you draw shapes differently or the source data has been updated.

| # | Case study | Sector | Modules used |
|---|---|---|---|
| 1 | Who is more than 5 km from a health post? | Health | Accessibility, zonal statistics, CSV |
| 2 | Where should the next schools go? | Education | Suitability (MCDA) |
| 3 | What does a road upgrade affect? | Transport | Buffer screening, Overture buildings |
| 4 | Where do check dams make sense? | Water / nature-based solutions | GeoLibre's own Whitebox tools on the server, zonal statistics |
| 5 | A district profile for investment planning | Cross-sector | Zonal statistics, CSV |

## Before you start (once per browser)
1. Open the training site and log in.
2. **Settings > Manage Plugins > Settings** tab, paste the plugin URL under **Manifest URLs**, **Add**.
3. **Plugins > Server Analysis**, then **Server Analysis > Open data and analysis panel**.
4. Move the map by typing coordinates (for example `14.15, -16.07`) in the search box at the
   bottom of the Layers panel.

Panel tabs: **Data** (find and add data), **Tools** (analysis), **Workspace** (GeoLibre's own tools
on the server), **Jobs** (status, summaries, CSV downloads). Every raster you add gets a **legend**
in the bottom-left corner of the map.

Two habits that save time:
- **Zoom to the study area first.** "Current map view" is the default analysis area, and the server
  only reads data for that area.
- **Prefer "all tiles over the area"** in raster pickers. After you add a raster from the Course
  catalogue, each raster picker also lists "*collection*: all tiles over the area", which stitches
  every tile your area touches. A single tile may cover only part of your area.

---

## Case study 1: Who is more than 5 km from a health post? (Accessibility)

**Context.** The (hypothetical) *Saloum Primary Health Access Initiative* is preparing a financing
request for new health posts in Kaolack, Senegal. The appraisal team needs evidence of the access
gap: how many people live more than 5 km from any health facility, and where they are.

**Question.** What share of the population in the Kaolack area lives beyond 5 km of a health
facility, and which districts are worst served?

**Data (Course catalogue).** *Health facilities (OpenStreetMap)* for Senegal; *Population, Meta High
Resolution Settlement Layer 30 m*, item "Total population"; *Administrative boundaries
(geoBoundaries Open)*, item SEN-ADM2.

**Steps**
1. Go to `14.15, -16.07` and zoom out until Kaolack town and its surroundings fill the map (about
   50 km across).
2. **Data**: search `health`, open *Health facilities (OpenStreetMap)*, **Show items in current
   view**, **Add data** (SEN). The facilities appear as points.
3. **Data**: search `population`, open the HRSL collection, **Show items**, **Add** *Total
   population*. Its legend shows people per 30 m cell.
4. **Tools > Accessibility**:
   - Area: *Current map view*
   - Facilities: *Health facilities (OpenStreetMap) SEN* from the layer list
   - Population raster: *Population ... Total population*
   - Distance limit: `5000` m; cell size: `100` m
   - **Run on server**
5. The **Jobs** tab shows the summary, and the map shows the distance surface (legend in metres)
   plus the facilities that were measured to.

**What you should see.** 67 facilities; about 600,000 people in the area; only **53 % within 5 km**
(about 280,000 people beyond); the furthest point about 19.5 km from a facility.

**Go further: rank the districts**
1. Add *Administrative boundaries (geoBoundaries Open)*, item SEN-ADM2.
2. **Tools > Zonal statistics**: raster = the *Accessibility distance (m)* result; zones = the
   SEN-ADM2 layer; statistics `mean`, `max`; keep **Also download the table as CSV** ticked.
3. Open the CSV in a spreadsheet and sort by `mean`: the top districts are your shortlist.

**Discuss**
- Is 5 km the right standard? Re-run with 3 km (walking) and 10 km (motorised).
- OpenStreetMap misses facilities in places. Compare with *Places (Overture Maps)* filtered to
  clinics: how does the gap change?
- Straight-line distance ignores rivers and roads. What would a travel-time model add?

---

## Case study 2: Where should the next schools go? (Suitability / MCDA)

**Context.** The (hypothetical) *Kaolack Basic Education Expansion Project* will build early-learning
centres. The ministry asks for candidate sites that are flat, reachable by road, close to many young
children, and not in water, wetland or already built-up land.

**Question.** Which 5 sites of at least 5 ha score highest on these criteria?

**Data.** *Elevation, Copernicus DEM 30 m*; *Roads (OpenStreetMap)* SEN; HRSL *Children under five*;
*Land cover, ESA WorldCover 10 m* (2021).

**Steps**
1. Same area as case study 1 (about 50 km around Kaolack).
2. **Data**: add one DEM tile, one WorldCover 2021 tile and *Children under five* for the view.
   This makes "*...: all tiles over the area*" available in the pickers. Add *Roads (OpenStreetMap)*
   SEN too.
3. **Tools > Suitability**. Area: *Current map view*; cell size `100` m. Criteria (use **+ Add
   criterion**):

   | Name | Type | Input | Scoring | Direction | Weight |
   |---|---|---|---|---|---|
   | Slope | Slope from a DEM | Elevation: all tiles over the area | 0 to 10 (degrees) | Lower is better | 1 |
   | Road access | Distance to features | Roads (OpenStreetMap) SEN | 0 to 3000 (m) | Lower is better | 2 |
   | Children nearby | Raster value | Children under five | 0 to 30 (children per cell) | Higher is better | 3 |

   Exclusions (**+ Add exclusion**): *Exclude raster classes*, raster *Land cover: all tiles over the
   area*, class codes `50, 80, 90` (built-up, water, herbaceous wetland).

   Best sites: minimum score `0.6`; minimum site area `5` ha; number of sites `5`. **Run on server**.

**What you should see.** About 10 % of the area excluded (water, wetland and built-up land along the
Saloum). Scores run from about 0.15 to 0.69, and five candidate sites of 5 to 10 ha with scores
around 0.66 to 0.67, all close to roads on the edges of villages. The *Suitability score* legend
runs from red (poor) to green (good).

**Discuss**
- The weights (1 : 2 : 3) are a judgement. Change them and see which sites stay in the top 5.
  Robust sites are the ones to visit first.
- Children under five per 30 m cell is a small number. Try 0 to 10 and see the effect.
- Add **Schools and education facilities (OpenStreetMap)** as a "distance, higher is better"
  criterion so new sites avoid existing schools.

---

## Case study 3: What does a road upgrade affect? (Buffer screening)

**Context.** The (hypothetical) *Kaolack–Kaffrine Rural Connectivity Project* proposes upgrading a
road eastwards from Kaolack. Environmental and social screening needs the land cover, the population
and the buildings within 1 km of the alignment, before any field survey.

**Question.** How much cropland, wetland and water does a 1 km corridor cross, and how many people
and buildings are inside it?

**Data.** *Land cover, ESA WorldCover 10 m*; HRSL *Total population*; *Surface water, JRC*; *Buildings
(Overture Maps)*.

**Steps**
1. Go to `14.13, -15.80` and zoom so Kaolack (west) and the road to Kaffrine (east) are both visible.
2. **Plugins > GeoEditor**, **Activate**. Choose **Line** and click along the road you want to screen
   (about 55 km); double-click to finish.
3. **Data**: add one WorldCover 2021 tile, *Total population* and one *Surface water*
   (occurrence) tile for the view.
4. **Tools > Buffer screening**: Road = *Drawn shapes*; distance `1000` m. Layers (**+ Add layer**):
   *Land cover: all tiles over the area* with **Categorical** ticked; *Total population*; *Surface
   water ... occurrence*. **Run on server**.
5. Buildings: zoom in to a stretch of the corridor (a few km), **Data** > search `overture
   buildings` > **Add for current view**.

**What you should see.** A corridor of about 11,700 ha; land cover about 58 % cropland (40), 18 %
grassland (30), 6 % shrubland, 5 % built-up (50), 3.5 % water (80) and 3.5 % herbaceous wetland
(90); about 55,000 people inside; surface water occurrence reaches about 94 % (water is present
almost every year somewhere in the corridor: the Saloum crossing). The corridor outline is drawn on
the map.

**Discuss**
- Which sections cross wetland (90) or water (80)? Those need drainage design and possibly
  environmental permits.
- Buildings within 50 m of the carriageway signal possible resettlement. How would you count them?
  (Try zonal statistics with a 50 m buffer as the zone.)
- Re-run with 5 km to see the project's wider area of influence.

---

## Case study 4: Where do check dams make sense? (GeoLibre's own Whitebox tools on the server)

**Context.** The (hypothetical) *Hajar Water Harvesting Pilot* in the mountains west of Fujairah
(UAE) will build small check dams to slow flash floods and recharge groundwater. Engineers need the
drainage network and the steep, dry valleys where dams can be placed.

**Question.** Where are the main stream channels, and which of them run through moderately steep,
bare terrain?

**Data.** *Elevation, Copernicus DEM 30 m*; *Land cover, ESA WorldCover*. **Tools**: GeoLibre's own
**Processing > Whitebox Toolbox**, run on the server through the Workspace.

**Steps**
1. Go to `25.20, 56.20` (zoom about 12, roughly 13 km across).
2. **Data**: add the DEM tile for the view.
3. **Workspace** tab: Raster to copy = the DEM; File name `dem-hajar`; Area = *Current map view*;
   **Copy into workspace**. Note the path: `/data/dem-hajar.tif`.
4. **Processing > Whitebox Toolbox**. In each tool, **untick "Run locally (WASM)"**, set inputs to
   **Path**, and type the output path:

   | Tool | Input | Settings | Output |
   |---|---|---|---|
   | Breach Depressions Least Cost | `/data/dem-hajar.tif` | Fill deps: on | `/data/dem-breached.tif` |
   | D8 Flow Accumulation | `/data/dem-breached.tif` | Out type: cells | `/data/flow-acc.tif` |
   | Extract Streams | `/data/flow-acc.tif` | Threshold `500` | `/data/streams.tif` |
   | Slope | `/data/dem-hajar.tif` | degrees | `/data/slope-hajar.tif` |

5. **Workspace** tab: **Refresh**, then **Add to map** for `streams.tif` and `slope-hajar.tif`.
6. Add WorldCover for the view: bare / sparse vegetation (60) dominates the dry slopes.

**What you should see.** Flow accumulation reaches about 87,000 upstream cells at the main wadi
outlet. With a threshold of 500 cells (about 0.45 km²) the stream network has about 6,500 cells
and follows the wadis you can see on the basemap. Slopes reach 40 to 50 degrees on the ridges.

**Go further**
- Zonal statistics on `slope-hajar.tif` (it is listed as a raster input once added) with polygons
  drawn around candidate valleys: dams suit valley floors of about 2 to 8 degrees.
- Raise the stream threshold to 2,000 to keep only main channels; lower it to 100 for gullies.
- Other GeoLibre Whitebox tools that work the same way: *Strahler Stream Order*, *Watershed*,
  *Hillshade*, *Wetness Index*.

**Why the Workspace?** GeoLibre's own tools run on the server only when "Run locally (WASM)" is
unticked, and the server can only read files in its `/data` folder. The Workspace tab puts catalogue
data there (clipped to your area), and brings the results back to the map.

---

## Case study 5: A district profile for investment planning (Zonal statistics)

**Context.** A (hypothetical) country partnership strategy team for Senegal wants a one-page
evidence table per district: people, how agricultural the district is, and access to health
services. It will feed a prioritisation workshop.

**Question.** For each of Senegal's 45 districts (ADM2): population, mean cropland cover, and mean
distance to a health facility.

**Data.** *Administrative boundaries (geoBoundaries Open)* SEN-ADM2; HRSL *Total population*;
*Land cover and cover fractions, Copernicus CGLS 100 m* (2019, layer *crops coverfraction*);
the distance raster from case study 1.

**Steps**
1. Zoom to the whole of Senegal. **Data**: add SEN-ADM2 boundaries, HRSL *Total population*, and
   the CGLS 100 m 2019 item's *crops coverfraction layer*.
2. **Tools > Zonal statistics**, three runs with zones = SEN-ADM2, CSV ticked each time:
   - raster *Total population*, statistic `sum`
   - raster *crops coverfraction layer*, statistic `mean`
   - raster *Accessibility distance (m)* from case study 1 (Kaolack area only), statistic `mean`
3. Combine the three CSVs in a spreadsheet using the district name (`shapeName`) and the `zone`
   column. (The plugin also adds the results to the map: click a district to see its values.)

**What you should see.** Population: Pikine (about 1.6 million), Dakar (about 1.4 million) and
Mbacké (about 1.15 million) lead. Cropland: the groundnut basin districts lead (Mbacké about 50 %,
Gossas about 48 %, Nioro du Rip about 47 %, Kaffrine 45 %), while Dakar and Guédiawaye are near 1 to
2 %. The national population run takes about 30 seconds.

**Discuss**
- Cropland per person: divide cropland share × district area by population. Which districts are
  most agricultural per head?
- The ADM2 boundaries come from geoBoundaries *Open*. Compare with *Administrative boundaries,
  humanitarian (UN OCHA COD)*: are the district names and borders the same as those used by the
  ministry?
- Which other catalogue layers belong in the profile? (Wealth index points, water occurrence,
  tree cover density...)

---

## Notes for facilitators
- **Prewarm the class countries** the day before (roads and buildings files are large):
  `docker compose exec pygeoapi /venv/bin/python -m training_processes.vector_cache --countries SEN,ARE`
- **Run each case once before class.** OpenStreetMap layers fetched live (the Tools-tab
  "OpenStreetMap: ..." options) are cached on the server after the first run, which protects the
  class from busy public servers.
- **Large views are refused** with a clear "zoom in" message (more than 50,000 features, or rasters
  over about 60 million pixels for the Workspace). Teach trainees to zoom first.
- **The Workspace is shared** by everyone using the shared login: ask trainees to put their initials
  in file names (`ab-slope.tif`).
- **Licences**: OpenStreetMap and Overture (ODbL), WorldCover and HRSL (CC BY 4.0), Copernicus
  (free, with attribution), Relative Wealth Index (non-commercial only). Cite sources in outputs.
