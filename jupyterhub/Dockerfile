FROM quay.io/jupyterhub/jupyterhub:5
RUN pip install --no-cache-dir dockerspawner jupyterhub-dummyauthenticator
COPY jupyterhub_config.py /srv/jupyterhub/jupyterhub_config.py
WORKDIR /srv/jupyterhub
CMD ["jupyterhub", "-f", "/srv/jupyterhub/jupyterhub_config.py"]
