"""Multi-criteria suitability building blocks. Pure functions, no pygeoapi imports, so the
processes, the MCP server and the notebooks all share one tested implementation.

Grid: every analysis runs on one metric grid built from the AOI (local UTM zone), so distances
and areas are in metres and all criteria are pixel-aligned.
"""
from dataclasses import dataclass

import geopandas as gpd
import numpy as np
import rasterio
from rasterio import features
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from scipy import ndimage
from shapely.geometry import shape

# Saaty random consistency index, n = 1..10.
RANDOM_INDEX = [0.0, 0.0, 0.0, 0.58, 0.90, 1.12, 1.24, 1.32, 1.41, 1.45, 1.49]
MAX_CELLS = 25_000_000


class MCDAError(ValueError):
    """Bad user input. Message is safe to show to trainees."""


@dataclass
class Grid:
    crs: rasterio.crs.CRS
    transform: rasterio.Affine
    width: int
    height: int
    resolution: float

    @property
    def shape(self):
        return (self.height, self.width)


def build_grid(aoi: gpd.GeoDataFrame, resolution_m: float) -> Grid:
    if resolution_m <= 0:
        raise MCDAError("resolution must be positive")
    crs = aoi.estimate_utm_crs()
    minx, miny, maxx, maxy = aoi.to_crs(crs).total_bounds
    width = int(np.ceil((maxx - minx) / resolution_m))
    height = int(np.ceil((maxy - miny) / resolution_m))
    if width * height > MAX_CELLS:
        raise MCDAError(f"grid too large ({width}x{height}); use a coarser resolution or smaller area")
    return Grid(crs, from_origin(minx, maxy, resolution_m, resolution_m), width, height, resolution_m)


def aoi_mask(aoi: gpd.GeoDataFrame, grid: Grid) -> np.ndarray:
    """True inside the AOI."""
    return features.rasterize(
        aoi.to_crs(grid.crs).geometry, out_shape=grid.shape, transform=grid.transform,
        fill=0, default_value=1, dtype="uint8").astype(bool)


def read_to_grid(href: str, grid: Grid, band: int = 1, categorical: bool = False,
                 counts: bool = False) -> np.ma.MaskedArray:
    """Warp any GDAL-readable raster onto the grid. Categorical data uses nearest neighbour;
    count data (population) uses sum, which is correct when the grid is coarser than the source."""
    resampling = Resampling.sum if counts else Resampling.nearest if categorical else Resampling.bilinear
    with rasterio.open(href) as src:
        # Without a nodata value, cells outside the source would read as 0 and bilinear
        # resampling would blend that 0 into edge cells. Warp such rasters as float32 with NaN
        # as nodata so GDAL leaves those cells out (integer class codes and counts are exact
        # in float32; an alpha band instead fails on GDAL >= 3.11).
        opts = {}
        if src.nodata is None:
            opts["nodata"] = np.nan
            if not np.issubdtype(np.dtype(src.dtypes[band - 1]), np.floating):
                opts["dtype"] = "float32"
        with WarpedVRT(src, crs=grid.crs, transform=grid.transform, width=grid.width,
                       height=grid.height, resampling=resampling, **opts) as vrt:
            data = vrt.read(band, masked=True).astype("float64")
    return np.ma.masked_invalid(data)


def distance_to_features(gdf: gpd.GeoDataFrame, grid: Grid) -> np.ndarray:
    """Euclidean distance in metres from every cell to the nearest feature."""
    if gdf.empty:
        raise MCDAError("no features to measure distance to")
    burned = features.rasterize(
        gdf.to_crs(grid.crs).geometry, out_shape=grid.shape, transform=grid.transform,
        fill=0, default_value=1, dtype="uint8", all_touched=True)
    if not burned.any():
        raise MCDAError("features fall outside the analysis area")
    return ndimage.distance_transform_edt(burned == 0) * grid.resolution


def score(values: np.ndarray, rule: dict) -> np.ndarray:
    """Map criterion values to 0..1 suitability scores.

    rule types:
      linear:     {"type": "linear", "min": a, "max": b, "direction": "higher"|"lower"}
      thresholds: {"type": "thresholds", "breaks": [b1, b2, ...], "scores": [s0, s1, ..., sn]}
                  (len(scores) == len(breaks) + 1, value < b1 gets s0)
      classes:    {"type": "classes", "map": {"10": 1.0, "40": 0.6}, "default": 0}
    """
    v = np.asarray(values, dtype="float64")
    kind = rule.get("type")
    if kind == "linear":
        lo, hi = float(rule["min"]), float(rule["max"])
        if hi <= lo:
            raise MCDAError("linear rule needs max > min")
        s = np.clip((v - lo) / (hi - lo), 0, 1)
        return 1 - s if rule.get("direction", "higher") == "lower" else s
    if kind == "thresholds":
        breaks, scores = list(rule["breaks"]), list(rule["scores"])
        if len(scores) != len(breaks) + 1 or breaks != sorted(breaks):
            raise MCDAError("thresholds rule needs sorted breaks and len(scores) == len(breaks) + 1")
        return np.asarray(scores, dtype="float64")[np.digitize(v, breaks)]
    if kind == "classes":
        out = np.full(v.shape, float(rule.get("default", 0)))
        for k, s in rule["map"].items():
            out[v == float(k)] = float(s)
        return out
    raise MCDAError(f"unknown score rule type: {kind!r}")


