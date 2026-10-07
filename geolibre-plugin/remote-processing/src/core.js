// Logic of the Remote Processing plugin that does not touch the page (tested with node --test).

export const VERSION = "0.1.0";
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
    const { server, code } = getConfig() || {};
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    const target = rewriteSidecarUrl(url, origin, server);
    if (!target) return originalFetch(input, init);
    const headers = new Headers(init?.headers || (typeof input === "object" && input?.headers) || undefined);
    if (code) headers.set("X-Access-Code", code);
    if (typeof input === "object" && !(input instanceof URL) && input) {
      return originalFetch(new Request(target, input), { ...init, headers });
    }
    return originalFetch(target, { ...init, headers });
  };
}

export function fileKind(name) {
  const n = (name || "").toLowerCase();
  if (/\.tiff?$/.test(n)) return "raster";
  if (/\.(geojson|json)$/.test(n)) return "vector";
  return "file";
}
