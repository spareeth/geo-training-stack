// Server Analysis plugin for GeoLibre. Built from src/ by build.mjs, do not edit.
// Pure helpers for the Server Analysis plugin. No DOM, so they run under `node --test`.
// build.mjs inlines this file into index.js because GeoLibre plugins must be one file.

const PATHS = { processes: "/processes-api", stac: "/stac", tiles: "/tiles", outputs: "/outputs" };

const CATALOGS = {
  local: { label: "Course catalogue", short: "Course", url: null },
  "earth-search": { label: "Earth Search (AWS open data)", short: "Earth Search", url: "https://earth-search.aws.element84.com/v1" },
  // CDSE files are s3://eodata hrefs that the server reads with its own CDSE keys, so they stay s3://.
  cdse: { label: "Copernicus Data Space (CDSE)", short: "CDSE", url: "https://stac.dataspace.copernicus.eu/v1", serverS3: true },
};

// Tools with hand-made forms. Every WhiteboxTools tool gets a generated form.
const SERVER_TOOLS = {
  "zonal-statistics": "Zonal statistics: summarise a raster inside each polygon",
  "suitability": "Suitability: weighted overlay of criteria, best sites",
  "accessibility": "Accessibility: distance to facilities, population served",
  "buffer-screen": "Buffer screening: what lies within a distance of a road or site",
};

const OSM_LAYERS = ["roads", "major_roads", "schools", "health", "hospitals", "water_points",
  "rivers", "markets", "settlements", "power_lines"];

const RASTER_TYPES = ["image/tiff", "application/x-geotiff", "image/vnd.stac.geotiff"];
const VECTOR_TYPES = ["application/geo+json", "application/json", "application/vnd.apache.parquet",
  "application/x-parquet", "application/flatgeobuf", "application/vnd.flatgeobuf",
  "application/geopackage+sqlite3", "text/csv"];

/** "raster" or "vector": the course catalogue says so; otherwise guess from asset types and keywords. */
function collectionKind(c) {
  const k = c["geotraining:kind"];
  if (k === "raster" || k === "vector") return k;
  const types = Object.values(c.item_assets || {}).map((a) => (a.type || "").toLowerCase().split(";")[0].trim());
  if (types.some((t) => VECTOR_TYPES.includes(t))) return "vector";
  if (types.some((t) => RASTER_TYPES.some((r) => t.startsWith(r)))) return "raster";
  const words = `${c.id} ${(c.keywords || []).join(" ")}`.toLowerCase();
  return /vector|geoparquet|boundar|building|road|osm|footprint|parcel|geojson/.test(words) ? "vector" : "raster";
}

/** Every word of the query appears in the collection's id, title, description or keywords. */
function matchesQuery(c, query) {
  const words = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${c.id} ${c.title || ""} ${c.description || ""} ${(c.keywords || []).join(" ")}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

function publicHttps(href) {
  if (href.startsWith("s3://")) {
    const [bucket, ...key] = href.slice(5).split("/");
    return `https://${bucket}.s3.amazonaws.com/${key.join("/")}`;
  }
  return href;
}

/** Every collection of a STAC API, following "next" links (APIs page them, often 10 at a time). */
async function allCollections(getJson, url, max = 1000) {
  const out = [];
  let next = url.includes("?") ? url : `${url}?limit=100`;
  const seen = new Set();
  while (next && !seen.has(next) && out.length < max) {
    seen.add(next);
    const page = await getJson(next);
    out.push(...(page.collections || []));
    next = (page.links || []).find((l) => l.rel === "next")?.href;
  }
  return out;
}

/** Server results live in /outputs; TiTiler reads them from disk by that path. */
function outputPath(url) {
  return `${PATHS.outputs}/${String(url).split("/").pop()}`;
}

function isOutput(url) {
  const u = String(url);
  return !u.includes("/") || u.includes(`${PATHS.outputs}/`);
}

function assetKind(asset) {
  const type = (asset.type || "").toLowerCase().split(";")[0].trim();
  const roles = asset.roles || [];
  if (roles.includes("thumbnail") || roles.includes("overview") || roles.includes("metadata")) return null;
  if (RASTER_TYPES.some((t) => type.startsWith(t)) || /\.tiff?$/i.test(asset.href)) return "raster";
  if (VECTOR_TYPES.includes(type) || /\.(geojson|json|parquet|fgb|gpkg|shp|csv)$/i.test(asset.href)) return "vector";
  return null;
}

/**
 * What the processes accept as a reference, and what TiTiler should read for display.
 * Local catalogue: "collection/item/asset" for processes, the stored href for tiles.
 * External catalogues: public HTTPS for both.
 */
function assetRefs(catalog, collection, itemId, key, asset) {
  if (catalog === "local") return { ref: `${collection}/${itemId}/${key}`, tileHref: asset.href };
  const href = CATALOGS[catalog]?.serverS3 ? asset.href : publicHttps(asset.href);
  return { ref: href, tileHref: href };
}

/** Official class colours for land cover products (value -> [label, hex]). */
const CLASS_PALETTES = {
  "esa-worldcover": {
    10: ["Tree cover", "#006400"], 20: ["Shrubland", "#ffbb22"], 30: ["Grassland", "#ffff4c"],
    40: ["Cropland", "#f096ff"], 50: ["Built-up", "#fa0000"], 60: ["Bare / sparse vegetation", "#b4b4b4"],
    70: ["Snow and ice", "#f0f0f0"], 80: ["Permanent water", "#0064c8"], 90: ["Herbaceous wetland", "#0096a0"],
    95: ["Mangroves", "#00cf75"], 100: ["Moss and lichen", "#fae6a0"],
  },
  "io-lulc-annual": {
    1: ["Water", "#419bdf"], 2: ["Trees", "#397d49"], 4: ["Flooded vegetation", "#7a87c6"], 5: ["Crops", "#e49635"],
    7: ["Built area", "#c4281b"], 8: ["Bare ground", "#a59b8f"], 9: ["Snow / ice", "#a8ebff"], 10: ["Clouds", "#616161"],
    11: ["Rangeland", "#e3e2c3"],
  },
};

function paletteFor(collectionId) {
  const id = (collectionId || "").toLowerCase();
  return Object.entries(CLASS_PALETTES).find(([k]) => id.includes(k))?.[1] || null;
}

/** TiTiler "colormap" parameter (JSON value -> hex) for a class palette. */
function colormapParam(palette) {
  return JSON.stringify(Object.fromEntries(Object.entries(palette).map(([v, [, hex]]) => [v, hex])));
}

/** Legend entries for the classes present (values from a categorical statistics histogram). */
function classEntries(values, palette, colormapDef) {
  return values.map((v) => {
    const key = String(Math.round(v));
    if (palette?.[key]) return { value: v, label: palette[key][0], color: palette[key][1] };
    const c = colormapDef?.[key];
    return { value: v, label: String(v), color: c ? `rgb(${c[0]},${c[1]},${c[2]})` : "#999" };
  });
}

/** CSS linear-gradient for a TiTiler colormap definition ({"0": [r,g,b,a], ... "255": ...}). */
function rampCss(colormapDef, stops = 9) {
  const parts = [];
  for (let i = 0; i < stops; i += 1) {
    const k = String(Math.round((i / (stops - 1)) * 255));
    const c = colormapDef?.[k] || [128, 128, 128];
    parts.push(`rgb(${c[0]},${c[1]},${c[2]}) ${Math.round((i / (stops - 1)) * 100)}%`);
  }
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

/** Feature properties as CSV (one row per feature, union of property names), with a zone number. */
function featuresToCsv(fc) {
  const rows = (fc?.features || []).map((f, i) => ({ zone: i + 1, ...(f.properties || {}) }));
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !c.startsWith("__"));
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

function tileTemplate(href, { rescale, colormap = "viridis", colormapJson, bidx } = {}) {
  const q = new URLSearchParams({ url: href });
  if (rescale) q.set("rescale", `${rescale[0]},${rescale[1]}`);
  if (colormapJson) q.set("colormap", colormapJson);
  else if (colormap) q.set("colormap_name", colormap);
  if (bidx) q.set("bidx", String(bidx));
  return `${PATHS.tiles}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${q.toString()}`;
}

function rescaleFromStats(stats) {
  const b = stats && (stats.b1 || Object.values(stats)[0]);
  if (!b) return null;
  const lo = b.percentile_2 ?? b.min;
  const hi = b.percentile_98 ?? b.max;
  return lo === hi ? [lo, lo + 1] : [lo, hi];
}

function bboxFeature(b) {
  const [w, s, e, n] = b;
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon",
      coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } }],
  };
}

