# Uganda case studies: from national census to a district plan (Moroto)

Three worked case studies for the GEIDA training, done entirely in the browser:
**https://web.geolibre.app** with the **Remote Processing** plugin (heavy tools run on the course
server). They start from Uganda's 2024 census at subcounty level, narrow down to one district, and
answer three planning questions there.

The projects named below are **hypothetical**, written to give each exercise a purpose. The data and
places are real. All results quoted under "What you should see" come from test runs on the course
server in October 2026; small differences are normal.

| Part | Question | Main tools |
|---|---|---|
| 0 | Where in Uganda should a programme focus? | Select by Expression, Export Selected Features |
| 1 | Who lives far from a school in Moroto? | Vector Points To Raster, Euclidean Distance, Reclass, Multiply, Zonal statistics |
| 2 | Who lives far from a health centre (and from a proper one)? | Same chain, with an attribute filter on facility level |
| 3 | What would a Moroto–Tapac road upgrade cross? | Buffer, Slope, Reclass, Zonal statistics, Select by Location |

## Data

**Vectors** (in `Moroto_course_data.zip`; open with **Add Data > Vector Layer**):

| File | Contents |
|---|---|
| `uganda_subcounties_census2024.geojson` | All 2,205 subcounties with NPHC 2024 census fields (UBOS) |
| `moroto_subcounties_census2024.geojson` | The 9 subcounties of Moroto district |
| `moroto_schools_osm.geojson` | 106 schools and kindergartens (OpenStreetMap, Moroto + 10 km) |
| `moroto_health_facilities_osm.geojson` | 31 health facilities (OpenStreetMap), duplicates removed, `level` = HC II / HC III / Hospital |
| `moroto_roads_osm.geojson` | Roads and paths (OpenStreetMap) |
| `moroto_tapac_road.geojson` | The 27 km Moroto town – Tapac route used in Part 3 |

**Rasters** (already on the server: plugin **Data** tab > **Shared course data**):

| File | Contents |
|---|---|
| `moroto_dem_30m.tif` | Copernicus DEM 30 m, 719 m (plains) to 3,079 m (Mt Moroto) |
| `moroto_landcover_10m.tif` | ESA WorldCover 2021: 10 tree cover, 20 shrubland, 30 grassland, 40 cropland, 50 built-up, 60 bare, 80 water, 90 wetland |
| `moroto_population_2024_100m.tif` | WorldPop 2024 (constrained), people per 100 m cell |

Useful census fields: `pop_total`, `pop6_12`, `oos6_12` and `pct_oos612` (children 6–12 out of
school), `pct_oos131` (13–17), `pct_watimp` (improved water), `pct_grid` (grid electricity),
`pop_dens`. The full list is in the data package's `docs/data_dictionary.csv`.

## Before you start
- Plugin installed and connected (see the participant guide): **Remote Processing > Server connection
  and files**, server address and access code, **Save and connect**. Keep **Measure in metres** ticked.
- In every Whitebox tool: **untick "Run locally (WASM)"**. Leave **Output** on **Auto** or type a short
  name (e.g. `dist_school`); results appear in the plugin's **Data** tab.
- For raster inputs, choose **Path** and paste the server path (**Copy path** in the Data tab), e.g.
  `/data/moroto_population_2024_100m.tif`. For vector inputs, pick the layer from the list.

---

## Part 0: From Uganda to Moroto (selecting by attributes)

**Context.** A (hypothetical) *Karamoja Education and Health Access Programme* must choose one district
for its first phase. The evidence: the 2024 census at subcounty level.

1. **Add Data > Vector Layer**: `uganda_subcounties_census2024.geojson`. 2,205 subcounties appear.
2. Click a few subcounties to read their attributes (`pop_total`, `pct_oos612`, `pct_watimp`...).
   Optionally colour the layer by `pct_oos612` from its style settings (palette icon in the Layers
   panel) to see the national pattern of out-of-school children.
3. **Edit > Select by Expression...** (expressions are written in MapLibre's JSON form; the
   **Expression builder...** helps):
   - `["==", ["get", "Subregion"], "Karamoja"]`, **Creating a new selection**, **Select features**.
   - Then `[">", ["get", "pct_oos612"], 70]` with **Selecting within the current selection**.
4. **Edit > Zoom to Selection**.
5. Choose the district: `["==", ["get", "District"], "Moroto"]` (new selection), then **Edit > Export
   Selected Features as Layer**. This is the study area (or load `moroto_subcounties_census2024.geojson`).

