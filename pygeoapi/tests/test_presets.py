"""Every sector preset must be well formed: known process, valid rules, sources and weights."""
import json
from pathlib import Path

import numpy as np
import pytest

from processes import mcda, osm

PRESETS = sorted((Path(__file__).parents[2] / "presets").glob("*.json"))
PROCESSES = {"suitability", "accessibility", "buffer-screen"}


def check_source(src):
    keys = {"raster", "collection", "vector", "osm"} & set(src)
    assert len(keys) == 1, src
    if "osm" in src:
        assert src["osm"] in osm.LAYERS
    if "collection" in src:
        assert src.get("catalog") in {"local", "earth-search", "planetary-computer"}


def check_suitability(inputs):
    assert inputs["criteria"]
    for c in inputs["criteria"]:
        check_source(c["source"])
        mcda.score(np.array([0.0, 10.0, 1000.0]), c["rule"])
        assert c["weight"] > 0
    for con in inputs.get("constraints", []):
        if "source" in con:
            check_source(con["source"])
            assert "classes" in con or con.get("op") in {">", ">=", "<", "<=", "=="}
        else:
            check_source(con)


def check(process, inputs):
    assert process in PROCESSES
    if process == "suitability":
        check_suitability(inputs)
    elif process == "accessibility":
        check_source(inputs["facilities"])
        check_source(inputs["population"])
    else:
        for layer in inputs["layers"]:
            check_source(layer)


def test_six_sectors_present():
    assert len(PRESETS) == 6


@pytest.mark.parametrize("path", PRESETS, ids=lambda p: p.stem)
def test_preset_valid(path):
    p = json.loads(path.read_text())
    assert p["id"] == path.stem and p["title"] and p["question"] and p["sector"]
    assert "aoi" not in p["inputs"], "AOI is chosen by the user at run time"
    check(p["process"], p["inputs"])
    if "follow_up" in p:
        check(p["follow_up"]["process"], p["follow_up"]["inputs"])
