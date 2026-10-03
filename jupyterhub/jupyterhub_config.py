import os

c = get_config()  # noqa: F821

# Shared password: trainees pick any username (their name) and type the course password.
# Each username gets its own isolated notebook container and home volume.
c.JupyterHub.authenticator_class = "dummy"
c.DummyAuthenticator.password = os.environ["JUPYTER_SHARED_PASSWORD"]

c.JupyterHub.base_url = "/lab/"
c.JupyterHub.bind_url = "http://:8000/lab/"
c.JupyterHub.hub_ip = "jupyterhub"

c.JupyterHub.spawner_class = "dockerspawner.DockerSpawner"
c.DockerSpawner.image = "geo-training-singleuser:latest"
c.DockerSpawner.network_name = "geo"
c.DockerSpawner.remove = True
c.DockerSpawner.notebook_dir = "/home/jovyan/work"
c.DockerSpawner.volumes = {
    "jupyter-user-{username}": "/home/jovyan/work",
    os.environ["HOST_DATA_DIR"]: {"bind": "/data", "mode": "ro"},
    os.environ["HOST_REPO_DIR"] + "/presets": {"bind": "/home/jovyan/presets", "mode": "ro"},
    os.environ["HOST_REPO_DIR"] + "/examples": {"bind": "/home/jovyan/examples", "mode": "ro"},
    os.environ["HOST_REPO_DIR"] + "/pygeoapi": {"bind": "/home/jovyan/processes-lib", "mode": "ro"},
}
c.DockerSpawner.environment = {
    k: os.environ.get(k, "") for k in
    ("STAC_API_URL",)
}
c.DockerSpawner.environment["PROCESSES_URL"] = "http://pygeoapi:80"
c.DockerSpawner.environment["DOMAIN"] = os.environ.get("DOMAIN", "")
# Per-trainee limits so one heavy job cannot starve the class.
c.DockerSpawner.cpu_limit = 2
c.DockerSpawner.mem_limit = "4G"
c.JupyterHub.active_server_limit = 40