**What you should see.** The Karamoja selection has **113 subcounties**. Karamoja is the outlier: 74.6 % of children aged 6–12 are out of school,
against 20–35 % in other subregions. Within Karamoja, **67 subcounties** have more than 70 % out of
school. GeoLibre also reports **6 subcounties that could not be evaluated**: they have no census
figures (Nakapiripirit's five and Lobule refugee camp, documented in the data's `data_note`). Moroto
has 9 subcounties, 103,639 people, Mt Moroto (3,079 m) and the regional town.

**Discuss**
- Why Moroto rather than Amudat (86 % out of school)? Data coverage (OpenStreetMap has 66 schools and
  38 health facilities in Moroto), terrain for Part 3, and the town/rural contrast.
- What does a missing value do to a selection? Try `["==", ["get", "pop_total"], null]`.
- Try **Filter layer** instead of **Select features**: what is the difference?

---

## Part 1: Who lives far from a school? (Moroto)

**Context.** The programme wants to know where new classrooms would bring the most children within
walking distance (5 km), and whether distance explains the high out-of-school rates.

**Steps** (Whitebox Toolbox; untick *Run locally (WASM)* in each tool):
1. **Add Data > Vector Layer**: `moroto_schools_osm.geojson` and `moroto_subcounties_census2024.geojson`.
2. **Vector Points To Raster**: Input = the schools layer; **Base** = Path
   `/data/moroto_population_2024_100m.tif`; tick **Zero background**; Output `school_r`.
   (Burns the schools onto the population grid.)
3. **Euclidean Distance**: Input = Path to `school_r.tif` (Copy path); Output `dist_school`.
   Distance in metres to the nearest school, for every 100 m cell.
4. **Reclass**: Input `dist_school.tif`; **Reclass values** `0;0;5000;1;5000;1000000`; Output
   `far_school`. (Rows of *new value; from; up to*: 0 within 5 km, 1 beyond.)
5. **Multiply**: Input 1 `far_school.tif`, Input 2 `/data/moroto_population_2024_100m.tif`; Output
   `pop_far_school`. People living more than 5 km from a school.
6. Plugin **Data** tab > **Zonal statistics**: Raster `dist_school.tif`, Zones = the Moroto
   subcounties layer, prefix `dist_`. Again with `pop_far_school.tif` (prefix `far_`) and with the
   population raster (prefix `pop_`). Keep **Also download the table as CSV** ticked.
7. Open the CSVs in a spreadsheet; compare `far_sum` / `pop_sum` with the census `pct_oos612`.

**What you should see.**

| Subcounty | Mean distance (km) | People > 5 km | Share > 5 km | Out of school 6–12 |
|---|---|---|---|---|
| **Tapac** | 8.5 | 6,659 | **41 %** | **89 %** |
| Rupa | 28.5 | 6,240 | 30 % | 52 % |
| Nadunget | 2.8 | 1,032 | 6 % | 58 % |
| Loputuk | 3.5 | 601 | 3 % | 62 % |
| Katikekile | 3.4 | 275 | 2 % | 65 % |
| Lotisan, Nadunget TC, North and South Division | ≤ 2.1 | 0 | 0 % | 19–80 % |

About 14,800 people (11 % of Moroto) live more than 5 km from a school. **Tapac** stands out: far
from schools *and* 89 % of its children out of school.

**Discuss**
- Rupa's *mean* distance is 28.5 km but only 30 % of its people are beyond 5 km. Why? (Large empty
  areas; people cluster near schools.)
- Lotisan has 80 % out of school yet nobody beyond 5 km. What other barriers matter?
- WorldPop gives 130,000 people for Moroto; the census 103,639. Which do you trust, and for what?

---

## Part 2: Who lives far from a health centre?

**Context.** The district health office asks which subcounties lack access to a health centre that
offers more than basic care (HC III and above).

**Steps**
1. **Add Data > Vector Layer**: `moroto_health_facilities_osm.geojson`. Inspect the attributes: the
   `level` field was derived from the names (OpenStreetMap tags every facility as "hospital", and
   several were mapped twice).
2. Repeat Part 1 steps 2–6 with the health facilities (outputs `health_r`, `dist_health`,
   `far_health`, `pop_far_health`).
3. Now only facilities at HC III or above: **Edit > Select by Expression**
   `["in", ["get", "level"], ["literal", ["HC III", "HC IV", "Hospital"]]]`, then **Export Selected
   Features as Layer**, and run the chain again with that layer (outputs `..._hc3`).

**What you should see.**

| Subcounty | Share > 5 km, any facility | Share > 5 km, HC III or above |
|---|---|---|
| **Tapac** | 61 % | **75 %** |
| Rupa | 29 % | 31 % |
| Lotisan | 31 % | 31 % |
| Katikekile | 4 % | **27 %** |
| Loputuk | 6 % | **22 %** |
| Nadunget | 10 % | 13 % |
| Town council and divisions | 0 % | 0 % |

