import json
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import LineString, Point, mapping

from processes import common
from processes.accessibility import run_accessibility
from processes.buffer_screen import run_buffer_screen
from processes.suitability import run_suitability

BBOX = [55.0, 25.0, 55.02, 25.02]


def fc(*geoms, **props):
    return {"type": "FeatureCollection",
            "features": [{"type": "Feature", "properties": props, "geometry": mapping(g)} for g in geoms]}


@pytest.fixture(autouse=True)
def outdir(tmp_path, monkeypatch):
    monkeypatch.setattr(common, "OUTPUT_DIR", str(tmp_path / "out"))


@pytest.fixture
def dem(tmp_path):
    """Elevation rising west to east: 0 m at 55.00, 400 m at 55.02 (steep east half)."""
    path = tmp_path / "dem.tif"
    x = np.linspace(0, 1, 80)
    z = np.where(x < 0.5, 0, (x - 0.5) * 800).astype("float32")
    with rasterio.open(path, "w", driver="GTiff", width=80, height=80, count=1, dtype="float32",
                       crs="EPSG:4326", transform=from_origin(55.0, 25.02, 0.00025, 0.00025)) as dst:
        dst.write(np.tile(z, (80, 1)), 1)
    return str(path)


@pytest.fixture
def landcover(tmp_path):
    """Class 10 (trees) in the north half, 40 (cropland) in the south half."""
    path = tmp_path / "lc.tif"
    arr = np.vstack([np.full((40, 80), 10), np.full((40, 80), 40)]).astype("uint8")
    with rasterio.open(path, "w", driver="GTiff", width=80, height=80, count=1, dtype="uint8",
                       crs="EPSG:4326", transform=from_origin(55.0, 25.02, 0.00025, 0.00025)) as dst:
        dst.write(arr, 1)
    return str(path)


def test_suitability_prefers_flat_land_near_road(dem, landcover):
    road = fc(LineString([(55.001, 25.0), (55.001, 25.02)]))
    out = run_suitability({
        "aoi": BBOX, "resolution": 50,
        "criteria": [
            {"name": "slope", "source": {"raster": dem, "derive": "slope"},
             "rule": {"type": "linear", "min": 0, "max": 10, "direction": "lower"}, "weight": 2},
            {"name": "road", "source": {"vector": road},
             "rule": {"type": "linear", "min": 0, "max": 2000, "direction": "lower"}, "weight": 1}],
        "constraints": [{"source": {"raster": landcover, "categorical": True}, "classes": [10]}],
        "threshold": 0.8, "top_n": 3})
    assert [c["weight"] for c in out["criteria"]] == pytest.approx([2 / 3, 1 / 3], abs=1e-3)
    assert 0.4 < out["excluded_share"] < 0.6  # the forest half is excluded
    best = out["sites"]["features"][0]
    minx, miny, maxx, maxy = __import__("shapely.geometry", fromlist=["shape"]).shape(best["geometry"]).bounds
    assert maxx < 55.011 and maxy < 25.0105  # flat west half, south of the forest
    with rasterio.open(out["suitability_raster"] if out["suitability_raster"].startswith("/")
                       else f"{common.OUTPUT_DIR}/{out['suitability_raster']}") as r:
        assert r.crs.is_projected


def test_suitability_ahp(dem):
    out = run_suitability({
        "aoi": BBOX, "resolution": 100,
        "criteria": [
            {"name": "slope", "source": {"raster": dem, "derive": "slope"},
             "rule": {"type": "linear", "min": 0, "max": 10, "direction": "lower"}},
            {"name": "elevation", "source": {"raster": dem},
             "rule": {"type": "linear", "min": 0, "max": 400}}],
        "ahp": [[1, 3], [1 / 3, 1]]})
    assert out["criteria"][0]["weight"] == pytest.approx(0.75, abs=1e-3)
    assert out["ahp_consistent"] is True


def test_accessibility_population(tmp_path):
    pop = tmp_path / "pop.tif"
    with rasterio.open(pop, "w", driver="GTiff", width=40, height=40, count=1, dtype="float32",
                       crs="EPSG:4326", transform=from_origin(55.0, 25.02, 0.0005, 0.0005)) as dst:
        dst.write(np.ones((40, 40), "float32"), 1)
    out = run_accessibility({"aoi": BBOX, "facilities": fc(Point(55.0, 25.0)), "population": str(pop),
                             "limit_m": 1000, "resolution": 100})
    p = out["population"]
    assert p["total"] == pytest.approx(1600, rel=0.1)
    assert 0 < p["share_within"] < 0.4
    assert out["area_beyond_share"] > 0.5


def test_buffer_screen_class_shares(landcover, dem):
    line = fc(LineString([(55.005, 25.002), (55.005, 25.018)]))
    out = run_buffer_screen({"features": line, "distance_m": 300, "layers": [
        {"name": "land cover", "raster": landcover, "categorical": True,
         "class_names": {"10": "Tree cover", "40": "Cropland"}},
        {"name": "elevation", "raster": dem, "stats": ["max"]}]})
    shares = {d["class"]: d["share"] for d in out["layers"][0]["class_shares"]}
    assert shares["Tree cover"] == pytest.approx(0.5, abs=0.05)
    assert out["layers"][1]["max"] == 0  # corridor lies in the flat west half
    assert out["area_ha"] > 100


def test_collection_source_mosaics_items(tmp_path, monkeypatch):
    """Two tiles side by side, served as one STAC collection, read as one layer."""
    from processes import mcda

    paths = []
    for i, (x0, val) in enumerate([(55.0, 1.0), (55.01, 2.0)]):
        p = tmp_path / f"tile{i}.tif"
        with rasterio.open(p, "w", driver="GTiff", width=40, height=80, count=1, dtype="float32",
                           crs="EPSG:4326", transform=from_origin(x0, 25.02, 0.00025, 0.00025)) as dst:
            dst.write(np.full((80, 40), val, "float32"), 1)
        paths.append(str(p))
    monkeypatch.setattr(common, "collection_hrefs", lambda source, grid: paths)
    grid = mcda.build_grid(common.load_aoi(BBOX), 100)
    vals = common.criterion_values({"collection": "dem", "catalog": "local"}, grid)
    assert vals.count() > 0.9 * vals.size
    assert vals[:, 0].mean() == pytest.approx(1.0) and vals[:, -1].mean() == pytest.approx(2.0)


def test_public_https_for_external_buckets():
    assert common.public_https("s3://copernicus-dem-30m/a/b.tif") == "https://copernicus-dem-30m.s3.amazonaws.com/a/b.tif"
    assert common.public_https("https://x/y.tif") == "https://x/y.tif"


def test_features_clip():
    from processes.features import run_features
    from shapely.geometry import Point
    src = fc(Point(55.005, 25.005), Point(56, 26))
    out = run_features({"source": json.dumps(src), "aoi": BBOX})
    assert len(out["features"]) == 1