function featureCollection(features) {
  return { type: "FeatureCollection", features: (features || []).filter((f) => f && f.geometry) };
}

/** Form fields for a WhiteboxTools tool. Output parameters are filled in by the server. */
function wbtFields(params) {
  return params.filter((p) => !p.kind.startsWith("out_")).map((p) => ({
    name: p.name,
    label: p.label || p.name,
    help: p.description,
    kind: p.kind,
    options: p.kind === "choice" ? p.data : null,
    optional: p.optional || p.default !== null,
    default: p.default,
  }));
}

/** Turn form values into whitebox args, dropping blanks and converting types. */
function wbtArgs(fields, values) {
  const args = {};
  for (const f of fields) {
    const v = values[f.name];
    if (v === undefined || v === null || v === "") continue;
    if (f.kind === "boolean") { if (v === true) args[f.name] = true; continue; }
    if (f.kind === "number" || f.kind === "integer") {
      const n = Number(v);
      if (Number.isNaN(n)) throw new Error(`${f.label} must be a number`);
      args[f.name] = f.kind === "integer" ? Math.trunc(n) : n;
      continue;
    }
    if (f.kind === "in_raster_or_number" && v !== "" && !Number.isNaN(Number(v))) { args[f.name] = Number(v); continue; }
    args[f.name] = v;
  }
  const missing = fields.filter((f) => !f.optional && !(f.name in args)).map((f) => f.label);
  if (missing.length) throw new Error(`Please fill in: ${missing.join(", ")}`);
  return args;
}

/**
 * Run an OGC API process. Asks for async execution and polls the job; falls back to a
 * synchronous result when the server answers directly.
 */
async function executeProcess(fetchFn, id, inputs, { onStatus = () => {}, pollMs = 1500, signal, async = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (async) headers.Prefer = "respond-async";
  const res = await fetchFn(`${PATHS.processes}/processes/${id}/execution`, {
    method: "POST",
    headers,
    body: JSON.stringify({ inputs }),
    credentials: "same-origin",
    signal,
  });
  if (res.status === 201 || res.status === 202) {
    const jobUrl = res.headers.get("Location");
    if (!jobUrl) throw new Error("server accepted the job but gave no job URL");
    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs));
      const st = await (await fetchFn(`${jobUrl}?f=json`, { credentials: "same-origin", signal })).json();
      onStatus(st.status, st.progress);
      if (st.status === "successful") {
        const out = await fetchFn(`${jobUrl}/results?f=json`, { credentials: "same-origin", signal });
        return unwrap(await out.json());
      }
      if (st.status === "failed" || st.status === "dismissed") throw new Error(st.message || `job ${st.status}`);
    }
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.description || body.detail || `request failed (${res.status})`);
  return unwrap(body);
}

function unwrap(body) {
  // pygeoapi may wrap results as {id: ..., value: ...} or by output name.
  if (body && body.value !== undefined && Object.keys(body).length <= 2) return body.value;
  if (body && body.result !== undefined && Object.keys(body).length === 1) return body.result;
  return body;
}

