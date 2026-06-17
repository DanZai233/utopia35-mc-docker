#!/usr/bin/env bash
set -Eeuo pipefail

TEMPLATE_DIR="${TEMPLATE_DIR:-/opt/minecraft/server-template}"
DATA_DIR="${DATA_DIR:-/data}"
SERVER_JAR="${SERVER_JAR:-server.jar}"
SERVER_PROPERTIES_FILE="$DATA_DIR/server.properties"

log() {
    printf '[entrypoint] %s\n' "$*"
}

is_true() {
    case "${1:-}" in
        true|TRUE|True|1|yes|YES|Yes|y|Y|on|ON|On) return 0 ;;
        *) return 1 ;;
    esac
}

sed_escape() {
    printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}

write_property() {
    local key="$1"
    local value="${2:-}"

    if [ -z "$value" ]; then
        return 0
    fi

    touch "$SERVER_PROPERTIES_FILE"

    local escaped
    escaped="$(sed_escape "$value")"

    if grep -qE "^${key}=" "$SERVER_PROPERTIES_FILE"; then
        sed -i "s/^${key}=.*/${key}=${escaped}/" "$SERVER_PROPERTIES_FILE"
    else
        printf '%s=%s\n' "$key" "$value" >> "$SERVER_PROPERTIES_FILE"
    fi
}

seed_data_dir() {
    mkdir -p "$DATA_DIR"

    if [ -f "$DATA_DIR/$SERVER_JAR" ]; then
        return 0
    fi

    if [ ! -f "$TEMPLATE_DIR/$SERVER_JAR" ]; then
        log "Cannot find $SERVER_JAR in $TEMPLATE_DIR."
        log "Build the image after running ./mcctl prepare /path/to/server-pack."
        exit 1
    fi

    log "Seeding $DATA_DIR from image template."
    shopt -s dotglob nullglob
    cp -a "$TEMPLATE_DIR"/* "$DATA_DIR"/
}

accept_eula_or_exit() {
    if is_true "${EULA:-false}"; then
        printf 'eula=true\n' > "$DATA_DIR/eula.txt"
        return 0
    fi

    if [ -f "$DATA_DIR/eula.txt" ] && grep -qi '^eula=true' "$DATA_DIR/eula.txt"; then
        return 0
    fi

    log "Minecraft EULA has not been accepted."
    log "Read https://aka.ms/MinecraftEULA, then set EULA=true in .env."
    exit 1
}

apply_server_properties() {
    write_property server-port "${SERVER_PORT:-25565}"
    write_property motd "${MOTD:-}"
    write_property level-name "${LEVEL_NAME:-world}"
    write_property level-seed "${LEVEL_SEED:-}"
    write_property gamemode "${GAMEMODE:-survival}"
    write_property difficulty "${DIFFICULTY:-normal}"
    write_property max-players "${MAX_PLAYERS:-20}"
    write_property online-mode "${ONLINE_MODE:-true}"
    write_property pvp "${PVP:-true}"
    write_property allow-flight "${ALLOW_FLIGHT:-true}"
    write_property view-distance "${VIEW_DISTANCE:-10}"
    write_property simulation-distance "${SIMULATION_DISTANCE:-10}"
    write_property white-list "${ENABLE_WHITELIST:-false}"
    write_property enforce-whitelist "${ENFORCE_WHITELIST:-false}"
    write_property enable-command-block "${ENABLE_COMMAND_BLOCK:-false}"
    write_property spawn-protection "${SPAWN_PROTECTION:-16}"
    write_property max-tick-time "${MAX_TICK_TIME:-60000}"
    write_property enable-rcon "${ENABLE_RCON:-false}"
    write_property rcon.port "${RCON_PORT:-25575}"
    write_property rcon.password "${RCON_PASSWORD:-}"

    if [ -n "${SERVER_PROPERTIES:-}" ]; then
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            case "$line" in \#*) continue ;; esac
            case "$line" in
                *=*)
                    write_property "${line%%=*}" "${line#*=}"
                    ;;
            esac
        done <<< "$(printf '%b' "$SERVER_PROPERTIES")"
    fi
}

build_java_args() {
    local min_memory="${MIN_MEMORY:-4096M}"
    local max_memory="${MAX_MEMORY:-4096M}"

    JAVA_ARGS=("-Xms${min_memory}" "-Xmx${max_memory}")

    if is_true "${USE_AIKAR_FLAGS:-true}"; then
        JAVA_ARGS+=(
            "-XX:+AlwaysPreTouch"
            "-XX:+DisableExplicitGC"
            "-XX:+ParallelRefProcEnabled"
            "-XX:+PerfDisableSharedMem"
            "-XX:+UnlockExperimentalVMOptions"
            "-XX:+UseG1GC"
            "-XX:G1HeapRegionSize=8M"
            "-XX:G1HeapWastePercent=5"
            "-XX:G1MaxNewSizePercent=40"
            "-XX:G1MixedGCCountTarget=4"
            "-XX:G1MixedGCLiveThresholdPercent=90"
            "-XX:G1NewSizePercent=30"
            "-XX:G1RSetUpdatingPauseTimePercent=5"
            "-XX:G1ReservePercent=20"
            "-XX:InitiatingHeapOccupancyPercent=15"
            "-XX:MaxGCPauseMillis=200"
            "-XX:MaxTenuringThreshold=1"
            "-XX:SurvivorRatio=32"
            "-Dusing.aikars.flags=https://mcflags.emc.gs"
            "-Daikars.new.flags=true"
        )
    fi

    if [ -n "${JVM_OPTS:-}" ]; then
        read -r -a extra_jvm_args <<< "$JVM_OPTS"
        JAVA_ARGS+=("${extra_jvm_args[@]}")
    fi

    if [ -n "${CUSTOM_JVM_ARGS:-}" ]; then
        read -r -a custom_jvm_args <<< "$CUSTOM_JVM_ARGS"
        JAVA_ARGS+=("${custom_jvm_args[@]}")
    fi
}

main() {
    seed_data_dir
    accept_eula_or_exit
    apply_server_properties
    build_java_args

    cd "$DATA_DIR"

    local server_args=()
    if ! is_true "${ENABLE_GUI:-false}"; then
        server_args+=("nogui")
    fi

    if [ -n "${CUSTOM_ARGS:-}" ]; then
        read -r -a custom_args <<< "$CUSTOM_ARGS"
        server_args+=("${custom_args[@]}")
    fi

    log "Starting Minecraft server: java ${JAVA_ARGS[*]} -jar $SERVER_JAR ${server_args[*]}"
    exec java "${JAVA_ARGS[@]}" -jar "$SERVER_JAR" "${server_args[@]}"
}

main "$@"

