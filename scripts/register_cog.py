"""Convert a raster to COG, store it in the course catalogue and register it as a STAC item.

Run inside the pygeoapi image (it has GDAL, rasterio and pystac), from the repo root:

  docker compose run --rm -v "$PWD/data:/data-rw" -v "$PWD/scripts:/scripts:ro" \\
    --entrypoint /venv/bin/python pygeoapi /scripts/register_cog.py \\
    /data-rw/incoming/dem.tif --collection dem --item dem-30m --title "Elevation 30 m"

The COG goes to data/catalog/<collection>/<item>.tif, which TiTiler and the processing server
read as /data/catalog/... The collection is created on first use.
"""
import argparse
import datetime as dt
import os

import pystac
import rasterio
import rasterio.shutil
import requests
from rasterio.warp import transform_bounds
from shapely.geometry import box, mapping

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("--collection", required=True)
ap.add_argument("--item", required=True)
ap.add_argument("--title", help="collection title (used when the collection is created)")
ap.add_argument("--description", default="Course dataset")
ap.add_argument("--datetime", help="ISO date of the data, default now")
ap.add_argument("--data-rw", default=os.environ.get("DATA_RW", "/data-rw"), help="writable mount of ./data")
ap.add_argument("--api", default=os.environ.get("STAC_API_URL", "http://stac-api:8080/stac"))
a = ap.parse_args()

rel = f"catalog/{a.collection}/{a.item}.tif"
dst = os.path.join(a.data_rw, rel)
os.makedirs(os.path.dirname(dst), exist_ok=True)
rasterio.shutil.copy(a.src, dst, driver="COG", compress="DEFLATE")

with rasterio.open(dst) as src:
    bbox = list(transform_bounds(src.crs, "EPSG:4326", *src.bounds, densify_pts=21))
    proj = {"proj:epsg": src.crs.to_epsg(), "proj:shape": [src.height, src.width],
            "proj:transform": list(src.transform)[:6]}
    bands = [{"data_type": d, **({"nodata": src.nodata} if src.nodata is not None else {})} for d in src.dtypes]

when = dt.datetime.fromisoformat(a.datetime) if a.datetime else dt.datetime.now(dt.timezone.utc)
if when.tzinfo is None:
    when = when.replace(tzinfo=dt.timezone.utc)
item = pystac.Item(id=a.item, geometry=mapping(box(*bbox)), bbox=bbox, datetime=when,
                   properties=proj, collection=a.collection)
item.add_asset("data", pystac.Asset(href=f"/data/{rel}", media_type=pystac.MediaType.COG,
                                    roles=["data"], extra_fields={"raster:bands": bands}))

api = a.api.rstrip("/")
if requests.get(f"{api}/collections/{a.collection}", timeout=30).status_code == 404:
    coll = pystac.Collection(id=a.collection, title=a.title or a.collection, description=a.description,
                             extent=pystac.Extent(pystac.SpatialExtent([bbox]),
                                                  pystac.TemporalExtent([[when, None]])),
                             license="other")
    requests.post(f"{api}/collections", json=coll.to_dict(include_self_link=False), timeout=30).raise_for_status()

body = item.to_dict(include_self_link=False)
r = requests.post(f"{api}/collections/{a.collection}/items", json=body, timeout=30)
if r.status_code == 409:  # already registered: replace it
    r = requests.put(f"{api}/collections/{a.collection}/items/{a.item}", json=body, timeout=30)
r.raise_for_status()
print(f"registered {a.collection}/{a.item} -> /data/{rel}")