/** Map layers to add for a process result: [{type: "raster"|"vector", name, href|geojson, stats}]. */
function resultLayers(processId, result, label = processId) {
  const out = [];
  const raster = (name, url, stats) => out.push({ type: "raster", name, href: outputPath(url),
    rescale: stats ? [stats.min, stats.max] : null });
  if (processId === "whitebox") {
    for (const [name, o] of Object.entries(result.outputs || {})) {
      if (o.type === "raster") raster(`${label} ${name}`, o.url, o.stats);
      if (o.type === "vector" && o.geojson) out.push({ type: "vector", name: `${label} ${name}`, geojson: o.geojson });
    }
  } else if (processId === "suitability") {
    raster(`${label} score`, result.suitability_raster, { min: 0, max: 1 });
    if (result.sites?.features?.length) out.push({ type: "vector", name: `${label} best sites`, geojson: result.sites });
  } else if (processId === "accessibility") {
    raster(`${label} distance (m)`, result.distance_raster, result.max_distance_m ? { min: 0, max: result.max_distance_m } : null);
    if (result.facilities?.features?.length) out.push({ type: "vector", name: `${label} facilities`, geojson: result.facilities });
  } else if (processId === "buffer-screen" && result.buffer) {
    out.push({ type: "vector", name: `${label} buffer`, geojson: featureCollection([{ type: "Feature", properties: {}, geometry: result.buffer }]) });
  } else if (processId === "zonal-statistics" && result.features) {
    out.push({ type: "vector", name: `${label} result`, geojson: result });
  }
  return out;
}

/** Short text summary of a result for the Jobs list (layers are added to the map separately). */
function summarise(processId, result) {
  const r = { ...result };
  for (const k of ["sites", "buffer", "features", "facilities", "type", "log"]) delete r[k];
  if (processId === "whitebox") {
    r.outputs = Object.fromEntries(Object.entries(result.outputs || {}).map(([k, v]) =>
      [k, v.type === "text" ? v.content.slice(0, 2000) : v.type === "vector" ? `${v.feature_count} features` : "raster added to map"]));
  }
  if (processId === "zonal-statistics") return `${(result.features || []).length} zones; statistics are in the layer attributes`;
  return JSON.stringify(r, null, 2);
}

// Server Analysis panel for GeoLibre. Browsing and analysis requests go to the course server;
// the browser only draws the results.

const VERSION = "0.1.0";

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c.nodeType ? c : String(c));
  return n;
}

