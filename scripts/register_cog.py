"""Convert a raster to COG, upload to MinIO and register it as a STAC item.

Usage:
  python scripts/register_cog.py input.tif --collection landcover --item lc-2024 --bucket stac
Needs: gdal (gdal_translate), rio-stac, boto3, requests. Reads S3_* / AWS_* / STAC_API_URL from env.
"""
import argparse
import os
import subprocess
import tempfile

import boto3
import requests
from rio_stac import create_stac_item

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("--collection", required=True)
ap.add_argument("--item", required=True)
ap.add_argument("--bucket", default="stac")
a = ap.parse_args()

with tempfile.TemporaryDirectory() as tmp:
    cog = os.path.join(tmp, f"{a.item}.tif")
    subprocess.run(["gdal_translate", "-of", "COG", "-co", "COMPRESS=DEFLATE", a.src, cog], check=True)
    key = f"{a.collection}/{a.item}.tif"
    boto3.client("s3", endpoint_url=os.environ["S3_ENDPOINT"]).upload_file(cog, a.bucket, key)
    item = create_stac_item(cog, id=a.item, collection=a.collection,
                            asset_name="data", asset_href=f"s3://{a.bucket}/{key}",
                            with_proj=True, with_raster=True)

api = os.environ["STAC_API_URL"].rstrip("/")
r = requests.post(f"{api}/collections/{a.collection}/items", json=item.to_dict())
r.raise_for_status()
print(f"registered {a.collection}/{a.item}")
