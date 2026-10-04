// Pure helpers for the Server Analysis plugin. No DOM, so they run under `node --test`.
// build.mjs inlines this file into index.js because GeoLibre plugins must be one file.

export const PATHS = { processes: "/processes-api", stac: "/stac", tiles: "/tiles", outputs: "/outputs" };

export const CATALOGS = {
  local: { label: "Course catalogue", short: "Course", url: null },
  "earth-search": { label: "Earth Search (AWS open data)", short: "Earth Search", url: "https://earth-search.aws.element84.com/v1" },
  // CDSE files are s3://eodata hrefs that the server reads with its own CDSE keys, so they stay s3://.
  cdse: { label: "Copernicus Data Space (CDSE)", short: "CDSE", url: "https://stac.dataspace.copernicus.eu/v1", serverS3: true },
};

// Tools with hand-made forms. Every WhiteboxTools tool gets a generated form.
export const SERVER_TOOLS = {
  "zonal-statistics": "Zonal statistics: summarise a raster inside each polygon",
  "suitability": "Suitability: weighted overlay of criteria, best sites",
  "accessibility": "Accessibility: distance to facilities, population served",
  "buffer-screen": "Buffer screening: what lies within a distance of a road or site",
};

export const OSM_LAYERS = ["roads", "major_roads", "schools", "health", "hospitals", "water_points",
  "rivers", "markets", "settlements", "power_lines"];

export const RASTER_TYPES = ["image/tiff", "application/x-geotiff", "image/vnd.stac.geotiff"];
export const VECTOR_TYPES = ["application/geo+json", "application/json", "application/vnd.apache.parquet",
  "application/x-parquet", "application/flatgeobuf", "application/vnd.flatgeobuf",
  "application/geopackage+sqlite3", "text/csv"];

/** "raster" or "vector": the course catalogue says so; otherwise guess from asset types and keywords. */
export function collectionKind(c) {
  const k = c["geotraining:kind"];
  if (k === "raster" || k === "vector") return k;
  const types = Object.values(c.item_assets || {}).map((a) => (a.type || "").toLowerCase().split(";")[0].trim());
  if (types.some((t) => VECTOR_TYPES.includes(t))) return "vector";
  if (types.some((t) => RASTER_TYPES.some((r) => t.startsWith(r)))) return "raster";
  const words = `${c.id} ${(c.keywords || []).join(" ")}`.toLowerCase();
  return /vector|geoparquet|boundar|building|road|osm|footprint|parcel|geojson/.test(words) ? "vector" : "raster";
}

/** Every word of the query appears in the collection's id, title, description or keywords. */
export function matchesQuery(c, query) {
  const words = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${c.id} ${c.title || ""} ${c.description || ""} ${(c.keywords || []).join(" ")}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

export function publicHttps(href) {
  if (href.startsWith("s3://")) {
    const [bucket, ...key] = href.slice(5).split("/");
    return `https://${bucket}.s3.amazonaws.com/${key.join("/")}`;
  }
  return href;
}

/** Every collection of a STAC API, following "next" links (APIs page them, often 10 at a time). */
export async function allCollections(getJson, url, max = 1000) {
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
export function outputPath(url) {
  return `${PATHS.outputs}/${String(url).split("/").pop()}`;
}

export function isOutput(url) {
  const u = String(url);
  return !u.includes("/") || u.includes(`${PATHS.outputs}/`);
}

export function assetKind(asset) {
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
export function assetRefs(catalog, collection, itemId, key, asset) {
  if (catalog === "local") return { ref: `${collection}/${itemId}/${key}`, tileHref: asset.href };
  const href = CATALOGS[catalog]?.serverS3 ? asset.href : publicHttps(asset.href);
  return { ref: href, tileHref: href };
}

/** Official class colours for land cover products (value -> [label, hex]). */
export const CLASS_PALETTES = {
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

export function paletteFor(collectionId) {
  const id = (collectionId || "").toLowerCase();
  return Object.entries(CLASS_PALETTES).find(([k]) => id.includes(k))?.[1] || null;
}

/** TiTiler "colormap" parameter (JSON value -> hex) for a class palette. */
export function colormapParam(palette) {
  return JSON.stringify(Object.fromEntries(Object.entries(palette).map(([v, [, hex]]) => [v, hex])));
}

/** Legend entries for the classes present (values from a categorical statistics histogram). */
export function classEntries(values, palette, colormapDef) {
  return values.map((v) => {
    const key = String(Math.round(v));
    if (palette?.[key]) return { value: v, label: palette[key][0], color: palette[key][1] };
    const c = colormapDef?.[key];
    return { value: v, label: String(v), color: c ? `rgb(${c[0]},${c[1]},${c[2]})` : "#999" };
  });
}

/** CSS linear-gradient for a TiTiler colormap definition ({"0": [r,g,b,a], ... "255": ...}). */
export function rampCss(colormapDef, stops = 9) {
  const parts = [];
  for (let i = 0; i < stops; i += 1) {
    const k = String(Math.round((i / (stops - 1)) * 255));
    const c = colormapDef?.[k] || [128, 128, 128];
    parts.push(`rgb(${c[0]},${c[1]},${c[2]}) ${Math.round((i / (stops - 1)) * 100)}%`);
  }
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

/** Feature properties as CSV (one row per feature, union of property names), with a zone number. */
export function featuresToCsv(fc) {
  const rows = (fc?.features || []).map((f, i) => ({ zone: i + 1, ...(f.properties || {}) }));
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !c.startsWith("__"));
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

export function tileTemplate(href, { rescale, colormap = "viridis", colormapJson, bidx } = {}) {
  const q = new URLSearchParams({ url: href });
  if (rescale) q.set("rescale", `${rescale[0]},${rescale[1]}`);
  if (colormapJson) q.set("colormap", colormapJson);
  else if (colormap) q.set("colormap_name", colormap);
  if (bidx) q.set("bidx", String(bidx));
  return `${PATHS.tiles}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${q.toString()}`;
}

export function rescaleFromStats(stats) {
  const b = stats && (stats.b1 || Object.values(stats)[0]);
  if (!b) return null;
  const lo = b.percentile_2 ?? b.min;
  const hi = b.percentile_98 ?? b.max;
  return lo === hi ? [lo, lo + 1] : [lo, hi];
}

export function bboxFeature(b) {
  const [w, s, e, n] = b;
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon",
      coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } }],
  };
}

export function featureCollection(features) {
  return { type: "FeatureCollection", features: (features || []).filter((f) => f && f.geometry) };
}

/** Form fields for a WhiteboxTools tool. Output parameters are filled in by the server. */
export function wbtFields(params) {
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
export function wbtArgs(fields, values) {
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
export async function executeProcess(fetchFn, id, inputs, { onStatus = () => {}, pollMs = 1500, signal, async = true } = {}) {
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
export function resultLayers(processId, result, label = processId) {
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
export function summarise(processId, result) {
  const r = { ...result };
  for (const k of ["sites", "buffer", "features", "facilities", "type", "log"]) delete r[k];
  if (processId === "whitebox") {
    r.outputs = Object.fromEntries(Object.entries(result.outputs || {}).map(([k, v]) =>
      [k, v.type === "text" ? v.content.slice(0, 2000) : v.type === "vector" ? `${v.feature_count} features` : "raster added to map"]));
  }
  if (processId === "zonal-statistics") return `${(result.features || []).length} zones; statistics are in the layer attributes`;
  return JSON.stringify(r, null, 2);
}
