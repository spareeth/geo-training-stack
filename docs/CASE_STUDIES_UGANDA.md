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
| 3 | What would a Moroto–Tapac road upgrade cross? | Buffer, Slope, Reclass, Zonal statistics (summary and class areas), Select by Location |
| 4 | How do I share a result as a map? | Style, Print Layout, plugin's Logo on a printed map |

## Data

**Vectors** (in `Moroto_course_data.zip`; open with **Add Data > Vector Layer**):

| File | Contents |
|---|---|
| `uganda_country.geojson` | Uganda outline |
| `uganda_regions.geojson` | The 4 regions, with `pop_total` |
| `uganda_subregions.geojson` | The 17 subregions (Karamoja among them), with `pop_total` |
| `uganda_districts.geojson` | The 146 districts, with `pop_total`, `n_subcounties`, `area_km2` |
| `uganda_subcounties_census2024.geojson` | All 2,205 subcounties with NPHC 2024 census fields (UBOS) |
| `moroto_subcounties_census2024.geojson` | The 9 subcounties of Moroto district |
| `moroto_schools_osm.geojson` | 106 schools and kindergartens (OpenStreetMap, Moroto + 10 km) |
| `moroto_health_facilities_osm.geojson` | 31 health facilities (OpenStreetMap), duplicates removed, `level` = HC II / HC III / Hospital |
| `moroto_roads_osm.geojson` | Roads and paths (OpenStreetMap) |
| `moroto_tapac_road.geojson` | The 27 km Moroto town – Tapac route used in Part 3 |
| `census_data_dictionary.csv` | Meaning and unit of every census field |

The four national boundary files are also on the server (**Shared course data > Vectors > Add to
map**). They were made by dissolving the census subcounties, so all levels line up; their `pop_total`
is the sum of the subcounties and leaves out Bidi Bidi settlement and the five Nakapiripirit
subcounties without figures.

**Rasters** (already on the server: plugin **Data** tab > **Shared course data**):

| File | Contents |
|---|---|
| `moroto_dem_30m.tif` | Copernicus DEM 30 m, 719 m (plains) to 3,079 m (Mt Moroto) |
| `moroto_landcover_10m.tif` | ESA WorldCover 2021: 10 tree cover, 20 shrubland, 30 grassland, 40 cropland, 50 built-up, 60 bare, 80 water, 90 wetland |
| `moroto_population_2024_100m.tif` | WorldPop 2024 (constrained), people per 100 m cell |

Useful census fields: `pop_total`, `pop6_12`, `oos6_12` and `pct_oos612` (children 6–12 out of
school), `pct_oos131` (13–17), `pct_watimp` (improved water), `pct_grid` (grid electricity),
`pop_dens`. All fields are explained in [Census attributes](#census-attributes) at the end.

## Before you start
- Rasters added from the plugin (**Add to map**) get a legend box at the bottom left of the map: a
  colour bar with the value range, or the WorldCover classes in their official colours for land cover.
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

1. **Context layers:** load `uganda_country`, `uganda_regions`, `uganda_subregions` and
   `uganda_districts`. Compare `pop_total` and `n_subcounties` (Karamoja: 1.43 million people in 113
   subcounties). Style them as outlines (fill opacity 0; thick for regions, thin grey for districts)
   and drag them to the top of the Layers panel.
2. **Add Data > Vector Layer**: `uganda_subcounties_census2024.geojson`. 2,205 subcounties appear.
3. Click a few subcounties to read their attributes (`pop_total`, `pct_oos612`, `pct_watimp`...).
   Optionally colour the layer by `pct_oos612` from its style settings (palette icon in the Layers
   panel) to see the national pattern of out-of-school children.
4. **Edit > Select by Expression...** (expressions are written in MapLibre's JSON form; the
   **Expression builder...** helps):
   - `["==", ["get", "Subregion"], "Karamoja"]`, **Creating a new selection**, **Select features**.
   - Then `[">", ["get", "pct_oos612"], 70]` with **Selecting within the current selection**.
5. **Edit > Zoom to Selection**.
6. Choose the district: `["==", ["get", "District"], "Moroto"]` (new selection), then **Edit > Export
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
5. **Land cover:** plugin **Zonal statistics**: Raster = Shared `moroto_landcover_10m.tif`,
   **Statistics = Area of each class**, Zones = the Buffer layer, prefix `lc_`. One run gives the
   km² and % of every class (`lc_grassland_km2`, `lc_grassland_pct`, `lc_cropland_pct`...). WorldCover
   codes are named automatically. Try it with the Moroto subcounties as zones too.
6. **Slope and people:** plugin **Zonal statistics**, Statistics = **Summary**, Zones = the Buffer:
   - `slope.tif`: mean, max, median slope
   - `steep15.tif`: the mean is the share of the corridor steeper than 15°
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

## Part 4: Print a result as a map, with the IsDB logo

**Goal.** Turn the Part 1 result into a report map: out-of-school children and schools in Moroto.

**Steps**
1. Keep on the map the Part 1 zonal statistics layer, the schools, `uganda_districts` and a light
   basemap; hide the rest.
2. Select the zonal layer, **Style** tab: **Graduated** on `pct_oos612`, 5 classes, yellow-to-red,
   fill opacity ~0.8. Schools: small dark circles; districts: thin grey outline, no fill. Rename
   layers (**⋯ > Rename**) so the legend reads well.
3. Zoom to Moroto district, north up.
4. **Project > Print Layout...**: Title *Moroto district: children out of school and distance to
   school*; Subtitle *Share of children aged 6–12 out of school, by subcounty (NPHC 2024)*; A4
   Landscape; tick Legend, Scale bar, North arrow, Date, Footer text (*Data: UBOS NPHC 2024;
   OpenStreetMap contributors; WorldPop 2024. GEIDA training, IsDB.*). **Recapture map** if needed.
5. **Export PNG**.
6. Plugin **Data > Logo on a printed map**: choose the exported PNG, leave Logo empty (IsDB logo),
   corner Bottom right, width 16 %, **Add logo and download**. You get `…-logo.png`.

For a land-cover map, click **Copy for print legend** in the map legend box, then in Print Layout tick
**Custom legend** > **Import from dictionary** and paste.

GeoLibre's Print Layout has no image element yet. **Controls > Image** (URL
`https://geolibre.terrawatch.net/plugin/assets/isdb-logo.png`) shows a logo on the screen map, but
the print layout leaves it out, hence step 6.

