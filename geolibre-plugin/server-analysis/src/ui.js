// Server Analysis panel for GeoLibre. Browsing and analysis requests go to the course server;
// the browser only draws the results.
import {
  CATALOGS, OSM_LAYERS, PATHS, SERVER_TOOLS, assetKind, assetRefs, bboxFeature, executeProcess,
  featureCollection, rescaleFromStats, resultLayers, summarise, tileTemplate, wbtArgs, wbtFields,
} from "./core.js";

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

  async function addRaster(name, ref, tileHref, rescale, colormap) {
    if (!rescale) {
      try {
        rescale = rescaleFromStats(await getJson(`${PATHS.tiles}/cog/statistics?url=${encodeURIComponent(tileHref)}`));
      } catch { rescale = null; }
    }
    app.addTileLayer?.(name, tileTemplate(tileHref, { rescale, colormap }), { opacity: 0.85 });
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
          await addRaster(layer.name, layer.href, layer.href, layer.rescale, processId === "suitability" ? "rdylgn" : "viridis");
        } else {
          app.addGeoJsonLayer?.(layer.name, layer.geojson);
        }
      }
      notify(`${label}: done`);
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
    const list = el("div", { class: "sa-list" }, "Loading catalogue...");
    const search = el("input", { type: "search", placeholder: "Search datasets" });
    const catSel = el("select", {}, Object.entries(CATALOGS).map(([k, c]) => el("option", { value: k }, c.label)));
    catSel.value = state.catalog;
    let collections = [];
    const base = () => CATALOGS[state.catalog].url || PATHS.stac;

    function render() {
      const q = search.value.toLowerCase();
      list.replaceChildren(...collections
        .filter((c) => !q || `${c.id} ${c.title || ""} ${c.description || ""} ${(c.keywords || []).join(" ")}`.toLowerCase().includes(q))
        .map((c) => el("details", { class: "sa-coll" },
          el("summary", {}, el("b", {}, c.title || c.id), el("small", {}, ` ${c.id}`)),
          el("p", {}, (c.description || "").slice(0, 300)),
          el("button", { type: "button", onclick: (ev) => loadItems(c, ev.target.parentElement) }, "Show items in current view"))));
    }

    async function loadCollections() {
      try {
        collections = (await getJson(`${base()}/collections`)).collections || [];
        render();
      } catch (e) { list.replaceChildren(`Could not load catalogue: ${e.message}`); }
    }

    async function loadItems(c, container) {
      const box = el("div", { class: "sa-items" }, "Searching...");
      container.querySelector(".sa-items")?.remove();
      container.append(box);
      try {
        const bbox = currentView().join(",");
        const res = await getJson(`${base()}/search?collections=${encodeURIComponent(c.id)}&bbox=${bbox}&limit=20`);
        const items = res.features || [];
        if (!items.length) { box.replaceChildren("No items in this view. Pan or zoom out."); return; }
        box.replaceChildren(...items.map((it) => el("div", { class: "sa-item" },
          el("div", {}, el("b", {}, it.id), it.properties?.datetime ? el("small", {}, ` ${it.properties.datetime.slice(0, 10)}`) : null),
          Object.entries(it.assets || {}).filter(([, a]) => assetKind(a)).map(([k, a]) =>
            el("button", { type: "button", onclick: () => addAsset(c, it, k, a) }, `Add ${a.title || k}`)))));
      } catch (e) { box.replaceChildren(e.message); }
    }

    async function addAsset(c, item, key, asset) {
      const { ref, tileHref } = assetRefs(state.catalog, c.id, item.id, key, asset);
      const name = `${c.title || c.id} ${item.id}${key === "data" ? "" : ` ${key}`}`;
      try {
        if (assetKind(asset) === "raster") {
          const categorical = /class|cover|lulc|landuse|land-use/i.test(`${c.id} ${key}`);
          await addRaster(name, ref, tileHref, null, categorical ? "tab20" : "viridis");
        } else {
          const fc = await executeProcess(fetch, "features", { source: ref, aoi: currentView() }, { async: false });
          app.addGeoJsonLayer?.(name, fc);
        }
        notify(`Added ${name}`);
      } catch (e) { notify(e.message, true); }
    }

    search.addEventListener("input", render);
    catSel.addEventListener("change", () => { state.catalog = catSel.value; list.replaceChildren("Loading..."); loadCollections(); });
    loadCollections();
    return el("div", {}, el("div", { class: "sa-row" }, catSel, search), list);
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
      const stats = ["mean", "min", "max", "sum", "count", "median", "stdev", "majority"].map((s) => {
        const c = el("input", { type: "checkbox", value: s });
        if (["mean", "min", "max", "count"].includes(s)) c.checked = true;
        return { c, node: el("label", { class: "sa-check" }, c, s) };
      });
      return [r.node, z.node, el("div", { class: "sa-checks" }, stats.map((s) => s.node)),
        runButton("Run on server", () => {
          if (!r.value()) throw new Error("Choose a raster");
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
      j.result ? el("pre", {}, summarise(j.processId, j.result)) : null)) : ["No jobs yet. Run a tool from the Tools tab."]));
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

  const views = { data: dataView, tools: toolsView, jobs: jobsView };
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
