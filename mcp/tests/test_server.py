import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
sys.path[:0] = [str(ROOT / "pygeoapi"), str(ROOT / "mcp")]

import server  # noqa: E402


@pytest.fixture(autouse=True)
def presets_dir(monkeypatch):
    monkeypatch.setattr(server, "PRESETS_DIR", ROOT / "presets")


def test_list_presets_filters_by_sector():
    assert len(server.list_presets()) == 6
    health = server.list_presets("health")
    assert [p["id"] for p in health] == ["health-catchment-gaps"]


def test_ahp_tool():
    r = server.compute_ahp_weights(["a", "b"], [[1, 3], [1 / 3, 1]])
    assert r["weights"] == {"a": 0.75, "b": 0.25} and r["consistent"]
    assert "error" in server.compute_ahp_weights(["a"], [[1, 3], [1 / 3, 1]])


def test_run_preset_applies_aoi_and_weight_overrides(monkeypatch):
    sent = {}
    monkeypatch.setattr(server, "execute", lambda proc, inputs: sent.update(proc=proc, inputs=inputs) or {"ok": 1})
    r = server.run_preset("agriculture-irrigation", [1, 2, 3, 4],
                          {"threshold": 0.9, "weights": {"Flat land": 7}})
    assert sent["proc"] == "suitability" and sent["inputs"]["aoi"] == [1, 2, 3, 4]
    assert sent["inputs"]["threshold"] == 0.9
    assert {c["name"]: c["weight"] for c in sent["inputs"]["criteria"]}["Flat land"] == 7
    # The preset file itself is untouched.
    assert server.get_preset("agriculture-irrigation")["inputs"]["criteria"][0]["weight"] == 3
    assert r["result"] == {"ok": 1}


def test_run_preset_roads_uses_features_and_follow_up(monkeypatch):
    sent = []
    monkeypatch.setattr(server, "execute", lambda proc, inputs: sent.append((proc, inputs)) or {})
    server.run_preset("roads-corridor-screening", {"type": "FeatureCollection", "features": []})
    server.run_preset("health-catchment-gaps", [0, 0, 1, 1], follow_up=True)
    assert "features" in sent[0][1] and sent[1][0] == "suitability"


def test_run_preset_errors():
    assert "error" in server.run_preset("nope", [0, 0, 1, 1])
    assert "error" in server.run_preset("nbs-restoration", [0, 0, 1, 1], follow_up=True)
    assert "error" in server.run_preset("nbs-restoration", [0, 0, 1, 1], {"weights": {"Unknown": 1}})
