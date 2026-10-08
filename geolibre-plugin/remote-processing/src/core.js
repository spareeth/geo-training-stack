// Logic of the Remote Processing plugin that does not touch the page (tested with node --test).

export const VERSION = "0.5.0";
export const STORAGE_KEY = "geolibre-remote-processing";

/** "sidecar.example.org" or "https://sidecar.example.org/" -> "https://sidecar.example.org" */
export function normalizeServer(value) {
  let s = (value || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}

/**
 * GeoLibre's web build sends processing requests to `${location.origin}/sidecar/...`.
 * Returns the same request on the shared server, or null for any other URL.
 */
export function rewriteSidecarUrl(url, origin, server) {
  if (!server || typeof url !== "string") return null;
  const local = `${origin}/sidecar`;
  if (url === local || url.startsWith(`${local}/`) || url.startsWith(`${local}?`)) return server + "/sidecar" + url.slice(local.length);
  if (url === "/sidecar" || url.startsWith("/sidecar/")) return server + url;
  return null;
}

/** URL with the access code as ?code= (for map layers and downloads, which cannot send headers). */
export function withCode(url, code) {
  if (!code) return url;
  return `${url}${url.includes("?") ? "&" : "?"}code=${encodeURIComponent(code)}`;
}

/**
 * fetch() that sends GeoLibre's sidecar requests to the shared server with the access code, and
 * leaves every other request untouched. getConfig() is read on each call so settings apply at once.
 */
export function makeFetch(originalFetch, getConfig, origin) {
  return function remoteSidecarFetch(input, init) {
    const { server, code, uid, metres = true } = getConfig() || {};
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    const target = rewriteSidecarUrl(url, origin, server);
    if (!target) return originalFetch(input, init);
    const headers = new Headers(init?.headers || (typeof input === "object" && input?.headers) || undefined);
    if (code) headers.set("X-Access-Code", code);
    // The server saves tool outputs (Auto or a bare file name) in this participant's folder.
    if (uid) headers.set("X-Participant", uid);
    // Measure in metres: the server reprojects lat/lon inputs of Whitebox jobs to UTM.
    if (metres && /\/sidecar\/whitebox\/run(\?|$)/.test(target)) headers.set("X-Auto-Project", "utm");
    if (typeof input === "object" && !(input instanceof URL) && input) {
      return originalFetch(new Request(target, input), { ...init, headers });
    }
    return originalFetch(target, { ...init, headers });
  };
}

/** Random participant folder id, e.g. "u-7f3k9q2m1x" (letters and digits only). */
export function newParticipantId(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `u-${[...random(10)].map((b) => abc[b % abc.length]).join("")}`;
}

export function isParticipantId(value) {
  return /^u-[a-z0-9]{6,32}$/.test(value || "");
}

export function fileKind(name) {
  const n = (name || "").toLowerCase();
  if (/\.tiff?$/.test(n)) return "raster";
  if (/\.(geojson|json)$/.test(n)) return "vector";
  return "file";
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

/** "Roads 2024 (final).geojson" -> "roads-2024-final" (safe server file stem). */
export function safeStem(name) {
  return (name || "").replace(/\.[A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60) || "layer";
}

/**
 * Run one of GeoLibre's own raster tools on the sidecar (POST /sidecar/raster/run) and wait for it.
 * GeoLibre's web build locks its Raster tools dialog to the desktop app, but the sidecar runs them.
 */
export async function runRasterTool(fetchJson, { toolId, input, output, parameters = {} }, { pollMs = 1000, timeoutMs = 600000 } = {}) {
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
