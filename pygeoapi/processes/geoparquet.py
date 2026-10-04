"""Read GeoParquet (local or public cloud) for an area, without downloading whole files.

Public S3 https URLs (e.g. Overture Maps) are read anonymously through pyarrow's S3 filesystem, so
only the file footers and the row groups that overlap the area are fetched. Files with a GeoParquet
1.1 "bbox" covering column (Overture, most recent GeoParquet) are filtered on it; others are read
and clipped. Nested columns are flattened to plain values the map and GeoJSON can show.
"""
import re

import geopandas as gpd

S3_HTTPS = re.compile(r"^https://([^./]+)\.s3[.-](?:([a-z0-9-]+)\.)?amazonaws\.com/(.+)$")


def _source(href: str):
    """(filesystem, path) for pyarrow."""
    import pyarrow.fs as pafs

    m = S3_HTTPS.match(href)
    if m:
        bucket, region, key = m.groups()
        # Explicit anonymous access with no endpoint override: the CDSE S3 settings in the
        # environment are for GDAL's s3://eodata reads and must not apply here.
        return pafs.S3FileSystem(anonymous=True, region=region or "us-east-1", endpoint_override=None), f"{bucket}/{key}"
    if href.startswith("s3://"):
        return pafs.S3FileSystem(anonymous=True, endpoint_override=None), href[5:]
    if href.startswith(("http://", "https://")):
        raise ValueError(f"GeoParquet over plain https is not supported, use an S3 or local path: {href}")
    return pafs.LocalFileSystem(), href


def _flatten(table):
    """Scalar columns only: struct columns with a "primary" field (Overture names, categories)
    become that value; other nested columns are dropped."""
    import pyarrow as pa
    import pyarrow.compute as pc

    cols, names = [], []
    for name in table.column_names:
        if name in ("geometry", "bbox"):
            continue
        col = table[name]
        t = col.type
        if pa.types.is_struct(t):
            if any(f.name == "primary" for f in t):
                cols.append(pc.struct_field(col, "primary"))
                names.append({"names": "name", "categories": "category"}.get(name, f"{name}_primary"))
            continue
        if pa.types.is_list(t) or pa.types.is_large_list(t) or pa.types.is_map(t) or pa.types.is_binary(t):
            continue
        cols.append(col)
        names.append(name)
    return pa.table(cols, names=names)


def read_geoparquet(hrefs: list[str], bbox=None, max_features: int | None = None) -> gpd.GeoDataFrame:
    import pyarrow.compute as pc
    import pyarrow.dataset as ds

    frames = []
    total = 0
    for href in hrefs:
        fs, path = _source(href)
        dset = ds.dataset(path, filesystem=fs, format="parquet")
        schema = dset.schema
        flt = None
        if bbox is not None and "bbox" in schema.names:
            x0, y0, x1, y1 = bbox
            flt = ((pc.field("bbox", "xmin") <= x1) & (pc.field("bbox", "xmax") >= x0)
                   & (pc.field("bbox", "ymin") <= y1) & (pc.field("bbox", "ymax") >= y0))
        table = dset.to_table(filter=flt)
        if table.num_rows == 0:
            continue
        geom = gpd.GeoSeries.from_wkb(table["geometry"].to_numpy(zero_copy_only=False), crs=4326)
        gdf = gpd.GeoDataFrame(_flatten(table).to_pandas(), geometry=geom, crs=4326)
        if bbox is not None and flt is None:
            gdf = gdf.cx[bbox[0]:bbox[2], bbox[1]:bbox[3]]
        frames.append(gdf)
        total += len(gdf)
        if max_features and total > max_features:
            break
    if not frames:
        return gpd.GeoDataFrame(geometry=[], crs=4326)
    import pandas as pd
    return gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=4326)
