FROM quay.io/jupyter/minimal-notebook:latest
RUN mamba install -y -c conda-forge \
      gdal rasterio geopandas exactextract pystac-client odc-stac xarray rioxarray \
      leafmap localtileserver matplotlib && mamba clean -afy