**Discuss**
- Which map tells the story better: out-of-school share or people beyond 5 km?
- What should every report map carry? (Title, legend, scale, north arrow, source, date, author.)

---

## Notes for facilitators
- **Test the chain the day before** with the course data; the rasters are already shared on the
  server, so participants only open vectors and run tools.
- **Run locally (WASM)** must be unticked in every Whitebox dialog; this is the most common mistake.
- **Reclass values** use the classic Whitebox format `new;from;to;new;from;to...` (semicolons). Whitebox
  comparison tools (Greater Than, Equal To...) need two rasters, so Reclass is the way to threshold.
- **Plugin version:** class areas and the logo tool need Remote Processing 0.5.0 or later (map legend). Anyone who
  installed earlier must remove the plugin URL and add it again.
- **Buffers of real roads:** use GeoLibre's own Buffer (step 3.2). Whitebox *Buffer Vector* returns
  wrong corridors for long, winding lines (fine for polygons and simple lines).
- **Zonal statistics** uses the plugin's form, not GeoLibre's *Raster tools* dialog (desktop only).
- **Data caveats to raise:** OpenStreetMap completeness and the health-facility cleanup; WorldPop vs
  census totals; simplified UBOS boundaries with small overlaps (see the census package README).
- **Licences:** UBOS NPHC 2024; OpenStreetMap (ODbL); Copernicus DEM; ESA WorldCover (CC BY 4.0);
  WorldPop (CC BY 4.0). Cite them in outputs.

## Census attributes

Source: Uganda Bureau of Statistics, NPHC 2024 Explorer (statistics.ubos.org/nphc), subcounty profiles.
`pct_` fields and `pop_dens` were derived for the course. A blank value means no published figure; `data_note` says why.


**Key**

| Field | Meaning | Unit |
|---|---|---|
| `SCCode` | UBOS 6-digit subcounty code (text): district (3) + county (1) + subcounty (2). Join key. |  |
| `Subcounty` | Subcounty, town council or city division name (UBOS) |  |

**Admin**

| Field | Meaning | Unit |
|---|---|---|
| `CntyCode` | UBOS 4-digit county code |  |
| `County` | County name |  |

**Key**

| Field | Meaning | Unit |
|---|---|---|
| `DCode` | UBOS 3-digit district code (text). Join key. |  |
| `District` | District name (UBOS) |  |

**Admin**

| Field | Meaning | Unit |
|---|---|---|
| `Region` | Region (from first digit of DCode) |  |
| `SubregCode` | UBOS subregion code |  |
| `Subregion` | Subregion name |  |

**Derived**

| Field | Meaning | Unit |
|---|---|---|
| `area_km2` | Subcounty area, computed in UTM 36N (EPSG:32636) | km2 |

**Population by sex**

| Field | Meaning | Unit |
|---|---|---|
| `pop_total` | Total population | persons |
| `pop_male` | Male population | persons |
| `pop_female` | Female population | persons |

**Households**

| Field | Meaning | Unit |
|---|---|---|
| `hh_pop` | Household population | persons |
| `households` | Number of households | households |
| `hh_size` | Average household size | persons/household |

**Age groups**

| Field | Meaning | Unit |
|---|---|---|
| `age0_4` | Population aged 0-4 | persons |
| `age0_17` | Population aged 0-17 | persons |
| `age6_12` | Population aged 6-12 | persons |
| `age13_18` | Population aged 13-18 | persons |
| `age14_64` | Population aged 14-64 | persons |
| `age15plus` | Population aged 15+ | persons |
| `age15_24` | Population aged 15-24 | persons |
| `age18_30` | Population aged 18-30 | persons |
| `age18plus` | Population aged 18+ | persons |
| `age60plus` | Population aged 60+ | persons |
| `age65plus` | Population aged 65+ | persons |
| `age80plus` | Population aged 80+ | persons |

