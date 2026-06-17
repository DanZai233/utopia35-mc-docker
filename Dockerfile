FROM eclipse-temurin:21-jre-jammy

ARG SERVER_PACK_URL=""
ARG ALLOW_EMPTY_PACK="false"

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl tini unzip \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --uid 1000 --create-home --home-dir /home/minecraft --shell /usr/sbin/nologin minecraft

WORKDIR /opt/minecraft
RUN mkdir -p /opt/minecraft/server-template/mods /data \
    && chown -R minecraft:minecraft /opt/minecraft /data

COPY --chown=minecraft:minecraft server-files/ /opt/minecraft/server-template/
COPY --chown=minecraft:minecraft .docker-pack/mods-00/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-01/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-02/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-03/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-04/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-05/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-06/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-07/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-08/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-09/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-10/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-11/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-12/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-13/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-14/ /opt/minecraft/server-template/mods/
COPY --chown=minecraft:minecraft .docker-pack/mods-15/ /opt/minecraft/server-template/mods/

RUN set -eux; \
    if [ -n "$SERVER_PACK_URL" ]; then \
        mkdir -p /tmp/server-pack; \
        curl -fsSL "$SERVER_PACK_URL" -o /tmp/server-pack.zip; \
        unzip -q /tmp/server-pack.zip -d /tmp/server-pack; \
        pack_root="$(dirname "$(find /tmp/server-pack -maxdepth 3 -type f -name server.jar | head -n 1)")"; \
        if [ -n "$pack_root" ] && [ "$pack_root" != "." ]; then \
            cp -a "$pack_root"/. /opt/minecraft/server-template/; \
        else \
            cp -a /tmp/server-pack/. /opt/minecraft/server-template/; \
        fi; \
    fi; \
    rm -rf /opt/minecraft/server-template/zulu-21; \
    find /opt/minecraft/server-template -maxdepth 1 -type f -name '*.bat' -delete; \
    if [ ! -f /opt/minecraft/server-template/server.jar ] && [ "$ALLOW_EMPTY_PACK" != "true" ]; then \
        echo "server.jar is missing. Run ./mcctl prepare /path/to/server-pack or set SERVER_PACK_URL."; \
        exit 1; \
    fi; \
    rm -rf /tmp/server-pack /tmp/server-pack.zip; \
    chown -R minecraft:minecraft /opt/minecraft /data

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER minecraft
WORKDIR /data

VOLUME ["/data"]
EXPOSE 25565/tcp 25575/tcp

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
