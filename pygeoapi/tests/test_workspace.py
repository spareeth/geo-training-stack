import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from processes import workspace


@pytest.fixture
def ws(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace, "WORKSPACE", str(tmp_path / "ws"))
    return tmp_path / "ws"


def _dem(path):
    with rasterio.open(path, "w", driver="GTiff", width=100, height=100, count=1, dtype="float32",
                       crs="EPSG:4326", transform=from_origin(55.0, 25.1, 0.001, 0.001)) as d:
        d.write(np.arange(10000, dtype="float32").reshape(100, 100), 1)


def test_prepare_clips_to_area_as_cog(ws, tmp_path, monkeypatch):
    src = tmp_path / "dem.tif"
    _dem(src)
    monkeypatch.setattr(workspace, "resolve_raster", lambda ref: str(src))
    out = workspace.prepare({"raster": "dem/x/data", "aoi": [55.02, 25.05, 55.05, 25.08], "name": "My DEM!"})
    assert out["name"] == "my-dem.tif" and out["geolibre_path"] == "/data/my-dem.tif"
    with rasterio.open(ws / "my-dem.tif") as d:
        assert d.width == 30 and d.height == 30
        assert d.profile.get("tiled") and d.overviews(1) is not None
    listed = workspace.list_files()["files"]
    assert [f["name"] for f in listed] == ["my-dem.tif"] and listed[0]["kind"] == "raster"


def test_prepare_outside_raster_and_too_large(ws, tmp_path, monkeypatch):
    src = tmp_path / "dem.tif"
    _dem(src)
    monkeypatch.setattr(workspace, "resolve_raster", lambda ref: str(src))
    from pygeoapi.process.base import ProcessorExecuteError
    with pytest.raises(ProcessorExecuteError, match="does not cover"):
        workspace.prepare({"raster": "x/y", "aoi": [10, 10, 11, 11]})
    monkeypatch.setattr(workspace, "MAX_PIXELS", 10)
    with pytest.raises(ProcessorExecuteError, match="too large"):
        workspace.prepare({"raster": "x/y", "aoi": [55.0, 25.0, 55.1, 25.1]})


def test_safe_name():
    assert workspace.safe_name("../etc/passwd") == "etc-passwd"
    assert workspace.safe_name("").startswith("raster-")
