// Remote Processing plugin for GeoLibre: runs GeoLibre's own Processing tools (Whitebox Toolbox,
// GeoLibre Toolbox) on a shared sidecar server instead of in the browser, and moves files to and
// from that server. No data is bundled: participants upload their own.
import {
  STORAGE_KEY, VERSION, featuresToCsv, fileKind, isParticipantId, makeFetch, newParticipantId, normalizeServer,
  runRasterTool, safeStem, withCode,
} from "./core.js";

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
  const remote = makeFetch(originalFetch, () => config, globalThis.location.origin);
  globalThis.fetch = async (input, init) => {
    const response = await remote(input, init);
    // When GeoLibre sees a Whitebox job finish, tell the panel so the file list refreshes.
    const url = typeof input === "string" ? input : input?.url || "";
    if (config.server && /\/sidecar\/whitebox\/jobs\//.test(url) && response.ok) {
      response.clone().json().then((job) => {
        if (job?.status === "succeeded") globalThis.dispatchEvent(new CustomEvent("remote-processing:job-done", { detail: job }));
      }).catch(() => {});
    }
    return response;
  };
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
    if (await check()) { refresh(); showTab("data"); }
  });
  const disconnect = el("button", { type: "button" }, "Disconnect");
  disconnect.addEventListener("click", () => {
    config = { uid: config.uid };  // keep the folder id
    saveConfig(config);
    server.value = "";
    code.value = "";
    check();
    refresh();
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
    root.querySelectorAll(".rp-folderbar code").forEach((n) => { n.textContent = `/data/${id}`; });
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
  const copy = (text) => navigator.clipboard?.writeText(text).then(() => notice(`Copied ${text}`), () => notice(text));

  // ---- legend on the map for rasters added from the server (one box, one entry per raster) ----
  const legends = new Map();
  let legendBox = null;
  const legendControl = {
    onAdd() { return legendBox; },
    onRemove() { legendBox?.remove(); },
  };
  function fmt(v) { return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Number(v.toPrecision(3)).toString(); }
  function renderLegends() {
    legendBox.replaceChildren(...[...legends].map(([name, spec]) => {
      const head = el("div", { class: "rp-lg-head" }, el("b", {}, name),
        el("button", { type: "button", title: "Remove from legend", onclick: () => { legends.delete(name); renderLegends(); } }, "×"));
      if (spec.classes) {
        const dict = Object.fromEntries(spec.classes.map((c) => [c.label, c.color]));
        return el("div", { class: "rp-lg" }, head,
          ...spec.classes.map((c) => el("div", { class: "rp-lg-row" }, el("span", { class: "rp-lg-sw", style: `background:${c.color}` }), `${c.value} ${c.label}`)),
          el("button", { type: "button", class: "rp-lg-copy", title: "For Project > Print Layout > Custom legend > Import from dictionary",
            onclick: () => copy(JSON.stringify(dict)) }, "Copy for print legend"));
      }
      return el("div", { class: "rp-lg" }, head, el("div", { class: "rp-lg-bar" }),
        el("div", { class: "rp-lg-scale" }, el("span", {}, fmt(spec.min)), el("span", {}, fmt(spec.max))));
    }));
    if (!legends.size && legendBox.isConnected) { app.removeMapControl?.(legendControl); }
  }
  function showLegend(name, spec) {
    legends.set(name, spec);
    if (!legendBox) legendBox = el("div", { class: "maplibregl-ctrl rp-legend" });
    renderLegends();
    if (!legendBox.isConnected) app.addMapControl?.(legendControl, "bottom-left");
  }

  async function addToMap(f) {
    try {
      if (f.kind === "raster") {
        notice(`Preparing ${f.name} for the map...`);
        const d = await serverJson(`/files/${encodeURIComponent(f.name)}/display?scope=${f.scope || "own"}`, { method: "POST" });
        const url = withCode(`${config.server}${d.url}`, config.code);
        if (d.rgb) {
          // Land cover in WorldCover codes: the server sends a copy painted in the official colours.
          app.addCogLayer?.(f.name, url, { bands: "1,2,3", nodata: 0 });
          showLegend(f.name, { classes: d.legend });
        } else {
          const opts = Number.isFinite(d.min) && Number.isFinite(d.max) && d.max > d.min ? { rescaleMin: d.min, rescaleMax: d.max } : {};
          app.addCogLayer?.(f.name, url, { colormap: "viridis", ...opts });
          if (opts.rescaleMin !== undefined) showLegend(f.name, { min: d.min, max: d.max });
        }
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
      el("div", { class: "rp-item-head" }, el("b", {}, f.name), el("small", {}, `${f.size_mb} MB · ${f.modified} UTC`)),
      el("code", { class: "rp-path" }, f.path),
      el("div", { class: "rp-actions" },
        kind !== "file" ? el("button", { type: "button", class: "rp-small rp-strong", onclick: () => addToMap({ ...f, kind, scope: shared ? "shared" : "own" }) }, "Add to map") : null,
        el("button", { type: "button", class: "rp-small", onclick: () => copy(f.path) }, "Copy path"),
        el("a", { class: "rp-small", href: withCode(`${config.server}${f.path}`, config.code), download: f.name, target: "_blank" }, "Download"),
        shared ? null : el("button", { type: "button", class: "rp-small rp-danger", onclick: () => remove(f) }, "Delete")));
  }

  const GROUPS = [["raster", "Rasters"], ["vector", "Vectors"], ["file", "Other files"]];

  /** Collapsible Rasters / Vectors / Other sections; groups with no files are left out. */
  function grouped(files, shared) {
    return GROUPS.map(([kind, title]) => {
      const items = files.filter((f) => (fileKind(f.name) === "file" ? "file" : fileKind(f.name)) === kind);
      if (!items.length) return null;
      return el("details", { class: "rp-group", open: !shared },
        el("summary", {}, el("span", { class: `rp-dot rp-${kind}` }), `${title} `, el("span", { class: "rp-count" }, String(items.length))),
        items.map((f) => fileItem(f, shared)));
    }).filter(Boolean);
  }

  const myList = el("div", {});
  const sharedList = el("div", {});
  const sharedBlock = el("details", { class: "rp-card rp-collapsible", open: true, hidden: true },
    el("summary", {}, el("h3", {}, "Shared course data ", el("small", {}, "read-only"))), sharedList);

  async function refresh() {
    if (!config.server) {
      myList.replaceChildren(el("p", { class: "rp-empty" }, "No data yet. Connect to the server in the ", el("b", {}, "Settings & help"), " tab."));
      sharedBlock.hidden = true;
      return;
    }
    myList.replaceChildren(el("p", { class: "rp-muted" }, "Loading..."));
    try {
      const r = await serverJson("/files");
      serverFiles = [...r.files, ...(r.shared || []).map((f) => ({ ...f, shared: true }))];
      fillZonalPickers();
      myList.replaceChildren(...(r.files.length ? grouped(r.files, false)
        : [el("p", { class: "rp-empty" }, "No data yet. Upload files below, or run a tool with an output in your folder.")]));
      sharedList.replaceChildren(...grouped(r.shared || [], true));
      sharedBlock.hidden = !(r.shared || []).length;
    } catch (e) { myList.replaceChildren(el("p", { class: "rp-error-text" }, e.message)); }
  }

  // ---- zonal statistics (GeoLibre's own implementation, run on the sidecar) ----
  const zRaster = el("select", {});
  const zZones = el("select", {});
  const zBand = el("input", { type: "number", min: "1", value: "1" });
  const zPrefix = el("input", { type: "text", placeholder: "e.g. dem_ (optional)" });
  const zCsv = el("input", { type: "checkbox", checked: true });
  const zStatus = el("p", { class: "rp-muted" });
  const zMode = el("select", {},
    el("option", { value: "summary" }, "Summary: count, min, max, mean, sum, std, median"),
    el("option", { value: "classes" }, "Area of each class (land cover, other class rasters)"));

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
      if (zMode.value === "classes") {
        // Categorical raster: km2 and % of each class per zone (computed by the file service).
        const own = zonesPath.startsWith(`/data/${config.uid}/`);
        const zones = await serverJson(`/files/${encodeURIComponent(zonesPath.split("/").pop())}/geojson${own ? "" : "?scope=shared"}`);
        zStatus.textContent = "Computing class areas on the server...";
        const fc = await serverJson("/files/zonal-classes", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ raster: zRaster.value, zones, prefix: zPrefix.value.trim() }) });
        app.addGeoJsonLayer?.(`Class areas: ${rasterName}`, fc);
        zStatus.textContent = `Done. Classes: ${fc.classes}. Click a zone on the map to see km² and % of each class.`;
        if (zCsv.checked) downloadText(featuresToCsv(fc), `classes-${safeStem(rasterName)}-${Date.now().toString(36)}.csv`, "text/csv");
        return;
      }
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

  // ---- logo on an exported map (GeoLibre's Print Layout has no image element) ----
  const lMap = el("input", { type: "file", accept: "image/png,image/jpeg" });
  const lLogo = el("input", { type: "file", accept: "image/png,image/jpeg,image/svg+xml" });
  const lCorner = el("select", {}, ...[["br", "Bottom right"], ["bl", "Bottom left"], ["tr", "Top right"], ["tl", "Top left"]]
    .map(([v, t]) => el("option", { value: v }, t)));
  const lSize = el("input", { type: "number", min: "5", max: "40", value: "16" });
  const lStatus = el("p", { class: "rp-muted" });
  const lRun = el("button", { type: "button", class: "rp-primary" }, "Add logo and download");
  lRun.addEventListener("click", async () => {
    const file = lMap.files?.[0];
    if (!file) { notice("Choose the PNG you exported from Print Layout", true); return; }
    lRun.disabled = true;
    try {
      const map = await createImageBitmap(file);
      let logoBlob = lLogo.files?.[0];
      if (!logoBlob) {
        const r = await serverFetch("/plugin/assets/isdb-logo.png");
        if (!r.ok) throw new Error("Could not load the IsDB logo from the server");
        logoBlob = await r.blob();
      }
      const logo = await createImageBitmap(logoBlob);
      const canvas = el("canvas", {});
      canvas.width = map.width; canvas.height = map.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(map, 0, 0);
      const w = Math.round(map.width * (Math.min(40, Math.max(5, Number(lSize.value) || 16)) / 100));
      const h = Math.round(w * logo.height / logo.width);
      const pad = Math.round(map.width * 0.02);
      const x = lCorner.value.endsWith("r") ? map.width - w - pad : pad;
      const y = lCorner.value.startsWith("b") ? map.height - h - pad : pad;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(x - pad / 3, y - pad / 3, w + 2 * pad / 3, h + 2 * pad / 3);
      ctx.drawImage(logo, x, y, w, h);
      const out = await new Promise((res) => canvas.toBlob(res, "image/png"));
      const a = el("a", { href: URL.createObjectURL(out), download: file.name.replace(/\.(png|jpe?g)$/i, "") + "-logo.png" });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      lStatus.textContent = "Downloaded the map with the logo.";
    } catch (e) {
      lStatus.textContent = e.message;
      notice(e.message, true);
    } finally { lRun.disabled = false; }
  });

  const menu = (...parts) => el("span", { class: "rp-menu" }, parts.join(" › "));
  const ui = (text) => el("b", {}, text);

  // ---- Data tab ----
  const dataTab = el("div", { class: "rp-tab-body" },
    el("div", { class: "rp-folderbar" },
      el("span", {}, "Your folder ", el("code", {}, `/data/${config.uid}`)),
      el("button", { type: "button", class: "rp-small", onclick: refresh }, "↻ Refresh")),
    el("details", { class: "rp-card rp-collapsible", open: true }, el("summary", {}, el("h3", {}, "My data")), myList),
    sharedBlock,
    el("section", { class: "rp-card" }, el("h3", {}, "Upload"),
      el("p", { class: "rp-muted" }, "GeoTIFF rasters you want to process. Vector layers on the map need no upload."),
      picker, el("div", { class: "rp-row" }, upload), progress),
    el("details", { class: "rp-card rp-collapsible" },
      el("summary", {}, el("h3", {}, "Zonal statistics")),
      el("p", { class: "rp-muted" }, "Summary statistics of a raster within each polygon, or the area of each class of a land-cover raster. Computed on the server."),
      el("label", { class: "rp-field" }, el("span", {}, "Raster"), zRaster),
      el("label", { class: "rp-field" }, el("span", {}, "Statistics"), zMode),
      el("label", { class: "rp-field" }, el("span", {}, "Zones (polygons)"), zZones),
      el("div", { class: "rp-two" }, el("label", { class: "rp-field" }, el("span", {}, "Band"), zBand),
        el("label", { class: "rp-field" }, el("span", {}, "Field prefix"), zPrefix)),
      el("label", { class: "rp-check" }, zCsv, " Also download the table as CSV"),
      el("div", { class: "rp-row" }, zRun), zStatus),
    el("details", { class: "rp-card rp-collapsible" },
      el("summary", {}, el("h3", {}, "Logo on a printed map")),
      el("p", { class: "rp-muted" }, "Export a PNG from Project › Print Layout, choose it here, and download it with a logo in one corner. The IsDB logo is used unless you choose your own."),
      el("label", { class: "rp-field" }, el("span", {}, "Exported map (PNG)"), lMap),
      el("label", { class: "rp-field" }, el("span", {}, "Logo (optional, default IsDB)"), lLogo),
      el("div", { class: "rp-two" }, el("label", { class: "rp-field" }, el("span", {}, "Corner"), lCorner),
        el("label", { class: "rp-field" }, el("span", {}, "Logo width (% of page)"), lSize)),
      el("div", { class: "rp-row" }, lRun), lStatus));

  // ---- Settings & help tab ----
  const helpTab = el("div", { class: "rp-tab-body" },
    el("section", { class: "rp-card" }, el("h3", {}, "Connection"),
      el("label", { class: "rp-field" }, el("span", {}, "Server"), server),
      el("label", { class: "rp-field" }, el("span", {}, "Access code"), code),
      el("div", { class: "rp-row" }, save, disconnect), status,
      el("label", { class: "rp-check", title: "Whitebox tools measure in the data's units. With this on, data in latitude/longitude is reprojected to the local UTM zone on the server, so areas are in m², lengths and distances in metres. Results return to the map in latitude/longitude." },
        metres, " Measure in metres (reproject lat/lon data to UTM automatically)")),
    el("section", { class: "rp-card" }, el("h3", {}, "Your folder"),
      el("div", { class: "rp-row" }, folderCode, el("button", { type: "button", class: "rp-small", onclick: () => copy(`/data/${config.uid}`) }, "Copy")),
      el("p", { class: "rp-muted" }, "Created for this browser. Write the id down if you will switch browsers or clear browsing data."),
      el("details", {}, el("summary", {}, "Use an existing folder id"), el("div", { class: "rp-row" }, otherId, useOther))),
    el("section", { class: "rp-card rp-doc" }, el("h3", {}, "How to run a tool on the server"),
      el("ol", {},
        el("li", {}, "Upload your rasters in the ", ui("Data"), " tab. Vector layers on the map need no upload."),
        el("li", {}, "Open ", menu("Processing", "Whitebox Toolbox"), " (or ", menu("GeoLibre Toolbox"), ") and untick ", ui("Run locally (WASM)"), "."),
        el("li", {}, "For raster inputs choose ", ui("Path"), " and paste the server path (", ui("Copy path"), " in the Data tab)."),
        el("li", {}, "Output: leave ", ui("Auto"), " or type a name such as ", el("code", {}, "slope"), ". It is saved in your folder automatically. Then click ", ui("Run"), "."),
        el("li", {}, "The result appears in the ", ui("Data"), " tab when the tool finishes: ", ui("Add to map"), " or ", ui("Download"), " it."))),
    el("section", { class: "rp-card rp-doc" }, el("h3", {}, "Zonal statistics"),
      el("ol", {},
        el("li", {}, "Load or draw your zones on the map (", menu("Add Data", "Vector Layer"), " or ", menu("Plugins", "GeoEditor"), ")."),
        el("li", {}, "In the Data tab open ", ui("Zonal statistics"), ", pick the raster and the zones layer."),
        el("li", {}, "Click ", ui("Run zonal statistics on the server"), ". The zones get the statistics (click one on the map) and the table downloads as CSV."))),
    el("section", { class: "rp-card rp-doc" }, el("h3", {}, "Tips"),
      el("ul", {},
        el("li", {}, "A tool that fails to read its input usually still has ", ui("Run locally (WASM)"), " ticked."),
        el("li", {}, "Outputs: ", ui("Auto"), " gives a name like ", el("code", {}, "slope-20261008-153000.tif"), "; a name you type replaces an existing file of the same name."),
        el("li", {}, "Click a server raster in the Layers panel to style it: colormap, bands, rescale."),
        el("li", {}, "Clip large rasters to your study area before uploading."))));

  // ---- tabs ----
  const tabs = { data: ["Data", dataTab], help: ["Settings & help", helpTab] };
  const tabButtons = {};
  function showTab(key) {
    for (const [k, [, body]] of Object.entries(tabs)) {
      body.hidden = k !== key;
      tabButtons[k].classList.toggle("rp-active", k === key);
      tabButtons[k].setAttribute("aria-selected", String(k === key));
    }
  }
  const tabBar = el("div", { class: "rp-tabs", role: "tablist" }, Object.entries(tabs).map(([k, [label]]) => {
    tabButtons[k] = el("button", { type: "button", role: "tab", onclick: () => showTab(k) }, label);
    return tabButtons[k];
  }));
  root.append(tabBar, dataTab, helpTab);
  showTab(config.server ? "data" : "help");

  const onJobDone = () => { if (root.isConnected) refresh(); };
  globalThis.addEventListener("remote-processing:job-done", onJobDone);
  refresh();
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