def ahp_weights(matrix) -> tuple[np.ndarray, float]:
    """Analytic Hierarchy Process: pairwise comparison matrix to (weights, consistency ratio).
    CR below 0.10 is usually acceptable."""
    m = np.asarray(matrix, dtype="float64")
    n = m.shape[0]
    if m.shape != (n, n) or n < 2:
        raise MCDAError("AHP matrix must be square, at least 2 x 2")
    if not np.allclose(m * m.T, 1, rtol=1e-3):
        raise MCDAError("AHP matrix must be reciprocal (a[i][j] == 1 / a[j][i])")
    vals, vecs = np.linalg.eig(m)
    k = np.argmax(vals.real)
    w = np.abs(vecs[:, k].real)
    w /= w.sum()
    if n <= 2:
        return w, 0.0
    ci = (vals[k].real - n) / (n - 1)
    ri = RANDOM_INDEX[n] if n < len(RANDOM_INDEX) else RANDOM_INDEX[-1]
    return w, float(ci / ri)


def normalise_weights(weights) -> np.ndarray:
    w = np.asarray(weights, dtype="float64")
    if (w < 0).any() or w.sum() <= 0:
        raise MCDAError("weights must be non-negative and not all zero")
    return w / w.sum()


def weighted_overlay(scores: list[np.ndarray], weights, exclude: np.ndarray | None = None) -> np.ma.MaskedArray:
    """Weighted linear combination of 0..1 scores. Cells with no data in any criterion, or in the
    exclusion mask, are masked."""
    w = normalise_weights(weights)
    if len(scores) != len(w):
        raise MCDAError("one weight per criterion is required")
    stack = np.ma.stack([np.ma.asarray(s) for s in scores])
    result = np.ma.sum(stack * w[:, None, None], axis=0)
    mask = np.ma.getmaskarray(stack).any(axis=0)
    if exclude is not None:
        mask |= exclude
    return np.ma.array(result.filled(0), mask=mask)


def top_sites(suit: np.ma.MaskedArray, grid: Grid, threshold: float,
              min_area_m2: float = 0, n: int = 10) -> gpd.GeoDataFrame:
    """Patches of contiguous cells with score >= threshold, ranked by mean score then area."""
    good = (suit.filled(-1) >= threshold)
    labels, count = ndimage.label(good)
    if count == 0:
        return gpd.GeoDataFrame({"rank": [], "area_ha": [], "mean_score": []}, geometry=[], crs="EPSG:4326")
    idx = np.arange(1, count + 1)
    means = ndimage.mean(suit.filled(0), labels, idx)
    cell_area = grid.resolution ** 2
    areas = ndimage.sum(good, labels, idx) * cell_area
    rows = []
    for geom, lab in features.shapes(labels.astype("int32"), mask=labels > 0, transform=grid.transform):
        i = int(lab) - 1
        if areas[i] >= min_area_m2:
            rows.append({"label": int(lab), "area_ha": areas[i] / 10_000,
                         "mean_score": float(means[i]), "geometry": shape(geom)})
    if not rows:
        return gpd.GeoDataFrame({"rank": [], "area_ha": [], "mean_score": []}, geometry=[], crs="EPSG:4326")
    gdf = gpd.GeoDataFrame(rows, crs=grid.crs).dissolve(by="label", aggfunc="first").reset_index(drop=True)
    gdf = gdf.sort_values(["mean_score", "area_ha"], ascending=False).head(n)
    gdf.insert(0, "rank", range(1, len(gdf) + 1))
    return gdf.to_crs("EPSG:4326")


def population_beyond(pop: np.ma.MaskedArray, dist_m: np.ndarray, limit_m: float) -> dict:
    """People within and beyond a distance limit of the nearest facility."""
    p = pop.filled(0)
    p = np.where(p > 0, p, 0)
    within = float(p[dist_m <= limit_m].sum())
    total = float(p.sum())
    return {"total": total, "within": within, "beyond": total - within,
            "share_within": within / total if total else None}


def write_cog(path: str, data: np.ma.MaskedArray, grid: Grid, nodata: float = -9999) -> str:
    profile = dict(driver="COG", width=grid.width, height=grid.height, count=1, dtype="float32",
                   crs=grid.crs, transform=grid.transform, nodata=nodata, compress="deflate")
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(np.ma.filled(data.astype("float32"), nodata), 1)
    return path
