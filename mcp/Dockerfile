# Build context is the repo root (see docker-compose.yml) so the shared MCDA code and presets
# are copied in, not duplicated.
FROM python:3.11-slim
RUN pip install --no-cache-dir "mcp>=1.2,<2" "httpx>=0.27" "numpy>=1.26" "scipy>=1.11" \
      "rasterio>=1.3" "geopandas>=0.14"
WORKDIR /app
COPY pygeoapi/processes/__init__.py pygeoapi/processes/mcda.py /app/processes/
COPY presets /app/presets
COPY mcp/server.py /app/server.py
EXPOSE 8090
CMD ["python", "server.py"]
