import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";

test("normalizeServer adds https and drops trailing slashes", () => {
  assert.equal(core.normalizeServer(" sidecar.example.org/ "), "https://sidecar.example.org");
  assert.equal(core.normalizeServer("http://localhost:8443"), "http://localhost:8443");
  assert.equal(core.normalizeServer(""), "");
});

test("rewriteSidecarUrl only moves sidecar requests", () => {
  const o = "https://web.geolibre.app", s = "https://sc.example.org";
  assert.equal(core.rewriteSidecarUrl(`${o}/sidecar/whitebox/run`, o, s), `${s}/sidecar/whitebox/run`);
  assert.equal(core.rewriteSidecarUrl(`${o}/sidecar/health?x=1`, o, s), `${s}/sidecar/health?x=1`);
  assert.equal(core.rewriteSidecarUrl("/sidecar/raster/status", o, s), `${s}/sidecar/raster/status`);
  assert.equal(core.rewriteSidecarUrl(`${o}/sidecarx/a`, o, s), null);
  assert.equal(core.rewriteSidecarUrl(`${o}/assets/app.js`, o, s), null);
  assert.equal(core.rewriteSidecarUrl(`${o}/sidecar/health`, o, ""), null);
});

test("withCode appends the access code", () => {
  assert.equal(core.withCode("https://s/data/a.tif", "a b"), "https://s/data/a.tif?code=a%20b");
  assert.equal(core.withCode("https://s/x?y=1", "c"), "https://s/x?y=1&code=c");
});

test("makeFetch rewrites sidecar calls, adds the code, passes others through", async () => {
  const calls = [];
  const orig = async (input, init) => { calls.push([typeof input === "string" ? input : input.url, init?.headers?.get?.("X-Access-Code") ?? null]); return "ok"; };
  const f = core.makeFetch(orig, () => ({ server: "https://sc", code: "k" }), "https://web.geolibre.app");
  await f("https://web.geolibre.app/sidecar/whitebox/run", { method: "POST", headers: { "Content-Type": "application/json" } });
  await f("https://tiles.example/x.png");
  assert.deepEqual(calls, [["https://sc/sidecar/whitebox/run", "k"], ["https://tiles.example/x.png", null]]);
});

test("fileKind", () => {
  assert.equal(core.fileKind("dem.TIF"), "raster");
  assert.equal(core.fileKind("roads.geojson"), "vector");
  assert.equal(core.fileKind("report.html"), "file");
});
