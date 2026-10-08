// Remote Processing plugin for GeoLibre. Built from src/ by build.mjs, do not edit.
// Logic of the Remote Processing plugin that does not touch the page (tested with node --test).

const VERSION = "0.1.0";
const STORAGE_KEY = "geolibre-remote-processing";

/** "sidecar.example.org" or "https://sidecar.example.org/" -> "https://sidecar.example.org" */
function normalizeServer(value) {
  let s = (value || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}

/**
 * GeoLibre's web build sends processing requests to `${location.origin}/sidecar/...`.
 * Returns the same request on the shared server, or null for any other URL.
 */
function rewriteSidecarUrl(url, origin, server) {
  if (!server || typeof url !== "string") return null;
  const local = `${origin}/sidecar`;
  if (url === local || url.startsWith(`${local}/`) || url.startsWith(`${local}?`)) return server + "/sidecar" + url.slice(local.length);
  if (url === "/sidecar" || url.startsWith("/sidecar/")) return server + url;
  return null;
}

/** URL with the access code as ?code= (for map layers and downloads, which cannot send headers). */
function withCode(url, code) {
  if (!code) return url;
  return `${url}${url.includes("?") ? "&" : "?"}code=${encodeURIComponent(code)}`;
}

/**
 * fetch() that sends GeoLibre's sidecar requests to the shared server with the access code, and
 * leaves every other request untouched. getConfig() is read on each call so settings apply at once.
 */
function makeFetch(originalFetch, getConfig, origin) {
  return function remoteSidecarFetch(input, init) {
    const { server, code, metres = true } = getConfig() || {};
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    const target = rewriteSidecarUrl(url, origin, server);
    if (!target) return originalFetch(input, init);
    const headers = new Headers(init?.headers || (typeof input === "object" && input?.headers) || undefined);
    if (code) headers.set("X-Access-Code", code);
    // Measure in metres: the server reprojects lat/lon inputs of Whitebox jobs to UTM.
    if (metres && /\/sidecar\/whitebox\/run(\?|$)/.test(target)) headers.set("X-Auto-Project", "utm");
    if (typeof input === "object" && !(input instanceof URL) && input) {
      return originalFetch(new Request(target, input), { ...init, headers });
    }
    return originalFetch(target, { ...init, headers });
  };
}

/** Random participant folder id, e.g. "u-7f3k9q2m1x" (letters and digits only). */
function newParticipantId(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `u-${[...random(10)].map((b) => abc[b % abc.length]).join("")}`;
}

function isParticipantId(value) {
  return /^u-[a-z0-9]{6,32}$/.test(value || "");
}

function fileKind(name) {
  const n = (name || "").toLowerCase();
  if (/\.tiff?$/.test(n)) return "raster";
  if (/\.(geojson|json)$/.test(n)) return "vector";
  return "file";
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

/** "Roads 2024 (final).geojson" -> "roads-2024-final" (safe server file stem). */
function safeStem(name) {
  return (name || "").replace(/\.[A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60) || "layer";
}

/**
 * Run one of GeoLibre's own raster tools on the sidecar (POST /sidecar/raster/run) and wait for it.
 * GeoLibre's web build locks its Raster tools dialog to the desktop app, but the sidecar runs them.
 */
async function runRasterTool(fetchJson, { toolId, input, output, parameters = {} }, { pollMs = 1000, timeoutMs = 600000 } = {}) {
  let job = await fetchJson("/sidecar/raster/run", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool_id: toolId, input_path: input, output_path: output, parameters }),
  });
  const started = Date.now();
  while (job.status === "running" || job.status === "queued" || job.status === "pending") {
    if (Date.now() - started > timeoutMs) throw new Error(`${toolId}: still running after ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, pollMs));
    job = await fetchJson(`/sidecar/conversion/jobs/${encodeURIComponent(job.id)}`);
  }
  if (job.status !== "succeeded") throw new Error(job.error || `${toolId} ${job.status}`);
  return job;
}

// Remote Processing plugin for GeoLibre: runs GeoLibre's own Processing tools (Whitebox Toolbox,
// GeoLibre Toolbox) on a shared sidecar server instead of in the browser, and moves files to and
// from that server. No data is bundled: participants upload their own.

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

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
}

function saveConfig(cfg) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch { /* private mode: session only */ }
}

let config = loadConfig();
// Each installation gets its own folder on the server, created on first use and kept in this browser.
if (!isParticipantId(config.uid)) {
  config = { ...config, uid: newParticipantId() };
  saveConfig(config);
}
let originalFetch = null;

function installFetch() {
  if (originalFetch) return;
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = makeFetch(originalFetch, () => config, globalThis.location.origin);
}

function restoreFetch() {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = null;
}

function serverFetch(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Access-Code", config.code || "");
  headers.set("X-Participant", config.uid);
  return (originalFetch || globalThis.fetch)(`${config.server}${path}`, { ...init, headers });
}

async function serverJson(path, init) {
  const r = await serverFetch(path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || (r.status === 401 ? "Wrong access code" : `Server error ${r.status}`));
  return body;
}

function createPanel(app) {
  const root = el("div", { class: "rp-panel" });
  const notice = (msg, error = false) => {
    const n = el("div", { class: `rp-toast${error ? " rp-error" : ""}` }, msg);
    root.append(n);
    setTimeout(() => n.remove(), error ? 8000 : 3500);
  };

  // ---- connection ----
  const server = el("input", { type: "url", placeholder: "https://sidecar.example.org", value: config.server || "" });
  const code = el("input", { type: "password", placeholder: "Access code from your trainer", value: config.code || "" });
  const metres = el("input", { type: "checkbox", checked: config.metres !== false });
  metres.addEventListener("change", () => { config = { ...config, metres: metres.checked }; saveConfig(config); });
  const status = el("p", { class: "rp-status" }, config.server ? "Checking..." : "Not connected: tools run in the browser.");

  async function check() {
    if (!config.server) { status.textContent = "Not connected: tools run in the browser."; status.className = "rp-status"; return false; }
    status.textContent = "Checking...";
    try {
      const r = await serverFetch("/sidecar/health");
      if (r.status === 401) throw new Error("Wrong access code");
      if (!r.ok) throw new Error(`Server answered ${r.status}`);
      status.textContent = `Connected to ${config.server}. Untick "Run locally (WASM)" in GeoLibre's tools to run them there.`;
      status.className = "rp-status rp-ok";
      return true;
    } catch (e) {
      status.textContent = `Not connected: ${e.message}`;
      status.className = "rp-status rp-error-text";
      return false;
    }
  }

  const save = el("button", { type: "button", class: "rp-primary" }, "Save and connect");
  save.addEventListener("click", async () => {
    config = { ...config, server: normalizeServer(server.value), code: code.value.trim(), metres: metres.checked };
    server.value = config.server;
    saveConfig(config);
    if (await check()) refresh();
  });
  const disconnect = el("button", { type: "button" }, "Disconnect");
  disconnect.addEventListener("click", () => {
    config = { uid: config.uid };  // keep the folder id
    saveConfig(config);
    server.value = "";
    code.value = "";
    check();
    list.replaceChildren();
  });

  // ---- your folder ----
  const folderCode = el("code", {}, `/data/${config.uid}`);
  const otherId = el("input", { type: "text", placeholder: "u-..." });
  const useOther = el("button", { type: "button" }, "Use this folder");
  useOther.addEventListener("click", () => {
    const id = otherId.value.trim().toLowerCase();
    if (!isParticipantId(id)) { notice("A folder id looks like u-7f3k9q2m1x", true); return; }
    config = { ...config, uid: id };
    saveConfig(config);
    folderCode.textContent = `/data/${id}`;
    otherId.value = "";
    refresh();
  });

  // ---- upload ----
  const picker = el("input", { type: "file", multiple: true, accept: ".tif,.tiff,.geojson,.json,.gpkg,.fgb,.csv,.zip,.shp,.shx,.dbf,.prj,.cpg,.parquet,.las,.laz" });
  const upload = el("button", { type: "button", class: "rp-primary" }, "Upload to server");
  const progress = el("p", { class: "rp-muted" });
  upload.addEventListener("click", async () => {
    if (!config.server) { notice("Connect to a server first", true); return; }
    const files = [...picker.files];
    if (!files.length) { notice("Choose files first", true); return; }
    for (const f of files) {
      progress.textContent = `Uploading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)...`;
      try {
        const url = `/files/${encodeURIComponent(f.name)}`;
        let r = await serverFetch(url, { method: "PUT", body: f, headers: { "If-None-Match": "*" } });
        if (r.status === 412) {
          if (!confirm(`${f.name} is already in your folder. Replace it?`)) continue;
          r = await serverFetch(url, { method: "PUT", body: f });
        }
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.detail || `upload failed (${r.status})`);
        notice(`Uploaded: ${out.path}`);
      } catch (e) { notice(`${f.name}: ${e.message}`, true); }
    }
    progress.textContent = "";
    picker.value = "";
    refresh();
  });

  // ---- files ----
  const list = el("div", { class: "rp-list" });
  const copy = (text) => navigator.clipboard?.writeText(text).then(() => notice(`Copied ${text}`), () => notice(text));

  async function addToMap(f) {
    try {
      if (f.kind === "raster") {
        notice(`Preparing ${f.name} for the map...`);
        const d = await serverJson(`/files/${encodeURIComponent(f.name)}/display?scope=${f.scope || "own"}`, { method: "POST" });
        const opts = Number.isFinite(d.min) && Number.isFinite(d.max) && d.max > d.min ? { rescaleMin: d.min, rescaleMax: d.max } : {};
        app.addCogLayer?.(f.name, withCode(`${config.server}${d.url}`, config.code), { colormap: "viridis", ...opts });
      } else {
        // Vectors come back in lat/lon (results of auto-projected jobs are converted from UTM).
        app.addGeoJsonLayer?.(f.name, await serverJson(`/files/${encodeURIComponent(f.name)}/geojson?scope=${f.scope || "own"}`));
      }
      notice(`Added ${f.name}`);
    } catch (e) { notice(e.message, true); }
  }

  async function remove(f) {
    if (!confirm(`Delete ${f.name} from your folder on the server?`)) return;
    try { await serverJson(`/files/${encodeURIComponent(f.name)}`, { method: "DELETE" }); refresh(); } catch (e) { notice(e.message, true); }
  }

  let serverFiles = [];

  function fileItem(f, shared) {
    const kind = fileKind(f.name);
    return el("div", { class: "rp-item" },
      el("div", {}, el("span", { class: `rp-badge rp-${f.kind}` }, f.kind), " ", el("b", {}, f.name),
        el("small", {}, ` ${f.size_mb} MB, ${f.modified} UTC`)),
      el("code", {}, f.path),
      el("div", { class: "rp-row" },
        el("button", { type: "button", onclick: () => copy(f.path) }, "Copy path"),
        kind !== "file" ? el("button", { type: "button", onclick: () => addToMap({ ...f, kind, scope: shared ? "shared" : "own" }) }, "Add to map") : null,
        el("a", { class: "rp-button", href: withCode(`${config.server}${f.path}`, config.code), download: f.name, target: "_blank" }, "Download"),
        shared ? null : el("button", { type: "button", onclick: () => remove(f) }, "Delete")));
  }

  async function refresh() {
    if (!config.server) return;
    list.replaceChildren("Loading...");
    try {
      const r = await serverJson("/files");
      serverFiles = [...r.files, ...(r.shared || []).map((f) => ({ ...f, shared: true }))];
      fillZonalPickers();
      list.replaceChildren(
        ...(r.files.length ? r.files.map((f) => fileItem(f, false)) : ["Your folder is empty. Upload your data above."]),
        ...(r.shared?.length ? [el("h4", {}, "Shared files (from the trainer, read-only)"), ...r.shared.map((f) => fileItem(f, true))] : []));
    } catch (e) { list.replaceChildren(el("p", { class: "rp-error-text" }, e.message)); }
  }

  // ---- zonal statistics (GeoLibre's own implementation, run on the sidecar) ----
  const zRaster = el("select", {});
  const zZones = el("select", {});
  const zBand = el("input", { type: "number", min: "1", value: "1" });
  const zPrefix = el("input", { type: "text", placeholder: "e.g. dem_ (optional)" });
  const zCsv = el("input", { type: "checkbox", checked: true });
  const zStatus = el("p", { class: "rp-muted" });

  function vectorLayers() {
    return (app.listLayers?.() || []).filter((l) => !/tile|xyz|raster|cog|wms|wmts|zarr|image|terrain|3d|background|basemap/i.test(`${l.type || ""}`));
  }

  function fillZonalPickers() {
    const keep = [zRaster.value, zZones.value];
    zRaster.replaceChildren(...serverFiles.filter((f) => f.kind === "raster").map((f) => el("option", { value: f.path }, f.shared ? `Shared: ${f.name}` : f.name)));
    zZones.replaceChildren(
      ...vectorLayers().map((l) => el("option", { value: `layer:${l.id}` }, `Map layer: ${l.name}`)),
      ...serverFiles.filter((f) => /\.(geojson|json)$/i.test(f.name)).map((f) => el("option", { value: f.path }, `${f.shared ? "Shared file" : "Server file"}: ${f.name}`)));
    if ([...zRaster.options].some((o) => o.value === keep[0])) zRaster.value = keep[0];
    if ([...zZones.options].some((o) => o.value === keep[1])) zZones.value = keep[1];
  }

  function downloadText(text, filename, type) {
    const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const zRun = el("button", { type: "button", class: "rp-primary" }, "Run zonal statistics on the server");
  zRun.addEventListener("click", async () => {
    if (!config.server) { notice("Connect to a server first", true); return; }
    if (!zRaster.value) { notice("Upload a raster first (or run a tool that writes one under /data)", true); return; }
    if (!zZones.value) { notice("Add a polygon layer to the map or upload a GeoJSON of zones", true); return; }
    zRun.disabled = true;
    try {
      let zonesPath = zZones.value;
      if (zonesPath.startsWith("layer:")) {
        // Zones drawn or loaded in GeoLibre: send them to the server as a GeoJSON file.
        const id = zonesPath.slice(6);
        const layer = vectorLayers().find((l) => l.id === id);
        const features = app.getLayerFeatures?.(id) || [];
        if (!features.length) throw new Error("That layer has no features");
        zStatus.textContent = "Sending the zones to the server...";
        const name = `zones-${safeStem(layer?.name)}-${Date.now().toString(36)}.geojson`;
        const up = await serverJson(`/files/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ type: "FeatureCollection", features }) });
        zonesPath = up.path;
      }
      const rasterName = zRaster.selectedOptions[0]?.textContent || "raster";
      const output = `/data/${config.uid}/zonal-${safeStem(rasterName)}-${Date.now().toString(36)}.geojson`;
      zStatus.textContent = "Computing on the server...";
      const job = await runRasterTool(serverJson, { toolId: "zonal", input: zRaster.value, output,
        parameters: { zones_path: zonesPath, band: Number(zBand.value) || 1, prefix: zPrefix.value.trim() } });
      const fc = await serverJson(`/files/${encodeURIComponent(output.split("/").pop())}/geojson`);
      app.addGeoJsonLayer?.(`Zonal statistics: ${rasterName}`, fc);
      zStatus.textContent = `${(job.messages || []).slice(-1)[0] || "Done"}. Click a zone on the map to see its values.`;
      if (zCsv.checked) downloadText(featuresToCsv(fc), `${output.split("/").pop().replace(/\.geojson$/, "")}.csv`, "text/csv");
      refresh();
    } catch (e) {
      zStatus.textContent = e.message;
      notice(e.message, true);
    } finally { zRun.disabled = false; }
  });
  setInterval(() => { if (root.isConnected && document.activeElement !== zZones) fillZonalPickers(); }, 4000);

  root.append(
    el("h4", {}, "Processing server"), el("label", { class: "rp-field" }, el("span", {}, "Server"), server),
    el("label", { class: "rp-field" }, el("span", {}, "Access code"), code),
    el("div", { class: "rp-row" }, save, disconnect), status,
    el("label", { class: "rp-check", title: "Whitebox tools measure in the data's units. With this on, data in latitude/longitude is reprojected to the local UTM zone on the server, so areas are in m², lengths and distances in metres. Results return to the map in latitude/longitude." },
      metres, " Measure in metres (reproject lat/lon data to UTM automatically)"),
    el("details", { class: "rp-help", open: true }, el("summary", {}, "How to run a tool on the server"),
      el("ol", {},
        el("li", {}, "Upload your rasters below (vector layers on the map need no upload)."),
        el("li", {}, "Processing > Whitebox Toolbox (or GeoLibre Toolbox): untick \"Run locally (WASM)\"."),
        el("li", {}, "For raster inputs choose Path and paste the server path (Copy path below)."),
        el("li", {}, "Set the output to a new file in your folder, e.g. ", el("code", {}, `/data/${config.uid}/slope.tif`), ", and Run."),
        el("li", {}, "Refresh the file list here and Add the result to the map, or Download it."))),
    el("h4", {}, "Your folder"),
    el("div", { class: "rp-row" }, folderCode, el("button", { type: "button", onclick: () => copy(`/data/${config.uid}`) }, "Copy")),
    el("p", { class: "rp-muted" }, "Created for this browser. Note the id if you will switch browsers or clear browser data."),
    el("details", {}, el("summary", {}, "Use an existing folder id"), el("div", { class: "rp-row" }, otherId, useOther)),
    el("h4", {}, "Upload your data"), picker, upload, progress,
    el("h4", {}, "Zonal statistics"),
    el("p", { class: "rp-muted" }, "GeoLibre's zonal statistics (count, min, max, mean, sum, std, median per zone), run on the server."),
    el("label", { class: "rp-field" }, el("span", {}, "Raster (on the server)"), zRaster),
    el("label", { class: "rp-field" }, el("span", {}, "Zones (polygons)"), zZones),
    el("div", { class: "rp-row" }, el("label", { class: "rp-field" }, el("span", {}, "Band"), zBand), el("label", { class: "rp-field" }, el("span", {}, "Field prefix"), zPrefix)),
    el("label", { class: "rp-check" }, zCsv, " Also download the table as CSV"),
    zRun, zStatus,
    el("div", { class: "rp-row" }, el("h4", {}, "Files on the server"), el("button", { type: "button", onclick: refresh }, "Refresh")),
    list);
  check().then((ok) => { if (ok) refresh(); });
  return root;
}

const plugin = {
  id: "remote-processing",
  name: "Remote Processing",
  version: VERSION,
  engines: ["maplibre"],
  activate(app) {
    installFetch();
    app.registerRightPanel?.({
      id: "remote-processing",
      title: "Remote Processing",
      dock: "right-of-style",
      render: (container) => container.replaceChildren(createPanel(app)),
    });
    app.registerToolbarMenu?.({
      id: "remote-processing-menu",
      label: "Remote Processing",
      items: [{ id: "open", label: "Server connection and files", onSelect: () => app.openRightPanel?.("remote-processing") }],
    });
  },
  deactivate(app) {
    restoreFetch();
    app?.unregisterRightPanel?.("remote-processing");
    app?.unregisterToolbarMenu?.("remote-processing-menu");
  },
};

export default plugin;
export { plugin };
