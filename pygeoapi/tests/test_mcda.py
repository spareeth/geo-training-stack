import geopandas as gpd
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import LineString, Point, box

from processes import mcda


def aoi(minx=55.0, miny=25.0, size=0.02):
    return gpd.GeoDataFrame(geometry=[box(minx, miny, minx + size, miny + size)], crs="EPSG:4326")


# --- scoring rules ---------------------------------------------------------------------------

def test_linear_higher_and_lower():
    v = np.array([0, 5, 10, 20])
    assert mcda.score(v, {"type": "linear", "min": 0, "max": 10}).tolist() == [0, 0.5, 1, 1]
    assert mcda.score(v, {"type": "linear", "min": 0, "max": 10, "direction": "lower"}).tolist() == [1, 0.5, 0, 0]


def test_thresholds():
    v = np.array([1, 5, 10, 30])
    rule = {"type": "thresholds", "breaks": [5, 15], "scores": [1, 0.5, 0]}
    assert mcda.score(v, rule).tolist() == [1, 0.5, 0.5, 0]


def test_classes_with_default():
    v = np.array([10, 40, 80])
    assert mcda.score(v, {"type": "classes", "map": {"10": 0.2, "40": 1}}).tolist() == [0.2, 1, 0]


@pytest.mark.parametrize("rule", [
    {"type": "linear", "min": 5, "max": 5},
    {"type": "thresholds", "breaks": [1], "scores": [1]},
    {"type": "nope"},
])
def test_bad_rules(rule):
    with pytest.raises(mcda.MCDAError):
        mcda.score(np.array([1.0]), rule)


# --- AHP -------------------------------------------------------------------------------------

def test_ahp_saaty_example():
    # Classic 3 x 3 example: weights about 0.648, 0.230, 0.122; CR about 0.004.
    m = [[1, 3, 5], [1 / 3, 1, 2], [1 / 5, 1 / 2, 1]]
    w, cr = mcda.ahp_weights(m)
    assert w == pytest.approx([0.648, 0.230, 0.122], abs=0.005)
    assert cr < 0.01


def test_ahp_inconsistent_flagged():
    m = [[1, 9, 1 / 9], [1 / 9, 1, 9], [9, 1 / 9, 1]]
    _, cr = mcda.ahp_weights(m)
    assert cr > 0.10


def test_ahp_rejects_non_reciprocal():
    with pytest.raises(mcda.MCDAError):
        mcda.ahp_weights([[1, 3], [3, 1]])


# --- overlay and sites -----------------------------------------------------------------------

def test_weighted_overlay_and_exclusion():
    a, b = np.full((2, 2), 1.0), np.zeros((2, 2))
    excl = np.array([[True, False], [False, False]])
    out = mcda.weighted_overlay([a, b], [3, 1], excl)
    assert out.mask[0, 0] and out[1, 1] == pytest.approx(0.75)


def test_overlay_masks_nodata():
    a = np.ma.array(np.ones((1, 2)), mask=[[True, False]])
    out = mcda.weighted_overlay([a, np.ones((1, 2))], [1, 1])
    assert out.mask.tolist() == [[True, False]]


def test_grid_is_metric_and_bounded():
    g = mcda.build_grid(aoi(), 100)
    assert g.crs.is_projected and g.resolution == 100
    assert 18 <= g.width <= 25 and 20 <= g.height <= 25
    with pytest.raises(mcda.MCDAError):
        mcda.build_grid(aoi(size=5), 1)


def test_distance_to_point_in_metres():
    g = mcda.build_grid(aoi(), 50)
    centre = gpd.GeoDataFrame(geometry=[Point(55.01, 25.01)], crs="EPSG:4326")
    d = mcda.distance_to_features(centre, g)
    assert d.min() == 0
    # Corner is about sqrt(1000^2 + 1100^2) m away.
    assert 1300 < d.max() < 1700


def test_top_sites_ranked():
    g = mcda.build_grid(aoi(), 100)
    suit = np.ma.zeros(g.shape)
    suit[1:4, 1:4] = 0.9    # 9 cells, best
    suit[10:16, 10:16] = 0.8  # 36 cells, larger but lower score
    sites = mcda.top_sites(suit, g, 0.7)
    assert list(sites["rank"]) == [1, 2]
    assert sites.iloc[0]["mean_score"] == pytest.approx(0.9)
    assert sites.iloc[1]["area_ha"] == pytest.approx(36.0)
    assert len(mcda.top_sites(suit, g, 0.7, min_area_m2=200_000)) == 1


def test_population_beyond():
    pop = np.ma.array([[10.0, 20.0], [30.0, -9999]], mask=[[False, False], [False, True]])
    dist = np.array([[0.0, 6000], [1000, 0]])
    r = mcda.population_beyond(pop, dist, 5000)
    assert (r["total"], r["within"], r["beyond"]) == (60, 40, 20)


def test_read_to_grid_and_sum_resampling(tmp_path):
    g = mcda.build_grid(aoi(), 200)
    path = tmp_path / "pop.tif"
    # Fine 0.0005 deg raster of ones over the AOI.
    with rasterio.open(path, "w", driver="GTiff", width=40, height=40, count=1, dtype="float32",
                       crs="EPSG:4326", transform=from_origin(55.0, 25.02, 0.0005, 0.0005)) as dst:
        dst.write(np.ones((40, 40), "float32"), 1)
    total = mcda.read_to_grid(str(path), g, counts=True).sum()
    assert total == pytest.approx(1600, rel=0.1)