16 of the 31 facilities are HC III or above. People more than 5 km from any facility: about 20,700
(16 %); from an HC III or above: about 30,500 (23 %). Requiring a proper health centre reveals gaps in
Katikekile and Loputuk that the "any facility" map hides.

**Discuss**
- OpenStreetMap is incomplete and was cleaned here. How would you check it against the Ministry of
  Health facility list?
- Straight-line distance ignores Mt Moroto. *Cost Distance* with slope as the cost layer is the next
  step (try it on `slope.tif` from Part 3).

---

## Part 3: Screening a road upgrade, Moroto town – Tapac

**Context.** Tapac is the least served subcounty in Parts 1 and 2. A (hypothetical) *Moroto–Tapac
Rural Access Road* would upgrade the existing 27 km track. Screening question: what terrain, land
cover and people does a 1 km corridor on each side cross?

**Steps**
1. **Add Data > Vector Layer**: `moroto_tapac_road.geojson` (and the schools and health layers).
2. **Corridor:** **Processing > GeoLibre Toolbox > Vector > Buffer**: Input = the road, Distance `1`,
   Units **Kilometers**, engine **Client (Turf.js)**, **Run**. A "Buffer" layer appears.
   (This runs in your browser; it is instant for one line.)
3. **Slope:** Whitebox **Slope**: Input Path `/data/moroto_dem_30m.tif`, units degrees, Output `slope`.
4. **Steep terrain:** **Reclass**: Input `slope.tif`, values `0;0;15;1;15;90`, Output `steep15`
   (1 where slope is over 15°).
5. **Land cover classes:** **Reclass** on `/data/moroto_landcover_10m.tif`, one class at a time, e.g.
   cropland `0;0;40;1;40;41;0;41;256` → `cropland` (1 = cropland). Same pattern for grassland (30),
   shrubland (20), built-up (50).
6. **Corridor statistics:** plugin **Zonal statistics** with Zones = the Buffer layer:
   - `slope.tif`: mean, max, median slope
   - `steep15.tif`: the mean is the share of the corridor steeper than 15°
   - each class raster: the mean is that class's share of the corridor
   - `/data/moroto_population_2024_100m.tif`: the sum is the people in the corridor
7. **Facilities along the road:** **Edit > Select by Location...**: schools (then health facilities)
   that are within the Buffer layer.
8. Add `slope.tif` to the map (Data tab > **Add to map**) and style it with a colour ramp to see where
   the route climbs.

**What you should see.**
- Corridor: 56.7 km² around a 27.2 km route.
- Slope: mean 5.8°, median 2.9°, maximum 51°; **11 % of the corridor is steeper than 15°** (the
  section along the Mt Moroto foothills).
- Land cover: grassland 55 %, shrubland 31 %, cropland 10 %, built-up 2.5 %, tree cover 1.7 %.
- About **35,500 people** live in the corridor (WorldPop 2024), with **16 schools** and **5 health
  facilities** (Moroto's 2 hospitals, 2 HC II, 1 other).

**Discuss**
- Where are the steep sections? Would a realignment avoid them? (Look at slope along the route.)
- Little cropland is lost, but what does grassland mean in Karamoja (pastoralism, grazing routes)?
- Who benefits? Combine with Part 1 and 2: how many people beyond 5 km of a school or HC III live in
  Tapac, which the road would connect to Moroto town?

---

## Notes for facilitators
- **Test the chain the day before** with the course data; the rasters are already shared on the
  server, so participants only open vectors and run tools.
- **Run locally (WASM)** must be unticked in every Whitebox dialog; this is the most common mistake.
- **Reclass values** use the classic Whitebox format `new;from;to;new;from;to...` (semicolons). Whitebox
  comparison tools (Greater Than, Equal To...) need two rasters, so Reclass is the way to threshold.
- **Buffers of real roads:** use GeoLibre's own Buffer (step 3.2). Whitebox *Buffer Vector* returns
  wrong corridors for long, winding lines (fine for polygons and simple lines).
- **Zonal statistics** uses the plugin's form, not GeoLibre's *Raster tools* dialog (desktop only).
- **Data caveats to raise:** OpenStreetMap completeness and the health-facility cleanup; WorldPop vs
  census totals; simplified UBOS boundaries with small overlaps (see the census package README).
- **Licences:** UBOS NPHC 2024; OpenStreetMap (ODbL); Copernicus DEM; ESA WorldCover (CC BY 4.0);
  WorldPop (CC BY 4.0). Cite them in outputs.
