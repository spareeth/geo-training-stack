FROM geopython/pygeoapi:latest
# pygeoapi runs from /venv, which sees the image's apt geo stack (GDAL, rasterio, pyproj, shapely,
# scipy, pandas). Install only what is missing, into /venv, and keep numpy at the apt version so the
# GDAL/rasterio builds stay ABI-compatible and use the image's PROJ database.
RUN /venv/bin/pip install --no-cache-dir "numpy==$(/venv/bin/python -c 'import numpy;print(numpy.__version__)')" \
      "exactextract>=0.2" "geopandas>=0.14" "pystac-client>=0.7" "planetary-computer>=1.0" \
      "pyarrow>=17"

# WhiteboxTools open core (MIT): the same toolbox GeoLibre runs in the browser, here on the server.
# Pin a release by changing the URL; check the licence file in the zip when upgrading.
ARG WBT_URL=https://www.whiteboxgeo.com/WBT_Linux/WhiteboxTools_linux_amd64.zip
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip && \
    curl -fsSL "$WBT_URL" -o /tmp/wbt.zip && unzip -q /tmp/wbt.zip -d /tmp/wbt && \
    mkdir -p /opt/whitebox && \
    cp "$(find /tmp/wbt -name whitebox_tools -type f | head -1)" /opt/whitebox/whitebox_tools && \
    chmod +x /opt/whitebox/whitebox_tools && /opt/whitebox/whitebox_tools --version && \
    rm -rf /tmp/wbt /tmp/wbt.zip && apt-get purge -y curl unzip && rm -rf /var/lib/apt/lists/*
ENV WHITEBOX_TOOLS=/opt/whitebox/whitebox_tools

COPY processes /pygeoapi/training_processes
ENV PYTHONPATH=/pygeoapi
COPY pygeoapi-config.yml /pygeoapi/local.config.yml