async function getJson(url) {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

function createPanel(app) {
  // Rasters the user can pick as inputs: catalogue items added to the map, and results.
  const rasters = [];
  const jobs = [];
  const state = { catalog: "local" };
  const root = el("div", { class: "sa-root" });
  const body = el("div", { class: "sa-body" });
  const tabs = {};

  function show(name) {
    for (const [k, b] of Object.entries(tabs)) b.classList.toggle("sa-active", k === name);
    body.replaceChildren(views[name]());
  }

  function notify(msg, error = false) {
    const n = el("div", { class: `sa-toast${error ? " sa-error" : ""}` }, msg);
    root.append(n);
    setTimeout(() => n.remove(), error ? 8000 : 3500);
  }

  // ---------- map helpers ----------

  const wantCsv = new Set();

  function downloadCsv(fc, stem) {
    const blob = new Blob([featuresToCsv(fc)], { type: "text/csv" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${stem}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- legends ----------
  // GeoLibre's layer panel shows no legend for tile layers, so the plugin draws one on the map.
  const legends = new Map(); // layer name -> { title, html node }
  let legendBox = null;
  const colormapDefs = {};

  async function colormapDef(name) {
    if (!colormapDefs[name]) colormapDefs[name] = await getJson(`${PATHS.tiles}/colorMaps/${name}`).catch(() => null);
    return colormapDefs[name];
  }

  function legendContainer() {
    if (legendBox?.isConnected) return legendBox;
    legendBox = el("div", { class: "sa-legend maplibregl-ctrl" });
    let added = false;
    try {
      added = app.addMapControl?.({ onAdd: () => legendBox, onRemove: () => legendBox.remove() }, "bottom-left") !== false;
    } catch { added = false; }
    if (!added || !legendBox.isConnected) {
      (document.querySelector(".maplibregl-map") || document.body).append(legendBox);
      legendBox.classList.add("sa-legend-float");
    }
    return legendBox;
  }

  function renderLegends() {
    const names = new Set((app.listLayers?.() || []).map((l) => l.name));
    for (const name of [...legends.keys()]) if (names.size && !names.has(name)) legends.delete(name);
    const box = legendContainer();
    box.replaceChildren(...[...legends.values()].map((l) => l.node));
    box.style.display = legends.size ? "" : "none";
  }
  setInterval(() => { if (legends.size) renderLegends(); }, 2000);

  function setLegend(name, body) {
    const node = el("details", { class: "sa-legend-item", open: true }, el("summary", {}, name), body);
    legends.set(name, { node });
    renderLegends();
  }

  async function addRaster(name, ref, tileHref, rescale, colormap, { palette = null, categorical = false, unit = "" } = {}) {
    const statsUrl = `${PATHS.tiles}/cog/statistics?url=${encodeURIComponent(tileHref)}`;
    if (palette || categorical) {
      // Classes: official palette when known, else the colormap; legend lists the classes in view.
      let values = palette ? Object.keys(palette).map(Number) : [];
      try {
        const bbox = currentView().join(",");
        const st = await getJson(`${statsUrl}&categorical=true&max_size=512&bbox=${bbox}`);
        const hist = Object.values(st)[0]?.histogram;
        if (hist?.[1]?.length) values = hist[1].filter((v, i) => hist[0][i] > 0);
      } catch { /* keep palette values */ }
      const def = palette ? null : await colormapDef(colormap || "tab20");
      app.addTileLayer?.(name, tileTemplate(tileHref, palette ? { colormapJson: colormapParam(palette) } : { colormap: colormap || "tab20" }), { opacity: 0.85 });
      setLegend(name, el("div", {}, classEntries(values.slice(0, 30), palette, def).map((e) =>
        el("div", { class: "sa-legend-row" }, el("span", { class: "sa-swatch", style: `background:${e.color}` }), e.label))));
    } else {
      if (!rescale) {
        try { rescale = rescaleFromStats(await getJson(statsUrl)); } catch { rescale = null; }
      }
      app.addTileLayer?.(name, tileTemplate(tileHref, { rescale, colormap }), { opacity: 0.85 });
      const def = await colormapDef(colormap || "viridis");
      const fmt = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Number(v.toFixed(2))).toLocaleString();
      setLegend(name, el("div", {}, el("div", { class: "sa-ramp", style: `background:${rampCss(def)}` }),
        rescale ? el("div", { class: "sa-ramp-labels" }, el("span", {}, fmt(rescale[0])), el("span", {}, `${fmt(rescale[1])}${unit ? ` ${unit}` : ""}`)) : null));
    }
    if (!rasters.some((r) => r.ref === ref)) rasters.push({ name, ref });
  }

  function vectorLayers() {
    return (app.listLayers?.() || []).filter((l) => !/tile|xyz|raster|cog|wms|wmts|zarr|image|terrain|3d/i.test(l.type || ""));
  }

  function currentView() {
    const b = app.getViewBounds?.();
    if (!b) throw new Error("Map view is not available");
    return b;
  }

  function drawnShapes() {
    const fc = featureCollection(app.getDrawnFeatures?.());
    if (!fc.features.length) throw new Error("Draw a shape first (GeoEditor)");
    return fc;
  }

  // ---------- input widgets ----------

  function rasterPicker(label, { optional = false } = {}) {
    const sel = el("select", {},
      optional ? el("option", { value: "" }, "(none)") : null,
      rasters.map((r) => el("option", { value: r.ref }, r.name)),
      el("option", { value: "__other" }, "Other: catalogue ref or URL"));
    const other = el("input", { type: "text", placeholder: "collection/item/asset or https://...", class: "sa-hidden" });
    sel.addEventListener("change", () => other.classList.toggle("sa-hidden", sel.value !== "__other"));
    if (!rasters.length && !optional) { sel.value = "__other"; other.classList.remove("sa-hidden"); }
    const node = el("label", { class: "sa-field" }, el("span", {}, label), sel, other);
    return { node, value: () => (sel.value === "__other" ? other.value.trim() : sel.value) };
  }

  function vectorPicker(label, { osm = false, drawn = true } = {}) {
    const sel = el("select", {},
      vectorLayers().map((l) => el("option", { value: `layer:${l.id}` }, l.name)),
      drawn ? el("option", { value: "drawn" }, "Drawn shapes") : null,
      osm ? OSM_LAYERS.map((o) => el("option", { value: `osm:${o}` }, `OpenStreetMap: ${o.replace("_", " ")}`)) : null,
      el("option", { value: "__other" }, "Other: catalogue ref or URL"));
    const other = el("input", { type: "text", placeholder: "collection/item/asset or https://...", class: "sa-hidden" });
    sel.addEventListener("change", () => other.classList.toggle("sa-hidden", sel.value !== "__other"));
    const node = el("label", { class: "sa-field" }, el("span", {}, label), sel, other);
    return {
      node,
      value: () => {
        const v = sel.value;
        if (v === "__other") return other.value.trim();
        if (v === "drawn") return drawnShapes();
        if (v.startsWith("osm:")) return { osm: v.slice(4) };
        return featureCollection(app.getLayerFeatures?.(v.slice(6)));
      },
    };
  }

  function aoiPicker(required = false) {
    const sel = el("select", {},
      required ? null : el("option", { value: "" }, "Whole dataset"),
      el("option", { value: "view" }, "Current map view"),
      el("option", { value: "drawn" }, "Drawn shape"));
    if (!required) sel.value = "view";
    const node = el("label", { class: "sa-field" }, el("span", {}, "Area"), sel);
    return {
      node,
      value: () => (sel.value === "view" ? currentView() : sel.value === "drawn" ? drawnShapes() : null),
    };
  }

  function input(label, attrs = {}) {
    const i = el("input", { type: "text", ...attrs });
    return { node: el("label", { class: "sa-field" }, el("span", {}, label), i), value: () => i.value.trim(), el: i };
  }

  function num(label, value, attrs = {}) {
    const f = input(label, { type: "number", value, step: "any", ...attrs });
    return { ...f, value: () => (f.value() === "" ? undefined : Number(f.value())) };
  }

  // ---------- running ----------

  async function run(processId, inputs, label) {
    const job = { id: jobs.length + 1, label, processId, status: "submitted", started: new Date() };
    jobs.unshift(job);
    notify(`${label}: started on the server`);
    try {
      const result = await executeProcess(fetch, processId, inputs, { onStatus: (s) => { job.status = s; } });
      job.status = "done";
      job.result = result;
      for (const layer of resultLayers(processId, result, label)) {
        if (layer.type === "raster") {
          await addRaster(layer.name, layer.href, layer.href, layer.rescale, processId === "suitability" ? "rdylgn" : "viridis",
            { unit: processId === "accessibility" ? "m" : processId === "suitability" ? "(score)" : "" });
        } else {
          app.addGeoJsonLayer?.(layer.name, layer.geojson);
        }
      }
      notify(`${label}: done`);
      if (processId === "zonal-statistics" && wantCsv.has(label)) downloadCsv(result, "zonal-statistics");
    } catch (e) {
      job.status = "failed";
      job.error = e.message;
      notify(`${label}: ${e.message}`, true);
    }
  }

  function runButton(text, collect, processId, label) {
    const b = el("button", { class: "sa-primary", type: "button" }, text);
    b.addEventListener("click", () => {
      let inputs;
      try { inputs = collect(); } catch (e) { notify(e.message, true); return; }
      run(processId, inputs, typeof label === "function" ? label() : label);
      show("jobs");
    });
    return b;
  }

  // ---------- Data tab ----------

  function dataView() {
    const MAX_SHOWN = 150;
    const list = el("div", { class: "sa-list" }, "Loading catalogue...");
    const search = el("input", { type: "search", class: "sa-search", placeholder: "Search data: buildings, land cover, population, schools..." });
    const catSel = el("select", { title: "Catalogue" },
      el("option", { value: "all" }, "All catalogues"),
      Object.entries(CATALOGS).map(([k, c]) => el("option", { value: k }, c.label)));
    catSel.value = state.catalog;
    const kindTabs = {};
    const kindRow = el("div", { class: "sa-kinds", role: "tablist" }, ["all", "raster", "vector"].map((k) => {
      kindTabs[k] = el("button", { type: "button", role: "tab", onclick: () => { state.kind = k; render(); } }, k);
      return kindTabs[k];
    }));
    state.kind = state.kind || "all";
    const loaded = {}; // catalogue key -> collections (each tagged with _cat)
    const base = (cat) => CATALOGS[cat].url || PATHS.stac;
    const catalogsShown = () => (catSel.value === "all" ? Object.keys(CATALOGS) : [catSel.value]);

    function render() {
      const pool = catalogsShown().flatMap((k) => loaded[k] || []);
      const byQuery = pool.filter((c) => matchesQuery(c, search.value));
      const counts = { all: byQuery.length, raster: 0, vector: 0 };
      byQuery.forEach((c) => { counts[collectionKind(c)] += 1; });
      for (const [k, b] of Object.entries(kindTabs)) {
        b.textContent = `${k === "all" ? "All" : k[0].toUpperCase() + k.slice(1)} (${counts[k]})`;
        b.classList.toggle("sa-active", state.kind === k);
        b.setAttribute("aria-selected", String(state.kind === k));
      }
      const shown = byQuery.filter((c) => state.kind === "all" || collectionKind(c) === state.kind);
      const pending = catalogsShown().filter((k) => !loaded[k]);
      if (!shown.length) {
        list.replaceChildren(pending.length ? "Loading catalogue..." : "No data matches. Try other words or another catalogue.");
        return;
      }
      const footer = [
        shown.length > MAX_SHOWN ? el("p", { class: "sa-muted" }, `${shown.length - MAX_SHOWN} more: refine the search.`) : null,
        pending.length ? el("p", { class: "sa-muted" }, `Still loading: ${pending.map((k) => CATALOGS[k].label).join(", ")}`) : null,
      ].filter(Boolean);
      list.replaceChildren(...shown.slice(0, MAX_SHOWN).map((c) => {
        const kind = collectionKind(c);
        const action = c["geotraining:partitioned"]
          ? el("button", { type: "button", onclick: (ev) => addArea(c, ev.target.parentElement) }, "Add for current view")
          : el("button", { type: "button", onclick: (ev) => loadItems(c, ev.target.parentElement) }, "Show items in current view");
        return el("details", { class: "sa-coll" },
          el("summary", {}, el("span", { class: `sa-badge sa-${kind}` }, kind === "raster" ? "Raster" : "Vector"),
            catSel.value === "all" ? el("span", { class: "sa-badge sa-src" }, CATALOGS[c._cat].short || CATALOGS[c._cat].label) : null,
            " ", el("b", {}, c.title || c.id), el("small", {}, ` ${c.id}`)),
          el("p", {}, (c.description || "").slice(0, 300)),
          action);
      }), ...footer);
    }

    async function loadCatalogue(k) {
      if (loaded[k]) return;
      try {
        loaded[k] = (await allCollections(getJson, `${base(k)}/collections`)).map((c) => ({ ...c, _cat: k }));
      } catch (e) {
        loaded[k] = [];
        notify(`Could not load ${CATALOGS[k].label}: ${e.message}`, true);
      }
      render();
    }

    async function loadItems(c, container) {
      const box = el("div", { class: "sa-items" }, "Searching...");
      container.querySelector(".sa-items")?.remove();
      container.append(box);
      try {
        const bbox = currentView().join(",");
        const res = await getJson(`${base(c._cat)}/search?collections=${encodeURIComponent(c.id)}&bbox=${bbox}&limit=20`);
        const items = res.features || [];
        if (!items.length) { box.replaceChildren("No items in this view. Pan or zoom out."); return; }
        box.replaceChildren(...items.map((it) => el("div", { class: "sa-item" },
          el("div", {}, el("b", {}, it.properties?.title || it.id), it.properties?.datetime ? el("small", {}, ` ${it.properties.datetime.slice(0, 10)}`) : null),
          Object.entries(it.assets || {}).filter(([, a]) => assetKind(a)).map(([k, a]) =>
            el("button", { type: "button", onclick: () => addAsset(c, it, k, a) }, `Add ${a.title || k}`)))));
      } catch (e) { box.replaceChildren(e.message); }
    }

    async function addVector(name, source) {
      const fc = await executeProcess(fetch, "features", { source, aoi: currentView() }, { async: false });
      app.addGeoJsonLayer?.(name, fc);
      const msg = `Added ${name}: ${fc.features?.length ?? 0} features`;
      notify(msg);
      return msg;
    }

    async function addArea(c, container) {
      // Status stays under the collection: these reads take a few seconds and can fail on large views.
      container.querySelector(".sa-status")?.remove();
      const status = el("p", { class: "sa-status sa-muted" }, "Loading for the current view...");
      container.append(status);
      try {
        status.textContent = await addVector(c.title || c.id, `${c.id}/*`);
      } catch (e) {
        status.className = "sa-status sa-error-text";
        status.textContent = e.message;
        notify(e.message, true);
      }
    }

    async function addAsset(c, item, key, asset) {
      const { ref, tileHref } = assetRefs(c._cat, c.id, item.id, key, asset);
      const name = `${c.title || c.id} ${item.properties?.title ? "" : item.id}${key === "data" ? "" : ` ${key}`}`.trim();
      try {
        if (assetKind(asset) === "raster") {
          const categorical = /class|cover|lulc|landuse|land-use|map$/i.test(`${c.id} ${key}`) && !/fraction|density|tree-cover/i.test(`${c.id} ${key}`);
          await addRaster(name, ref, tileHref, null, categorical ? "tab20" : "viridis",
            { palette: paletteFor(c.id), categorical, unit: /dem|elevation/i.test(c.id) ? "m" : "" });
          if (c._cat === "local" && !c.id.startsWith("hrsl")) {
            // Analyses often span several tiles: offer the whole collection, mosaicked over the area.
            const mosaic = `${c.id}/*${key === "data" ? "" : `/${key}`}`;
            if (!rasters.some((r) => r.ref === mosaic)) rasters.push({ name: `${c.title || c.id}: all tiles over the area`, ref: mosaic });
          }
          notify(`Added ${name}`);
        } else {
          await addVector(name, ref);
        }
      } catch (e) { notify(e.message, true); }
    }

    search.addEventListener("input", render);
    catSel.addEventListener("change", () => {
      state.catalog = catSel.value === "all" ? state.catalog : catSel.value;
      render();
      catalogsShown().forEach(loadCatalogue);
    });
    catalogsShown().forEach(loadCatalogue);
    return el("div", {}, search, el("div", { class: "sa-row" }, kindRow, catSel), list);
  }

  // ---------- Tools tab ----------

  function toolsView() {
    const form = el("div", { class: "sa-form" });
    const search = el("input", { type: "search", placeholder: "Search 500+ tools: slope, clip, watershed, NDVI, buffer..." });
    const results = el("div", { class: "sa-list sa-tools" });

    function renderServerTools() {
      results.replaceChildren(el("h4", {}, "Analysis tools"),
        ...Object.entries(SERVER_TOOLS).map(([id, title]) =>
          el("button", { type: "button", class: "sa-tool", onclick: () => openServerTool(id) }, title)),
        el("h4", {}, "WhiteboxTools on the server"),
        el("p", { class: "sa-muted" }, "Type above to search the full toolbox (terrain, hydrology, image analysis, GIS overlay, classification)."));
    }

    let timer;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      const q = search.value.trim();
      if (!q) { renderServerTools(); return; }
      timer = setTimeout(async () => {
        try {
          const r = await executeProcess(fetch, "whitebox-tools", { search: q }, { async: false });
          results.replaceChildren(...r.tools.slice(0, 60).map((t) =>
            el("button", { type: "button", class: "sa-tool", onclick: () => openWhitebox(t.tool) },
              el("b", {}, t.tool), el("small", {}, ` ${t.description.slice(0, 140)}`))));
          if (!r.tools.length) results.replaceChildren("No tools match.");
        } catch (e) { results.replaceChildren(e.message); }
      }, 300);
    });

    async function openWhitebox(tool) {
      form.replaceChildren("Loading parameters...");
      try {
        const info = await executeProcess(fetch, "whitebox-tools", { tool }, { async: false });
        const fields = wbtFields(info.parameters);
        const widgets = {};
        const nodes = fields.map((f) => {
          let w;
          const label = `${f.label}${f.optional ? "" : " *"}`;
          if (f.kind === "in_raster" || f.kind === "in_raster_or_number") w = rasterPicker(label, { optional: f.optional });
          else if (f.kind === "in_vector") w = vectorPicker(label);
          else if (f.kind === "in_raster_list") {
            const i = input(`${label} (comma separated refs)`);
            w = { node: i.node, value: () => i.value().split(",").map((s) => s.trim()).filter(Boolean) };
          } else if (f.kind === "boolean") {
            const c = el("input", { type: "checkbox" });
            if (String(f.default).toLowerCase() === "true") c.checked = true;
            w = { node: el("label", { class: "sa-check" }, c, f.label), value: () => c.checked };
          } else if (f.kind === "choice") {
            const s = el("select", {}, el("option", { value: "" }, `(default${f.default ? `: ${f.default}` : ""})`),
              f.options.map((o) => el("option", { value: o }, o)));
            w = { node: el("label", { class: "sa-field" }, el("span", {}, label), s), value: () => s.value };
          } else if (f.kind === "in_file" || f.kind === "in_file_list") {
            w = { node: el("p", { class: "sa-muted" }, `${f.label}: file inputs of this type are not supported in the web form yet.`), value: () => "" };
          } else {
            w = input(label, { placeholder: f.default ?? "" });
          }
          w.node.title = f.help || "";
          widgets[f.name] = w;
          return w.node;
        });
        const aoi = aoiPicker();
        form.replaceChildren(
          el("h3", {}, tool), el("p", { class: "sa-muted" }, info.description),
          ...nodes, aoi.node,
          el("p", { class: "sa-muted" }, "Inputs are clipped to the area before the tool runs, which keeps jobs fast."),
          runButton("Run on server", () => {
            const values = Object.fromEntries(Object.entries(widgets).map(([k, w]) => [k, w.value()]));
            const inputs = { tool, args: wbtArgs(fields, values) };
            const a = aoi.value();
            if (a) inputs.aoi = a;
            return inputs;
          }, "whitebox", tool));
      } catch (e) { form.replaceChildren(e.message); }
    }

    function openServerTool(id) {
      const builders = { "zonal-statistics": zonalForm, suitability: suitabilityForm, accessibility: accessibilityForm, "buffer-screen": bufferForm };
      form.replaceChildren(el("h3", {}, SERVER_TOOLS[id]), ...builders[id]());
    }

    function zonalForm() {
      const r = rasterPicker("Raster *");
      const z = vectorPicker("Zones (polygons) *");
      const csv = el("input", { type: "checkbox", checked: true });
      const stats = ["mean", "min", "max", "sum", "count", "median", "stdev", "majority"].map((s) => {
        const c = el("input", { type: "checkbox", value: s });
        if (["mean", "min", "max", "count"].includes(s)) c.checked = true;
        return { c, node: el("label", { class: "sa-check" }, c, s) };
      });
      return [r.node, z.node, el("div", { class: "sa-checks" }, stats.map((s) => s.node)),
        el("label", { class: "sa-check" }, csv, "Also download the table as CSV"),
        runButton("Run on server", () => {
          if (!r.value()) throw new Error("Choose a raster");
          wantCsv.add("Zonal statistics");
          if (!csv.checked) wantCsv.delete("Zonal statistics");
          return { raster: r.value(), zones: z.value(), stats: stats.filter((s) => s.c.checked).map((s) => s.c.value) };
        }, "zonal-statistics", "Zonal statistics")];
    }

    function bufferForm() {
      const f = vectorPicker("Road, line or site *");
      const d = num("Buffer distance (m)", 1000);
      const rows = el("div", {});
      const layers = [];
      const addRow = () => {
        const r = rasterPicker(`Layer ${layers.length + 1}`);
        const cat = el("input", { type: "checkbox" });
        layers.push({ r, cat });
        rows.append(el("div", { class: "sa-card" }, r.node, el("label", { class: "sa-check" }, cat, "Categorical (report class shares)")));
      };
      addRow();
      return [f.node, d.node, rows, el("button", { type: "button", onclick: addRow }, "+ Add layer"),
        runButton("Run on server", () => ({
          features: f.value(), distance_m: d.value(),
          layers: layers.filter((l) => l.r.value()).map((l) => ({ name: l.r.value(), raster: l.r.value(), categorical: l.cat.checked })),
        }), "buffer-screen", "Buffer screening")];
    }

    function accessibilityForm() {
      const aoi = aoiPicker(true);
      const fac = vectorPicker("Facilities *", { osm: true });
      const pop = rasterPicker("Population raster (optional)", { optional: true });
      const lim = num("Distance limit (m)", 5000);
      const res = num("Cell size (m)", 100);
      return [aoi.node, fac.node, pop.node, lim.node, res.node,
        runButton("Run on server", () => {
          const inputs = { aoi: aoi.value(), facilities: fac.value(), limit_m: lim.value(), resolution: res.value() };
          if (pop.value()) inputs.population = { raster: pop.value(), counts: true };
          return inputs;
        }, "accessibility", "Accessibility")];
    }

    function suitabilityForm() {
      const aoi = aoiPicker(true);
      const res = num("Cell size (m)", 100);
      const crit = el("div", {});
      const cons = el("div", {});
      const criteria = [];
      const constraints = [];

      function addCriterion() {
        const kind = el("select", {}, el("option", { value: "raster" }, "Raster value"),
          el("option", { value: "slope" }, "Slope from a DEM"), el("option", { value: "distance" }, "Distance to features"));
        const r = rasterPicker("Raster");
        const v = vectorPicker("Features", { osm: true });
        const name = input("Name", { value: `Criterion ${criteria.length + 1}` });
        const lo = num("Value scoring 0 or 1 at", 0);
        const hi = num("and the other end at", 100);
        const dir = el("select", {}, el("option", { value: "higher" }, "Higher is better"), el("option", { value: "lower" }, "Lower is better"));
        const w = num("Weight", 1, { min: 0 });
        const sync = () => { const d = kind.value === "distance"; r.node.classList.toggle("sa-hidden", d); v.node.classList.toggle("sa-hidden", !d); };
        kind.addEventListener("change", sync); sync();
        const card = el("div", { class: "sa-card" }, name.node, el("label", { class: "sa-field" }, el("span", {}, "Type"), kind),
          r.node, v.node, el("div", { class: "sa-row" }, lo.node, hi.node), el("label", { class: "sa-field" }, el("span", {}, "Direction"), dir), w.node,
          el("button", { type: "button", onclick: () => { card.remove(); criteria.splice(criteria.indexOf(c), 1); } }, "Remove"));
        const c = {
          value: () => {
            let source;
            if (kind.value === "distance") {
              const x = v.value();
              source = x.osm ? { osm: x.osm } : { vector: typeof x === "string" ? x : JSON.stringify(x), derive: "distance" };
            } else {
              if (!r.value()) throw new Error(`${name.value()}: choose a raster`);
              source = { raster: r.value(), ...(kind.value === "slope" ? { derive: "slope" } : {}) };
            }
            return { name: name.value(), source, weight: w.value(),
              rule: { type: "linear", min: lo.value(), max: hi.value(), direction: dir.value } };
          },
        };
        criteria.push(c);
        crit.append(card);
      }

      function addConstraint() {
        const kind = el("select", {}, el("option", { value: "classes" }, "Exclude raster classes"),
          el("option", { value: "op" }, "Exclude where value is above / below"), el("option", { value: "inside" }, "Exclude inside polygons"));
        const r = rasterPicker("Raster");
        const v = vectorPicker("Polygons");
        const classes = input("Class codes, comma separated", { placeholder: "50, 80" });
        const op = el("select", {}, [">", ">=", "<", "<="].map((o) => el("option", { value: o }, o)));
        const val = num("Value", 15);
        const sync = () => {
          r.node.classList.toggle("sa-hidden", kind.value === "inside"); v.node.classList.toggle("sa-hidden", kind.value !== "inside");
          classes.node.classList.toggle("sa-hidden", kind.value !== "classes");
          op.parentElement?.classList.toggle("sa-hidden", kind.value !== "op"); val.node.classList.toggle("sa-hidden", kind.value !== "op");
        };
        const opField = el("label", { class: "sa-field" }, el("span", {}, "Rule"), op);
        const card = el("div", { class: "sa-card" }, el("label", { class: "sa-field" }, el("span", {}, "Type"), kind), r.node, v.node, classes.node, opField, val.node,
          el("button", { type: "button", onclick: () => { card.remove(); constraints.splice(constraints.indexOf(c), 1); } }, "Remove"));
        kind.addEventListener("change", sync); sync();
        const c = {
          value: () => {
            if (kind.value === "inside") { const x = v.value(); return { vector: typeof x === "string" ? x : JSON.stringify(x) }; }
            if (kind.value === "classes") return { source: { raster: r.value(), categorical: true }, classes: classes.value().split(",").map(Number).filter((n) => !Number.isNaN(n)) };
            return { source: { raster: r.value() }, op: op.value, value: val.value() };
          },
        };
        constraints.push(c);
        cons.append(card);
      }

      addCriterion();
      const th = num("Best sites: minimum score (0 to 1)", 0.7, { min: 0, max: 1 });
      const area = num("Minimum site area (ha)", 0);
      const top = num("Number of sites", 10);
      return [aoi.node, res.node, el("h4", {}, "Criteria"), crit, el("button", { type: "button", onclick: addCriterion }, "+ Add criterion"),
        el("h4", {}, "Exclusions"), cons, el("button", { type: "button", onclick: addConstraint }, "+ Add exclusion"),
        th.node, area.node, top.node,
        runButton("Run on server", () => ({
          aoi: aoi.value(), resolution: res.value(), criteria: criteria.map((c) => c.value()),
          constraints: constraints.map((c) => c.value()), threshold: th.value(), min_area_ha: area.value(), top_n: top.value(),
        }), "suitability", "Suitability")];
    }

    renderServerTools();
    return el("div", {}, search, results, form);
  }

  // ---------- Jobs tab ----------

  function jobsView() {
    const list = el("div", { class: "sa-list" });
    const render = () => list.replaceChildren(...(jobs.length ? jobs.map((j) => el("details", { class: `sa-job sa-${j.status}`, open: j.id === jobs[0].id },
      el("summary", {}, `${j.label}: ${j.status}`),
      j.error ? el("pre", {}, j.error) : null,
      j.result ? el("pre", {}, summarise(j.processId, j.result)) : null,
      j.processId === "zonal-statistics" && j.result?.features
        ? el("button", { type: "button", onclick: () => downloadCsv(j.result, "zonal-statistics") }, "Download CSV") : null)) : ["No jobs yet. Run a tool from the Tools tab."]));
    // Re-render whenever any job's status changes; stop when the tab is closed.
    const signature = () => jobs.map((j) => `${j.id}:${j.status}`).join(",");
    let last = signature();
    render();
    const t = setInterval(() => {
      if (!list.isConnected) { clearInterval(t); return; }
      const now = signature();
      if (now !== last) { last = now; render(); }
    }, 500);
    return list;
  }

  // ---------- Workspace tab: GeoLibre's own tools on the server ----------

  function workspaceView() {
    const list = el("div", { class: "sa-list" }, "Loading...");
    const copy = (text) => navigator.clipboard?.writeText(text).then(() => notify(`Copied ${text}`), () => notify(text));

    async function refresh() {
      try {
        const r = await executeProcess(fetch, "workspace", { action: "list" }, { async: false });
        list.replaceChildren(...(r.files.length ? r.files.map((f) => el("div", { class: "sa-item" },
          el("div", {}, el("span", { class: `sa-badge sa-${f.kind === "raster" ? "raster" : "vector"}` }, f.kind === "raster" ? "Raster" : "File"),
            " ", el("b", {}, f.name), el("small", {}, ` ${f.size_mb} MB, ${f.modified} UTC`)),
          el("code", { class: "sa-path" }, f.geolibre_path),
          el("div", { class: "sa-row" },
            el("button", { type: "button", onclick: () => copy(f.geolibre_path) }, "Copy path"),
            f.kind === "raster" ? el("button", { type: "button", onclick: () => addRaster(f.name, f.path, f.path, null, "viridis").then(() => notify(`Added ${f.name}`), (e) => notify(e.message, true)) }, "Add to map") : null,
            el("a", { href: f.url, download: f.name, class: "sa-button" }, "Download"))))
          : ["The workspace is empty. Copy a raster in above, or run a GeoLibre tool with an output path under /data."]));
      } catch (e) { list.replaceChildren(e.message); }
    }

    const r = rasterPicker("Raster to copy *");
    const name = input("File name", { placeholder: "e.g. dem-fujairah" });
    const aoi = aoiPicker(true);
    const result = el("div", {});
    const prep = el("button", { class: "sa-primary", type: "button" }, "Copy into workspace");
    prep.addEventListener("click", async () => {
      result.replaceChildren("Copying (clipped to the area)...");
      try {
        if (!r.value()) throw new Error("Choose a raster (add one from the Data tab first)");
        const out = await executeProcess(fetch, "workspace", { action: "prepare", raster: r.value(), aoi: aoi.value(), name: name.value() }, { async: false });
        result.replaceChildren(el("p", {}, "Ready for GeoLibre's tools. Input path: "), el("code", { class: "sa-path" }, out.geolibre_path),
          el("button", { type: "button", onclick: () => copy(out.geolibre_path) }, "Copy path"));
        refresh();
      } catch (e) { result.replaceChildren(el("p", { class: "sa-error-text" }, e.message)); }
    });

    refresh();
    return el("div", {},
      el("details", { class: "sa-help", open: true }, el("summary", {}, "Run GeoLibre's own tools on the server"),
        el("ol", {},
          el("li", {}, "Copy a raster into the workspace below (clipped to the view or a drawn shape)."),
          el("li", {}, "Open Processing > Whitebox Toolbox (or GeoLibre Toolbox) and untick \"Run locally (WASM)\"."),
          el("li", {}, "Set the input to Path and paste the path (/data/...). Set the output to a new path such as /data/slope.tif."),
          el("li", {}, "Run. Then press Refresh here and Add the result to the map, or download it."))),
      el("h4", {}, "Copy a raster into the workspace"), r.node, name.node, aoi.node, prep, result,
      el("div", { class: "sa-row" }, el("h4", {}, "Workspace files"), el("button", { type: "button", onclick: refresh }, "Refresh")),
      list);
  }

  const views = { data: dataView, tools: toolsView, workspace: workspaceView, jobs: jobsView };
  const nav = el("div", { class: "sa-tabs" }, Object.keys(views).map((k) => {
    tabs[k] = el("button", { type: "button", onclick: () => show(k) }, k[0].toUpperCase() + k.slice(1));
    return tabs[k];
  }));
  root.append(nav, body);
  show("data");
  return root;
}

const plugin = {
  id: "server-analysis",
  name: "Server Analysis",
  version: VERSION,
  engines: ["maplibre"],
  activate(app) {
    app.registerRightPanel?.({
      id: "server-analysis",
      title: "Server Analysis",
      dock: "right-of-style",
      render: (container) => container.replaceChildren(createPanel(app)),
    });
    app.registerToolbarMenu?.({
      id: "server-analysis-menu",
      label: "Server Analysis",
      items: [{ id: "open", label: "Open data and analysis panel", onSelect: () => app.openRightPanel?.("server-analysis") }],
    });
  },
  deactivate(app) {
    app?.unregisterRightPanel?.("server-analysis");
    app?.unregisterToolbarMenu?.("server-analysis-menu");
  },
};

export default plugin;
export { plugin };
