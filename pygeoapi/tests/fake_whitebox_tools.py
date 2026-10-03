"""Stand-in for the whitebox_tools binary, mimicking its documented CLI output formats."""
import json
import sys

TOOLS = {
    "Slope": [
        {"name": "Input DEM File", "flags": ["-i", "--dem"], "description": "Input raster DEM file.",
         "parameter_type": {"ExistingFile": "Raster"}, "default_value": None, "optional": False},
        {"name": "Output File", "flags": ["-o", "--output"], "description": "Output raster file.",
         "parameter_type": {"NewFile": "Raster"}, "default_value": None, "optional": False},
        {"name": "Z Conversion Factor", "flags": ["--zfactor"], "description": "Z factor.",
         "parameter_type": "Float", "default_value": "1.0", "optional": True},
        {"name": "Units", "flags": ["--units"], "description": "Units.",
         "parameter_type": {"OptionList": ["degrees", "percent"]}, "default_value": "degrees", "optional": True},
    ],
    "RasterToVectorPolygons": [
        {"name": "Input Raster", "flags": ["-i", "--input"], "description": "Input raster.",
         "parameter_type": {"ExistingFile": "Raster"}, "default_value": None, "optional": False},
        {"name": "Output", "flags": ["-o", "--output"], "description": "Output polygons.",
         "parameter_type": {"NewFile": {"Vector": "Polygon"}}, "default_value": None, "optional": False},
    ],
    "Clip": [
        {"name": "Input", "flags": ["-i", "--input"], "description": "Input vector.",
         "parameter_type": {"ExistingFile": {"Vector": "Any"}}, "default_value": None, "optional": False},
        {"name": "Fill holes", "flags": ["--fill"], "description": "Flag.",
         "parameter_type": "Boolean", "default_value": "false", "optional": True},
    ],
}

args = sys.argv[1:]
if args == ["--listtools"]:
    print(f"All {len(TOOLS)} Available Tools:")
    for t in TOOLS:
        print(f"{t}: Does {t.lower()} things.")
elif args[0].startswith("--toolparameters="):
    print(json.dumps({"parameters": TOOLS[args[0].split("=", 1)[1]]}))
elif args[0].startswith("--run="):
    tool = args[0].split("=", 1)[1]
    kv = dict(a.lstrip("-").split("=", 1) for a in args[1:] if "=" in a)
    with open(kv["wd"] + "/argv.json", "w") as f:
        json.dump(args, f)
    import rasterio
    if tool == "Slope":
        with rasterio.open(kv["dem"]) as src:
            prof, data = src.profile, src.read() * 2
        with rasterio.open(kv["output"], "w", **prof) as dst:
            dst.write(data)
    elif tool == "RasterToVectorPolygons":
        import geopandas as gpd
        from shapely.geometry import box
        with rasterio.open(kv["input"]) as src:
            gpd.GeoDataFrame({"v": [1]}, geometry=[box(*src.bounds)], crs=src.crs).to_file(kv["output"])
    print("Elapsed Time: 0.01s")
else:
    sys.exit(2)
