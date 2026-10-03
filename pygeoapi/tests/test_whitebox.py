import json
import os
import stat
import sys
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from processes import common, mcda, whitebox

FAKE = Path(__file__).parent / "fake_whitebox_tools.py"


@pytest.fixture(autouse=True)
def fake_wbt(tmp_path, monkeypatch):
    exe = tmp_path / "whitebox_tools"
    exe.write_text(f"#!/bin/sh\nexec {sys.executable} {FAKE} \"$@\"\n")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(whitebox, "WBT", str(exe))
    monkeypatch.setattr(common, "OUTPUT_DIR", str(tmp_path / "out"))
    whitebox.list_tools.cache_clear()
    whitebox.tool_parameters.cache_clear()
    yield


@pytest.fixture
def dem(tmp_path):
    p = tmp_path / "dem.tif"
    with rasterio.open(p, "w", driver="GTiff", width=100, height=100, count=1, dtype="float32",
                       crs="EPSG:4326", transform=from_origin(55.0, 25.1, 0.001, 0.001)) as dst:
        dst.write(np.arange(10000, dtype="float32").reshape(100, 100), 1)
    return str(p)


def test_list_and_search():
    assert whitebox.run_list({})["count"] == 3
    assert [t["tool"] for t in whitebox.run_list({"search": "slope"})["tools"]] == ["Slope"]


def test_parameters_are_classified():
    params = {p["name"]: p for p in whitebox.run_list({"tool": "slope"})["parameters"]}
    assert params["dem"]["kind"] == "in_raster" and params["output"]["kind"] == "out_raster"
    assert params["zfactor"]["kind"] == "number" and params["units"]["kind"] == "choice"
    vec = {p["name"]: p["kind"] for p in whitebox.tool_parameters("RasterToVectorPolygons")}
    assert vec == {"input": "in_raster", "output": "out_vector"}
    assert {p["name"]: p["kind"] for p in whitebox.tool_parameters("Clip")}["fill"] == "boolean"


def test_run_raster_tool_with_aoi_clip(dem, tmp_path):
    r = whitebox.run_whitebox({"tool": "Slope", "args": {"dem": dem, "zfactor": 2},
                               "aoi": [55.0, 25.05, 55.05, 25.1]})
    out = r["outputs"]["output"]
    assert out["type"] == "raster" and out["stats"]["min"] == 0
    with rasterio.open(os.path.join(common.OUTPUT_DIR, out["url"])) as src:
        assert (src.width, src.height) == (50, 50)  # clipped to the AOI
        assert src.read(1)[0, 0] == 0 and src.read(1)[0, 1] == 2  # fake tool doubled values
        assert src.block_shapes[0] != (1, src.width)  # tiled, written as COG


def test_run_vector_output_inline(dem):
    r = whitebox.run_whitebox({"tool": "RasterToVectorPolygons", "args": {"input": dem}})
    out = r["outputs"]["output"]
    assert out["type"] == "vector" and out["feature_count"] == 1
    assert out["geojson"]["features"][0]["geometry"]["type"] == "Polygon"


def test_boolean_is_a_bare_flag(tmp_path, dem):
    cmd, _ = whitebox.build_command("Clip", {"input": {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [55, 25]}}]},
        "fill": True}, str(tmp_path), None)
    assert "--fill" in cmd and not any(c.startswith("--fill=") for c in cmd)


@pytest.mark.parametrize("data, msg", [
    ({"tool": "rm -rf /"}, "letters and digits"),
    ({"tool": "NoSuchTool"}, "unknown"),
    ({"tool": "Slope", "args": {}}, "missing required parameter 'dem'"),
    ({"tool": "Slope", "args": {"dem": "x", "evil": 1}}, "no parameters"),
    ({"tool": "Slope", "args": {"dem": "/etc/passwd"}}, "local paths"),
])
def test_rejects_bad_input(data, msg):
    with pytest.raises(Exception, match=msg):
        whitebox.run_whitebox(data)


def test_input_size_limit(dem, monkeypatch):
    monkeypatch.setattr(whitebox, "MAX_INPUT_CELLS", 100)
    with pytest.raises(mcda.MCDAError, match="too large"):
        whitebox.run_whitebox({"tool": "Slope", "args": {"dem": dem}})


def test_missing_binary(monkeypatch):
    monkeypatch.setattr(whitebox, "WBT", "/nonexistent/whitebox_tools")
    whitebox.list_tools.cache_clear()
    with pytest.raises(mcda.MCDAError, match="not installed"):
        whitebox.run_list({})


def test_search_ranks_exact_name_first(monkeypatch):
    monkeypatch.setattr(whitebox, "list_tools", lambda: {
        "AverageFlowpathSlope": "Measures the average slope gradient.",
        "EdgeDensity": "Density of slope breaks.",
        "SlopeVsElevationPlot": "Plot of slope against elevation.",
        "Slope": "Calculates a slope raster from an input DEM.",
    })
    names = [t["tool"] for t in whitebox.run_list({"search": "slope"})["tools"]]
    assert names == ["Slope", "SlopeVsElevationPlot", "AverageFlowpathSlope", "EdgeDensity"]
