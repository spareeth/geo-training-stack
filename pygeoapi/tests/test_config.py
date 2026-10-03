import importlib
import os
from pathlib import Path

import yaml

CONFIG = Path(__file__).parents[1] / "pygeoapi-config.yml"


def test_config_parses_and_processors_import(monkeypatch):
    monkeypatch.setenv("DOMAIN", "geo.example.org")
    monkeypatch.setenv("ACME_EMAIL", "admin@example.org")
    # pygeoapi parses the YAML before substituting ${VARS}, so the raw file must parse too.
    yaml.safe_load(CONFIG.read_text())
    cfg = yaml.safe_load(os.path.expandvars(CONFIG.read_text()))
    assert cfg["server"]["url"] == "https://geo.example.org/processes-api"
    for name, res in cfg["resources"].items():
        module, cls = res["processor"]["name"].rsplit(".", 1)
        # The image installs processes/ as training_processes; tests import it as processes.
        mod = importlib.import_module(module.replace("training_processes", "processes", 1))
        assert hasattr(mod, cls), name
