import assert from "node:assert/strict";
import { test } from "node:test";

import * as core from "../src/core.js";

test("publicHttps converts s3 to a public bucket URL", () => {
  assert.equal(core.publicHttps("s3://copernicus-dem-30m/a/b.tif"), "https://copernicus-dem-30m.s3.amazonaws.com/a/b.tif");
  assert.equal(core.publicHttps("https://x/y.tif"), "https://x/y.tif");
});

test("outputPath maps result URLs to the TiTiler-readable path", () => {
  assert.equal(core.outputPath("https://geo.example.org/outputs/slope-1.tif"), "/outputs/slope-1.tif");
  assert.equal(core.outputPath("slope-1.tif"), "/outputs/slope-1.tif");
});

test("assetKind recognises rasters and vectors, skips thumbnails", () => {
  assert.equal(core.assetKind({ href: "s3://b/x.tif", type: "image/tiff; application=geotiff; profile=cloud-optimized" }), "raster");
  assert.equal(core.assetKind({ href: "s3://b/x.parquet", type: "application/vnd.apache.parquet" }), "vector");
  assert.equal(core.assetKind({ href: "x.png", type: "image/png", roles: ["thumbnail"] }), null);
});

test("assetRefs: local uses catalogue refs, external uses https", () => {
  const a = { href: "s3://stac/dem/x.tif" };
  assert.deepEqual(core.assetRefs("local", "dem", "x", "data", a), { ref: "dem/x/data", tileHref: "s3://stac/dem/x.tif" });
  assert.equal(core.assetRefs("earth-search", "c", "i", "data", { href: "s3://b/k.tif" }).ref, "https://b.s3.amazonaws.com/k.tif");
});

test("tileTemplate encodes url and options", () => {
  const t = core.tileTemplate("/outputs/a b.tif", { rescale: [0, 1], colormap: "rdylgn" });
  assert.ok(t.startsWith("/tiles/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?"));
  assert.ok(t.includes("url=%2Foutputs%2Fa+b.tif") && t.includes("rescale=0%2C1") && t.includes("colormap_name=rdylgn"));
});

test("rescaleFromStats prefers percentiles and never returns a flat range", () => {
  assert.deepEqual(core.rescaleFromStats({ b1: { min: 0, max: 100, percentile_2: 5, percentile_98: 90 } }), [5, 90]);
  assert.deepEqual(core.rescaleFromStats({ b1: { min: 3, max: 3 } }), [3, 4]);
  assert.equal(core.rescaleFromStats(null), null);
});

const PARAMS = [
  { name: "dem", label: "Input DEM", kind: "in_raster", optional: false, default: null },
  { name: "output", label: "Output", kind: "out_raster", optional: false, default: null },
  { name: "zfactor", label: "Z factor", kind: "number", optional: true, default: "1.0" },
  { name: "units", label: "Units", kind: "choice", data: ["degrees", "percent"], optional: true, default: "degrees" },
  { name: "fill", label: "Fill", kind: "boolean", optional: true, default: "false" },
];

test("wbtFields hides outputs and keeps choices", () => {
  const f = core.wbtFields(PARAMS);
  assert.deepEqual(f.map((x) => x.name), ["dem", "zfactor", "units", "fill"]);
  assert.deepEqual(f[2].options, ["degrees", "percent"]);
});

test("wbtArgs converts types, drops blanks and false flags, checks required", () => {
  const f = core.wbtFields(PARAMS);
  assert.deepEqual(core.wbtArgs(f, { dem: "dem/x/data", zfactor: "2", units: "", fill: false }), { dem: "dem/x/data", zfactor: 2 });
  assert.deepEqual(core.wbtArgs(f, { dem: "a", fill: true }), { dem: "a", fill: true });
  assert.throws(() => core.wbtArgs(f, {}), /Input DEM/);
  assert.throws(() => core.wbtArgs(f, { dem: "a", zfactor: "abc" }), /number/);
});

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push([url, opts]);
    const r = routes.shift();
    return { status: r.status ?? 200, ok: (r.status ?? 200) < 400, headers: new Map(Object.entries(r.headers || {})), json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

test("executeProcess polls an async job to completion", async () => {
  const f = fakeFetch([
    { status: 201, headers: { Location: "/processes-api/jobs/abc" } },
    { body: { status: "running", progress: 50 } },
    { body: { status: "successful" } },
    { body: { tool: "Slope", outputs: {} } },
  ]);
  const seen = [];
  const r = await core.executeProcess(f, "whitebox", { tool: "Slope" }, { pollMs: 1, onStatus: (s) => seen.push(s) });
  assert.equal(r.tool, "Slope");
  assert.deepEqual(seen, ["running", "successful"]);
  assert.equal(f.calls[0][1].headers.Prefer, "respond-async");
  assert.equal(f.calls[3][0], "/processes-api/jobs/abc/results?f=json");
});

test("executeProcess returns sync results and surfaces server errors", async () => {
  const f = fakeFetch([{ body: { a: 1 } }]);
  assert.deepEqual(await core.executeProcess(f, "x", {}, { async: false }), { a: 1 });
  assert.equal(f.calls[0][1].headers.Prefer, undefined);
  await assert.rejects(core.executeProcess(fakeFetch([{ status: 400, body: { description: "missing dem" } }]), "x", {}), /missing dem/);
  await assert.rejects(core.executeProcess(fakeFetch([
    { status: 201, headers: { Location: "/j/1" } }, { body: { status: "failed", message: "too large" } }]), "x", {}, { pollMs: 1 }), /too large/);
});

test("resultLayers for each process", () => {
  const wb = core.resultLayers("whitebox", { outputs: { output: { type: "raster", url: "https://h/outputs/s.tif", stats: { min: 0, max: 40 } },
    poly: { type: "vector", geojson: { type: "FeatureCollection", features: [] } }, report: { type: "text", content: "x" } } }, "Slope");
  assert.deepEqual(wb.map((l) => [l.type, l.name]), [["raster", "Slope output"], ["vector", "Slope poly"]]);
  assert.deepEqual(wb[0].rescale, [0, 40]);
  const su = core.resultLayers("suitability", { suitability_raster: "s.tif", sites: { features: [{}] } });
  assert.deepEqual(su.map((l) => l.type), ["raster", "vector"]);
  assert.deepEqual(su[0].rescale, [0, 1]);
  const ac = core.resultLayers("accessibility", { distance_raster: "d.tif", max_distance_m: 900,
    facilities: { type: "FeatureCollection", features: [{}] } }, "Accessibility");
  assert.deepEqual(ac.map((l) => [l.type, l.name]), [["raster", "Accessibility distance (m)"], ["vector", "Accessibility facilities"]]);
  assert.equal(core.resultLayers("buffer-screen", { buffer: { type: "Polygon", coordinates: [] } })[0].type, "vector");
});

test("bboxFeature is a closed polygon", () => {
  const ring = core.bboxFeature([1, 2, 3, 4]).features[0].geometry.coordinates[0];
  assert.deepEqual(ring[0], ring[4]);
});
