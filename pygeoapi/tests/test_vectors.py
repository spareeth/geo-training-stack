import zipfile

import geopandas as gpd
import pytest
from shapely.geometry import Point

from processes import zonal_stats
from processes.zonal_stats import is_catalogue_ref, read_vector, vector_path


def test_vector_paths():
    assert vector_path("https://h/x.zip#roads.gpkg")[0] == "/vsizip//vsicurl/https://h/x.zip/roads.gpkg"
    assert vector_path("/data/a.zip")[0] == "/vsizip//data/a.zip"
    assert vector_path("https://h/b.geojson")[0] == "/vsicurl/https://h/b.geojson"
    path, opts = vector_path("https://h/rwi.csv")
    assert path == "/vsicurl/https://h/rwi.csv" and "latitude" in opts["Y_POSSIBLE_NAMES"]


def test_catalogue_refs():
    assert is_catalogue_ref("osm-roads/SEN") and is_catalogue_ref("osm-roads/SEN/lines")
    assert not is_catalogue_ref("/data/x.gpkg") and not is_catalogue_ref("https://h/a/b")
    assert not is_catalogue_ref("one")


def test_gpkg_in_zip_with_bbox(tmp_path):
    gdf = gpd.GeoDataFrame({"name": ["a", "b", "c"]},
                           geometry=[Point(10, 10), Point(10.5, 10.5), Point(20, 20)], crs=4326)
    gdf.to_file(tmp_path / "pts.gpkg")
    z = tmp_path / "pts_gpkg.zip"
    with zipfile.ZipFile(z, "w") as f:
        f.write(tmp_path / "pts.gpkg", "pts.gpkg")
    assert len(read_vector(f"{z}#pts.gpkg")) == 3
    got = read_vector(f"{z}#pts.gpkg", bbox=(9, 9, 11, 11))
    assert sorted(got["name"]) == ["a", "b"]


def test_csv_points(tmp_path):
    p = tmp_path / "rwi.csv"
    p.write_text("latitude,longitude,rwi\n14.7,-17.4,0.5\n12.5,-16.2,-0.3\n")
    got = read_vector(str(p), bbox=(-18, 14, -17, 15))
    assert list(got["rwi"]) == [0.5] and got.crs.to_epsg() == 4326


def test_catalogue_ref_reads_asset(monkeypatch, tmp_path):
    gpd.GeoDataFrame({"n": [1]}, geometry=[Point(1, 1)], crs=4326).to_file(tmp_path / "a.gpkg")
    monkeypatch.setattr(zonal_stats, "catalogue_href", lambda ref: str(tmp_path / "a.gpkg"))
    assert len(zonal_stats.load_zones("osm-roads/SEN")) == 1


def test_remote_vector_uses_local_copy(monkeypatch, tmp_path):
    gpd.GeoDataFrame({"n": [1, 2]}, geometry=[Point(1, 1), Point(5, 5)], crs=4326).to_file(tmp_path / "r.gpkg")
    calls = []

    def fake_copy(url, member=None):
        calls.append((url, member))
        return str(tmp_path / "r.gpkg")
    monkeypatch.setattr("processes.vector_cache.local_copy", fake_copy)
    got = read_vector("https://h/x_gpkg.zip#r.gpkg", bbox=(0, 0, 2, 2))
    assert calls == [("https://h/x_gpkg.zip", "r.gpkg")] and len(got) == 1


def test_local_copy_unzips_member(monkeypatch, tmp_path):
    from processes import vector_cache

    src = tmp_path / "a.gpkg"
    src.write_bytes(b"gpkg-bytes")
    z = tmp_path / "a_gpkg.zip"
    with zipfile.ZipFile(z, "w") as f:
        f.write(src, "a.gpkg")
        f.writestr("README.txt", "x")

    class Resp:
        def __init__(self):
            self.raw = open(z, "rb")
        def raise_for_status(self):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *a):
            self.raw.close()
    n = []
    monkeypatch.setattr(vector_cache, "CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(vector_cache.requests, "get", lambda *a, **k: n.append(1) or Resp())
    p = vector_cache.local_copy("https://h/a_gpkg.zip", "a.gpkg")
    assert open(p, "rb").read() == b"gpkg-bytes"
    assert vector_cache.local_copy("https://h/a_gpkg.zip", "a.gpkg") == p and len(n) == 1  # cached