**Birth registration**

| Field | Meaning | Unit |
|---|---|---|
| `br_cert` | Persons registered, with certificate | persons |
| `br_notif` | Persons registered, with notification | persons |
| `br_none` | Persons not registered | persons |

**ICT**

| Field | Meaning | Unit |
|---|---|---|
| `inet_male` | Persons aged 10+ who used internet, male | persons |
| `inet_fem` | Persons aged 10+ who used internet, female | persons |
| `inet_total` | Persons aged 10+ who used internet, total | persons |
| `hh_radio` | Households owning a radio | households |
| `hh_tv` | Households owning a television | households |
| `hh_comp` | Households owning a computer | households |

**Information sources**

| Field | Meaning | Unit |
|---|---|---|
| `inf_radio` | Households whose main source of information is radio | households |
| `inf_wom` | Households whose main source of information is word of mouth | households |
| `inf_phone` | Households whose main source of information is phone calls | households |
| `inf_tv` | Households whose main source of information is television | households |
| `inf_meet` | Households whose main source of information is community meetings | households |
| `inf_inet` | Households whose main source of information is internet/social media | households |
| `inf_annc` | Households whose main source of information is community announcer | households |
| `inf_print` | Households whose main source of information is print media | households |
| `inf_other` | Households whose main source of information is other sources | households |

**Health**

| Field | Meaning | Unit |
|---|---|---|
| `hh_mosnet` | Households owning a mosquito net | households |
| `p_hlthins` | Persons with health insurance | persons |

**Employment**

| Field | Meaning | Unit |
|---|---|---|
| `unemp15n` | Unemployed, aged 15+ | persons |
| `unemp15pct` | Unemployment rate, aged 15+ | % |
| `unemp1464n` | Unemployed, aged 14-64 | persons |
| `unemp1464p` | Unemployment rate, aged 14-64 | % |
| `neet1524n` | Youth not in employment, education or training (NEET), 15-24 | persons |
| `neet1524p` | NEET rate, 15-24 | % |
| `neet1830n` | NEET, 18-30 | persons |
| `neet1830p` | NEET rate, 18-30 | % |

**Water & sanitation**

| Field | Meaning | Unit |
|---|---|---|
| `wat_imp` | Households using an improved main drinking water source | households |
| `wat_unimp` | Households using an unimproved main drinking water source | households |
| `san_imp` | Households with improved sanitation | households |
| `san_unimp` | Households with unimproved sanitation | households |
| `open_def` | Households practising open defecation | households |

**Lighting**

| Field | Meaning | Unit |
|---|---|---|
| `lt_grid` | Households using grid electricity for lighting | households |
| `lt_solar` | Households using solar for lighting | households |
| `lt_solgrid` | Households using combined solar and grid for lighting | households |

**Economic**

| Field | Meaning | Unit |
|---|---|---|
| `hh_subsist` | Households in the subsistence economy | households |
| `hh_pdm` | Households that benefited from the Parish Development Model (PDM) | households |

**Education**

| Field | Meaning | Unit |
|---|---|---|
| `pop3_5` | Population aged 3-5 | persons |
| `noecce3_5` | Aged 3-5 not attending early childhood care and education | persons |
| `pop6` | Population aged 6 | persons |
| `noprim6` | Aged 6 not started primary | persons |
| `pop6_12` | Population aged 6-12 | persons |
| `oos6_12` | Out of school, aged 6-12 | persons |
| `pop13_17` | Population aged 13-17 | persons |
| `oos13_17` | Out of school, aged 13-17 | persons |

**Quality**

| Field | Meaning | Unit |
|---|---|---|
| `data_note` | Why a row has no figures or no polygon (blank = complete) |  |

**Derived**

| Field | Meaning | Unit |
|---|---|---|
| `pop_dens` | Population density = pop_total / area_km2 | persons/km2 |
| `pop6_17` | School-age population 6-17 = pop6_12 + pop13_17 | persons |
| `pct_noecce` | Share of children aged 3-5 not attending early childhood education = noecce3_5 / pop3_5 | % |
| `pct_noprm6` | Share of 6-year-olds who have not started primary = noprim6 / pop6 | % |
| `pct_oos612` | Share of children aged 6-12 out of school = oos6_12 / pop6_12 | % |
| `pct_oos131` | Share of children aged 13-17 out of school = oos13_17 / pop13_17 | % |
| `pct_age0_4` | Share of population aged 0-4 | % |
| `pct_watimp` | Share of households with improved drinking water = wat_imp / households | % |
| `pct_sanimp` | Share of households with improved sanitation = san_imp / households | % |
| `pct_grid` | Share of households lighting with grid electricity | % |
| `pct_subsis` | Share of households in subsistence economy | % |
