FROM eclipse-temurin:21-jre-jammy

ARG SERVER_PACK_URL=""
ARG ALLOW_EMPTY_PACK="false"

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl tini unzip \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --uid 1000 --create-home --home-dir /home/minecraft --shell /usr/sbin/nologin minecraft

WORKDIR /opt/minecraft

COPY server-files/ /tmp/server-files/

RUN set -eux; \
    mkdir -p /opt/minecraft/server-template; \
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
    cp -a /tmp/server-files/. /opt/minecraft/server-template/; \
    rm -rf /opt/minecraft/server-template/zulu-21; \
    find /opt/minecraft/server-template -maxdepth 1 -type f -name '*.bat' -delete; \
    if [ ! -f /opt/minecraft/server-template/server.jar ] && [ "$ALLOW_EMPTY_PACK" != "true" ]; then \
        echo "server.jar is missing. Run ./mcctl prepare /path/to/server-pack or set SERVER_PACK_URL."; \
        exit 1; \
    fi; \
    rm -rf /tmp/server-files /tmp/server-pack /tmp/server-pack.zip; \
    mkdir -p /data; \
    chown -R minecraft:minecraft /opt/minecraft /data

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER minecraft
WORKDIR /data

VOLUME ["/data"]
EXPOSE 25565/tcp 25575/tcp

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

