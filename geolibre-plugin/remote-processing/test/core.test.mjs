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

test("makeFetch asks for UTM on Whitebox runs unless metres is off", async () => {
  const seen = [];
  const orig = async (u, init) => { seen.push([u, init.headers.get("X-Auto-Project")]); };
  const o = "https://web.geolibre.app";
  await core.makeFetch(orig, () => ({ server: "https://sc", code: "k" }), o)(`${o}/sidecar/whitebox/run`, {});
  await core.makeFetch(orig, () => ({ server: "https://sc", code: "k" }), o)(`${o}/sidecar/whitebox/status`, {});
  await core.makeFetch(orig, () => ({ server: "https://sc", code: "k", metres: false }), o)(`${o}/sidecar/whitebox/run`, {});
  assert.deepEqual(seen.map((s) => s[1]), ["utm", null, null]);
});

test("participant ids are random, lower-case and valid", () => {
  const a = core.newParticipantId(), b = core.newParticipantId();
  assert.ok(core.isParticipantId(a) && core.isParticipantId(b) && a !== b);
  assert.equal(core.newParticipantId((n) => new Uint8Array(n)), "u-aaaaaaaaaa");
  assert.ok(!core.isParticipantId("u-AB") && !core.isParticipantId("../x") && !core.isParticipantId("u-a"));
});

test("fileKind", () => {
  assert.equal(core.fileKind("dem.TIF"), "raster");
  assert.equal(core.fileKind("roads.geojson"), "vector");
  assert.equal(core.fileKind("report.html"), "file");
});

test("featuresToCsv numbers zones and escapes", () => {
  const csv = core.featuresToCsv({ features: [{ properties: { name: "A, b", dem_mean: 1.5 } }, { properties: { name: "C" } }] });
  assert.equal(csv, 'zone,name,dem_mean\n1,"A, b",1.5\n2,C,\n');
});

test("safeStem", () => {
  assert.equal(core.safeStem("Roads 2024 (final).geojson"), "roads-2024-final");
  assert.equal(core.safeStem(""), "layer");
});

test("runRasterTool posts the request and polls the job until it ends", async () => {
  const calls = [];
  const replies = [{ id: "j1", status: "running" }, { id: "j1", status: "running" }, { id: "j1", status: "succeeded", outputs: { vector: { path: "/data/o.geojson" } } }];
  const fetchJson = async (path, init) => { calls.push([path, init?.body ? JSON.parse(init.body) : null]); return replies.shift(); };
  const job = await core.runRasterTool(fetchJson, { toolId: "zonal", input: "/data/d.tif", output: "/data/o.geojson", parameters: { zones_path: "/data/z.geojson" } }, { pollMs: 1 });
  assert.equal(job.outputs.vector.path, "/data/o.geojson");
  assert.deepEqual(calls[0], ["/sidecar/raster/run", { tool_id: "zonal", input_path: "/data/d.tif", output_path: "/data/o.geojson", parameters: { zones_path: "/data/z.geojson" } }]);
  assert.equal(calls.length, 3);
  await assert.rejects(core.runRasterTool(async () => ({ id: "x", status: "failed", error: "bad zones" }), { toolId: "zonal", input: "a", output: "b" }), /bad zones/);
});
