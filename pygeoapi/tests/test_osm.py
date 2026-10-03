import pytest

from processes import mcda, osm


def test_query_has_all_filters_and_bbox_order():
    q = osm.overpass_query("health", [55.0, 25.0, 55.1, 25.1])
    assert q.count("(25.0,55.0,25.1,55.1)") == 2  # south, west, north, east
    assert "out geom" in q


def test_elements_to_gdf():
    els = [
        {"type": "node", "id": 1, "lat": 25.0, "lon": 55.0, "tags": {"name": "Clinic A"}},
        {"type": "way", "id": 2, "geometry": [{"lat": 25.0, "lon": 55.0}, {"lat": 25.1, "lon": 55.1}]},
        {"type": "way", "id": 3, "geometry": [{"lat": 25.0, "lon": 55.0}]},  # degenerate, dropped
    ]
    gdf = osm.elements_to_gdf(els)
    assert list(gdf.geom_type) == ["Point", "LineString"]
    assert gdf.iloc[0]["name"] == "Clinic A"


def test_fetch_uses_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(osm, "CACHE_DIR", str(tmp_path))
    calls = []

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"elements": [{"type": "node", "id": 1, "lat": 25.0, "lon": 55.0}]}

    monkeypatch.setattr(osm.requests, "post", lambda *a, **k: calls.append(1) or Resp())
    assert len(osm.fetch_osm("schools", [55, 25, 55.1, 25.1])) == 1
    assert len(osm.fetch_osm("schools", [55, 25, 55.1, 25.1])) == 1
    assert len(calls) == 1


def test_unknown_layer():
    with pytest.raises(mcda.MCDAError):
        osm.fetch_osm("unicorns", [0, 0, 1, 1])


def test_falls_back_to_mirror(tmp_path, monkeypatch):
    monkeypatch.setattr(osm, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(osm, "OVERPASS_URLS", ["https://a", "https://b"])

    class Resp:
        def __init__(self, ok):
            self.ok = ok

        def raise_for_status(self):
            if not self.ok:
                raise osm.requests.HTTPError("504")

        def json(self):
            return {"elements": [{"type": "node", "id": 1, "lat": 25.0, "lon": 55.0}]}

    monkeypatch.setattr(osm.requests, "post", lambda url, **k: Resp(url == "https://b"))
    assert len(osm.fetch_osm("roads", [55, 25, 55.1, 25.1])) == 1


def test_all_mirrors_down(tmp_path, monkeypatch):
    monkeypatch.setattr(osm, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(osm, "OVERPASS_URLS", ["https://a"])

    def boom(*a, **k):
        raise osm.requests.ConnectionError("down")

    monkeypatch.setattr(osm.requests, "post", boom)
    with pytest.raises(mcda.MCDAError, match="could not fetch OSM"):
        osm.fetch_osm("roads", [55, 25, 55.1, 25.1])
