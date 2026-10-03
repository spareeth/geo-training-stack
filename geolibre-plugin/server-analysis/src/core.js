// Pure helpers for the Server Analysis plugin. No DOM, so they run under `node --test`.
// build.mjs inlines this file into index.js because GeoLibre plugins must be one file.

export const PATHS = { processes: "/processes-api", stac: "/stac", tiles: "/tiles", outputs: "/outputs" };

export const CATALOGS = {
  local: { label: "Course catalogue", url: null },
  "earth-search": { label: "Earth Search (AWS open data)", url: "https://earth-search.aws.element84.com/v1" },
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
  "application/x-parquet", "application/flatgeobuf", "application/vnd.flatgeobuf"];

export function publicHttps(href) {
  if (href.startsWith("s3://")) {
    const [bucket, ...key] = href.slice(5).split("/");
    return `https://${bucket}.s3.amazonaws.com/${key.join("/")}`;
  }
  return href;
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
  if (VECTOR_TYPES.includes(type) || /\.(geojson|json|parquet|fgb|gpkg|shp)$/i.test(asset.href)) return "vector";
  return null;
}

/**
 * What the processes accept as a reference, and what TiTiler should read for display.
 * Local catalogue: "collection/item/asset" for processes, the stored href for tiles.
 * External catalogues: public HTTPS for both.
 */
export function assetRefs(catalog, collection, itemId, key, asset) {
  if (catalog === "local") return { ref: `${collection}/${itemId}/${key}`, tileHref: asset.href };
  const https = publicHttps(asset.href);
  return { ref: https, tileHref: https };
}

export function tileTemplate(href, { rescale, colormap = "viridis", bidx } = {}) {
  const q = new URLSearchParams({ url: href });
  if (rescale) q.set("rescale", `${rescale[0]},${rescale[1]}`);
  if (colormap) q.set("colormap_name", colormap);
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
  for (const k of ["sites", "buffer", "features", "type", "log"]) delete r[k];
  if (processId === "whitebox") {
    r.outputs = Object.fromEntries(Object.entries(result.outputs || {}).map(([k, v]) =>
      [k, v.type === "text" ? v.content.slice(0, 2000) : v.type === "vector" ? `${v.feature_count} features` : "raster added to map"]));
  }
  if (processId === "zonal-statistics") return `${(result.features || []).length} zones; statistics are in the layer attributes`;
  return JSON.stringify(r, null, 2);
}
