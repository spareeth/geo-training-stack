import pytest

from processes import zonal_stats


@pytest.fixture(autouse=True)
def allow_tmp_paths(tmp_path, monkeypatch):
    monkeypatch.setattr(zonal_stats, "DATA_ROOTS", [str(tmp_path)])
