import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box
import geopandas as gpd

from processes.zonal_stats import ProcessorExecuteError, load_zones, zonal_stats


@pytest.fixture
def raster(tmp_path):
    # 10 x 10 pixels, 1 degree each, values 0..99 row-major, origin (0, 10).
    path = tmp_path / "r.tif"
    data = np.arange(100, dtype="float32").reshape(10, 10)
    with rasterio.open(path, "w", driver="GTiff", height=10, width=10, count=1, dtype="float32",
                       crs="EPSG:4326", transform=from_origin(0, 10, 1, 1)) as dst:
        dst.write(data, 1)
    return str(path)


def zones():
    return gpd.GeoDataFrame({"name": ["top_left", "whole"]},
                            geometry=[box(0, 8, 2, 10), box(0, 0, 10, 10)], crs="EPSG:4326")


def test_mean_min_max(raster):
    fc = zonal_stats(raster, zones(), ["mean", "min", "max"])
    tl, whole = (f["properties"] for f in fc["features"])
    assert tl["name"] == "top_left"
    assert (tl["min"], tl["max"], tl["mean"]) == (0, 11, pytest.approx(5.5))
    assert whole["mean"] == pytest.approx(49.5)


def test_reprojects_zones(raster):
    z = zones().to_crs("EPSG:3857")
    fc = zonal_stats(raster, z, ["mean"])
    assert fc["features"][1]["properties"]["mean"] == pytest.approx(49.5, rel=1e-3)


def test_rejects_unknown_stat(raster):
    with pytest.raises(ProcessorExecuteError):
        zonal_stats(raster, zones(), ["drop table"])


def test_inline_geojson():
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"id": 1}, "geometry": box(0, 0, 1, 1).__geo_interface__}]}
    assert len(load_zones(fc)) == 1


def test_empty_zones_rejected():
    with pytest.raises(ProcessorExecuteError):
        load_zones({"type": "FeatureCollection", "features": []})


def test_paths_outside_data_roots_rejected():
    with pytest.raises(ProcessorExecuteError):
        load_zones("/etc/passwd")
    with pytest.raises(ProcessorExecuteError):
        from processes.zonal_stats import resolve_raster
        resolve_raster("/etc/../etc/shadow")
