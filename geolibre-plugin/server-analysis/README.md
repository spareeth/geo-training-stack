# Server Analysis plugin for GeoLibre

Adds a **Server Analysis** panel to the hosted GeoLibre:

- **Data**: browse the course STAC catalogue (or Earth Search), list items in the current map view,
  add rasters (drawn as server-rendered tiles via TiTiler) and vectors.
- **Tools**: run analysis on the server. Zonal statistics, suitability (weighted overlay),
  accessibility, buffer screening, and the full WhiteboxTools toolbox (search by name).
  Inputs come from layers on the map, drawn shapes, OpenStreetMap or catalogue refs. The current
  view or a drawn shape limits the area, so jobs stay fast.
- **Jobs**: status and summaries. Result rasters and vectors are added to the map automatically.

## Install (once per browser)
GeoLibre, Plugins, Install from URL: `https://DOMAIN/plugins/server-analysis/plugin.json`.
If the URL install is not offered in your GeoLibre version, use Install from file with
`server-analysis.zip` (build it with `node build.mjs --zip`).

## Updates
GeoLibre pins the bundle hash per manifest URL. Any change to `dist/` (version bump or not) makes it
skip the plugin until the user removes and re-adds the URL. Ship updates between courses.

## Develop
Source is in `src/` (`core.js` logic, `ui.js` panel). GeoLibre needs one self-contained file:
```
node build.mjs          # writes dist/index.js
node --test test/core.test.mjs
```
