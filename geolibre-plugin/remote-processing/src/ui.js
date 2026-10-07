// Remote Processing plugin for GeoLibre: runs GeoLibre's own Processing tools (Whitebox Toolbox,
// GeoLibre Toolbox) on a shared sidecar server instead of in the browser, and moves files to and
// from that server. No data is bundled: participants upload their own.
import {
  STORAGE_KEY, VERSION, fileKind, makeFetch, normalizeServer, withCode,
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
    config = { server: normalizeServer(server.value), code: code.value.trim() };
    server.value = config.server;
    saveConfig(config);
    if (await check()) refresh();
  });
  const disconnect = el("button", { type: "button" }, "Disconnect");
  disconnect.addEventListener("click", () => {
    config = {};
    saveConfig(config);
    server.value = "";
    code.value = "";
    check();
    list.replaceChildren();
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
        const out = await serverJson(`/files/${encodeURIComponent(f.name)}`, { method: "PUT", body: f });
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
        const d = await serverJson(`/files/${encodeURIComponent(f.name)}/display`, { method: "POST" });
        const opts = Number.isFinite(d.min) && Number.isFinite(d.max) && d.max > d.min ? { rescaleMin: d.min, rescaleMax: d.max } : {};
        app.addCogLayer?.(f.name, withCode(`${config.server}${d.url}`, config.code), { colormap: "viridis", ...opts });
      } else {
        const r = await serverFetch(`/data/${encodeURIComponent(f.name)}`);
        if (!r.ok) throw new Error(`could not read ${f.name}`);
        app.addGeoJsonLayer?.(f.name, await r.json());
      }
      notice(`Added ${f.name}`);
    } catch (e) { notice(e.message, true); }
  }

  async function remove(f) {
    if (!confirm(`Delete ${f.name} from the server? Other participants may be using it.`)) return;
    try { await serverJson(`/files/${encodeURIComponent(f.name)}`, { method: "DELETE" }); refresh(); } catch (e) { notice(e.message, true); }
  }

  async function refresh() {
    if (!config.server) return;
    list.replaceChildren("Loading...");
    try {
      const r = await serverJson("/files");
      list.replaceChildren(...(r.files.length ? r.files.map((f) => el("div", { class: "rp-item" },
        el("div", {}, el("span", { class: `rp-badge rp-${f.kind}` }, f.kind), " ", el("b", {}, f.name),
          el("small", {}, ` ${f.size_mb} MB, ${f.modified} UTC`)),
        el("code", {}, f.path),
        el("div", { class: "rp-row" },
          el("button", { type: "button", onclick: () => copy(f.path) }, "Copy path"),
          f.kind !== "file" || fileKind(f.name) !== "file" ? el("button", { type: "button", onclick: () => addToMap({ ...f, kind: fileKind(f.name) }) }, "Add to map") : null,
          el("a", { class: "rp-button", href: withCode(`${config.server}/data/${encodeURIComponent(f.name)}`, config.code), download: f.name, target: "_blank" }, "Download"),
          el("button", { type: "button", onclick: () => remove(f) }, "Delete"))))
        : ["No files yet. Upload your data above."]));
    } catch (e) { list.replaceChildren(el("p", { class: "rp-error-text" }, e.message)); }
  }

  root.append(
    el("h4", {}, "Processing server"), el("label", { class: "rp-field" }, el("span", {}, "Server"), server),
    el("label", { class: "rp-field" }, el("span", {}, "Access code"), code),
    el("div", { class: "rp-row" }, save, disconnect), status,
    el("details", { class: "rp-help", open: true }, el("summary", {}, "How to run a tool on the server"),
      el("ol", {},
        el("li", {}, "Upload your rasters below (vector layers on the map need no upload)."),
        el("li", {}, "Processing > Whitebox Toolbox (or GeoLibre Toolbox): untick \"Run locally (WASM)\"."),
        el("li", {}, "For raster inputs choose Path and paste the server path (/data/...)."),
        el("li", {}, "Set the output to a new path under /data, e.g. /data/yourname-slope.tif, and Run."),
        el("li", {}, "Refresh the file list here and Add the result to the map, or Download it."))),
    el("h4", {}, "Upload your data"), picker, upload, progress,
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
