"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { PassThrough } = require("stream");

const Docker = require("dockerode");
const express = require("express");
const multer = require("multer");
const { Rcon } = require("rcon-client");
const WebSocket = require("ws");

const execFileAsync = promisify(execFile);

const PANEL_PORT = Number(process.env.PANEL_PORT || 8080);
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "change-me";
const MINECRAFT_CONTAINER = process.env.MINECRAFT_CONTAINER || "utopia35-mc";
const DATA_DIR = process.env.DATA_DIR || "/data";
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
const COMPOSE_ENV_FILE = process.env.COMPOSE_ENV_FILE || path.join(WORKSPACE_DIR, ".env");
const RUNTIME_ENV_FILE = process.env.RUNTIME_ENV_FILE || path.join(DATA_DIR, "server.env");
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(WORKSPACE_DIR, "backups");
const EXAMPLE_ENV_FILE = process.env.EXAMPLE_ENV_FILE || path.join(WORKSPACE_DIR, ".env.example");
const MODS_DIR = path.join(DATA_DIR, "mods");
const SERVER_PROPERTIES_FILE = path.join(DATA_DIR, "server.properties");
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const RCON_HOST = process.env.RCON_HOST || "minecraft";

const docker = new Docker({ socketPath: DOCKER_SOCKET });
const app = express();
const server = http.createServer(app);
const upload = multer({
  dest: "/tmp/utopia35-panel-uploads",
  limits: { fileSize: 1024 * 1024 * 1024, files: 20 }
});

const sessions = new Map();
const SESSION_COOKIE = "utopia35_panel";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CONFIG_FIELDS = [
  { key: "EULA", label: "接受 EULA", type: "boolean", default: "false", group: "基础" },
  { key: "MOTD", label: "服务器 MOTD", type: "text", default: "Utopia 3.5 Fabric Server", group: "基础" },
  { key: "MIN_MEMORY", label: "最小内存", type: "memory", default: "4096M", group: "性能" },
  { key: "MAX_MEMORY", label: "最大内存", type: "memory", default: "4096M", group: "性能" },
  { key: "MAX_PLAYERS", label: "最大玩家数", type: "number", min: 1, max: 500, default: "20", group: "基础" },
  { key: "LEVEL_NAME", label: "地图目录", type: "text", default: "world", group: "世界" },
  { key: "LEVEL_SEED", label: "地图种子", type: "text", default: "", group: "世界" },
  { key: "GAMEMODE", label: "游戏模式", type: "select", options: ["survival", "creative", "adventure", "spectator"], default: "survival", group: "世界" },
  { key: "DIFFICULTY", label: "难度", type: "select", options: ["peaceful", "easy", "normal", "hard"], default: "normal", group: "世界" },
  { key: "ONLINE_MODE", label: "正版登录验证", type: "boolean", default: "false", group: "安全" },
  { key: "ENABLE_WHITELIST", label: "开启白名单", type: "boolean", default: "false", group: "安全" },
  { key: "ENFORCE_WHITELIST", label: "强制白名单", type: "boolean", default: "false", group: "安全" },
  { key: "PVP", label: "允许 PVP", type: "boolean", default: "true", group: "玩法" },
  { key: "ALLOW_FLIGHT", label: "允许飞行", type: "boolean", default: "true", group: "玩法" },
  { key: "ENABLE_COMMAND_BLOCK", label: "命令方块", type: "boolean", default: "false", group: "玩法" },
  { key: "SPAWN_PROTECTION", label: "出生点保护", type: "number", min: 0, max: 1000, default: "16", group: "玩法" },
  { key: "VIEW_DISTANCE", label: "视距", type: "number", min: 2, max: 32, default: "10", group: "性能" },
  { key: "SIMULATION_DISTANCE", label: "模拟距离", type: "number", min: 2, max: 32, default: "10", group: "性能" },
  { key: "MAX_TICK_TIME", label: "最大 Tick 时间", type: "number", min: -1, max: 600000, default: "60000", group: "性能" },
  { key: "USE_AIKAR_FLAGS", label: "Aikar JVM 参数", type: "boolean", default: "true", group: "JVM" },
  { key: "JVM_OPTS", label: "额外 JVM 参数", type: "text", default: "", group: "JVM" },
  { key: "CUSTOM_JVM_ARGS", label: "自定义 JVM 参数", type: "text", default: "", group: "JVM" },
  { key: "CUSTOM_ARGS", label: "服务端启动参数", type: "text", default: "", group: "JVM" },
  { key: "ENABLE_RCON", label: "开启 RCON", type: "boolean", default: "false", group: "控制台" },
  { key: "RCON_PORT", label: "RCON 端口", type: "number", min: 1, max: 65535, default: "25575", group: "控制台" },
  { key: "RCON_PASSWORD", label: "RCON 密码", type: "password", default: "", group: "控制台" },
  { key: "SERVER_PROPERTIES", label: "额外 server.properties", type: "textarea", default: "", group: "高级" }
];

const CONFIG_FIELD_MAP = new Map(CONFIG_FIELDS.map((field) => [field.key, field]));

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function getSession(req) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function requireAuth(req, res, next) {
  if (getSession(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "NOT_AUTHENTICATED", message: "需要先登录控制面板。" });
}

function setSessionCookie(res, sessionId) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function timingSafePasswordEqual(input) {
  const expected = Buffer.from(PANEL_PASSWORD);
  const actual = Buffer.from(String(input || ""));
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseEnvText(text) {
  const values = {};
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const index = normalized.indexOf("=");
    if (index === -1) continue;
    const key = normalized.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = normalized.slice(index + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value.replace(/\\n/g, "\n");
  }
  return values;
}

async function readEnvFile(filePath) {
  try {
    return parseEnvText(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function encodeEnvValue(value) {
  return String(value ?? "").replace(/\r?\n/g, "\\n");
}

async function writeEnvFile(filePath, updates, options = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  let text = "";
  if (await pathExists(filePath)) {
    text = await fsp.readFile(filePath, "utf8");
  } else if (options.seedFrom && (await pathExists(options.seedFrom))) {
    text = await fsp.readFile(options.seedFrom, "utf8");
  }

  const remaining = new Map(Object.entries(updates));
  const lines = text ? text.split(/\r?\n/) : [];
  const output = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const index = normalized.indexOf("=");
    const key = index === -1 ? "" : normalized.slice(0, index).trim();
    if (remaining.has(key)) {
      output.push(`${key}=${encodeEnvValue(remaining.get(key))}`);
      remaining.delete(key);
    } else {
      output.push(rawLine);
    }
  }

  if (remaining.size > 0) {
    if (output.length && output[output.length - 1] !== "") output.push("");
    output.push("# Managed by Utopia web panel");
    for (const [key, value] of remaining.entries()) {
      output.push(`${key}=${encodeEnvValue(value)}`);
    }
  }

  await fsp.writeFile(filePath, `${output.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

function normalizeConfigValue(field, value) {
  const stringValue = String(value ?? "");
  if (field.type === "boolean") {
    return ["true", "1", "yes", "on"].includes(stringValue.toLowerCase()) ? "true" : "false";
  }
  if (field.type === "number") {
    const number = Number(stringValue);
    if (!Number.isInteger(number)) throw new Error(`${field.label} 必须是整数。`);
    if (field.min !== undefined && number < field.min) throw new Error(`${field.label} 不能小于 ${field.min}。`);
    if (field.max !== undefined && number > field.max) throw new Error(`${field.label} 不能大于 ${field.max}。`);
    return String(number);
  }
  if (field.type === "memory") {
    if (!/^[1-9][0-9]*(M|G|m|g)$/.test(stringValue)) {
      throw new Error(`${field.label} 必须类似 4096M 或 8G。`);
    }
    return stringValue.toUpperCase();
  }
  if (field.type === "select") {
    if (!field.options.includes(stringValue)) {
      throw new Error(`${field.label} 的值不合法。`);
    }
    return stringValue;
  }
  if (field.type !== "textarea" && /[\r\n]/.test(stringValue)) {
    throw new Error(`${field.label} 不能包含换行。`);
  }
  return stringValue;
}

async function readConfigValues() {
  const defaults = Object.fromEntries(CONFIG_FIELDS.map((field) => [field.key, field.default ?? ""]));
  const example = await readEnvFile(EXAMPLE_ENV_FILE);
  const compose = await readEnvFile(COMPOSE_ENV_FILE);
  const runtime = await readEnvFile(RUNTIME_ENV_FILE);
  return { ...defaults, ...example, ...compose, ...runtime };
}

async function saveConfigValues(values) {
  const updates = {};
  for (const [key, value] of Object.entries(values || {})) {
    const field = CONFIG_FIELD_MAP.get(key);
    if (!field) continue;
    updates[key] = normalizeConfigValue(field, value);
  }
  if (Object.keys(updates).length === 0) {
    throw new Error("没有可保存的配置。");
  }
  await writeEnvFile(RUNTIME_ENV_FILE, updates);
  await writeEnvFile(COMPOSE_ENV_FILE, updates, { seedFrom: EXAMPLE_ENV_FILE });
  return updates;
}

async function readServerProperties() {
  try {
    const text = await fsp.readFile(SERVER_PROPERTIES_FILE, "utf8");
    const values = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index === -1) continue;
      values[line.slice(0, index)] = line.slice(index + 1);
    }
    return values;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function getMinecraftContainer() {
  const container = docker.getContainer(MINECRAFT_CONTAINER);
  try {
    const inspect = await container.inspect();
    return { container, inspect };
  } catch (error) {
    if (error.statusCode === 404) return { container: null, inspect: null };
    throw error;
  }
}

function getContainerEnv(inspect) {
  const env = {};
  for (const item of inspect?.Config?.Env || []) {
    const index = item.indexOf("=");
    if (index !== -1) env[item.slice(0, index)] = item.slice(index + 1);
  }
  return env;
}

function getPublishedPorts(inspect) {
  const ports = inspect?.NetworkSettings?.Ports || {};
  return Object.entries(ports).map(([containerPort, bindings]) => ({
    containerPort,
    bindings: bindings || []
  }));
}

function calculateCpuPercent(stats) {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const onlineCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  if (systemDelta <= 0 || cpuDelta <= 0) return 0;
  return (cpuDelta / systemDelta) * onlineCpus * 100;
}

async function readContainerStats(container, inspect) {
  if (!container || !inspect?.State?.Running) return null;
  try {
    const stats = await container.stats({ stream: false });
    return {
      cpuPercent: calculateCpuPercent(stats),
      memoryUsage: stats.memory_stats.usage || 0,
      memoryLimit: stats.memory_stats.limit || 0
    };
  } catch {
    return null;
  }
}

async function listMods() {
  await fsp.mkdir(MODS_DIR, { recursive: true });
  const entries = await fsp.readdir(MODS_DIR, { withFileTypes: true });
  const mods = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".jar") && !entry.name.endsWith(".jar.disabled")) continue;
    const filePath = path.join(MODS_DIR, entry.name);
    const stat = await fsp.stat(filePath);
    mods.push({
      name: entry.name,
      enabled: entry.name.endsWith(".jar"),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }
  return mods.sort((a, b) => a.name.localeCompare(b.name));
}

async function listBackups() {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const entries = await fsp.readdir(BACKUP_DIR, { withFileTypes: true });
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tar.gz")) continue;
    const filePath = path.join(BACKUP_DIR, entry.name);
    const stat = await fsp.stat(filePath);
    backups.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function safeFileName(name) {
  const base = path.basename(String(name || "")).replace(/[^A-Za-z0-9._+ -]/g, "_");
  if (!base || base === "." || base === "..") throw new Error("文件名不合法。");
  return base;
}

function safeModName(name) {
  const base = safeFileName(name);
  if (!base.endsWith(".jar") && !base.endsWith(".jar.disabled")) {
    throw new Error("只允许管理 .jar 或 .jar.disabled 文件。");
  }
  return base;
}

async function createBackup() {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const worldDirs = [];
  for (const name of ["world", "world_nether", "world_the_end"]) {
    if (await pathExists(path.join(DATA_DIR, name))) worldDirs.push(name);
  }
  if (worldDirs.length === 0) {
    throw new Error("没有找到 world/world_nether/world_the_end 地图目录。");
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const output = path.join(BACKUP_DIR, `world-${stamp}.tar.gz`);
  await execFileAsync("tar", ["-czf", output, "-C", DATA_DIR, ...worldDirs], { timeout: 30 * 60 * 1000 });
  const stat = await fsp.stat(output);
  return { name: path.basename(output), size: stat.size, mtimeMs: stat.mtimeMs };
}

function demuxLogBuffer(buffer, tty) {
  if (tty) return buffer.toString("utf8");
  const chunks = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break;
    chunks.push(buffer.slice(start, end));
    offset = end;
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : buffer.toString("utf8");
}

async function getLogTail(tail = 200) {
  const { container, inspect } = await getMinecraftContainer();
  if (!container) throw new Error("没有找到 Minecraft 容器。");
  const buffer = await container.logs({
    stdout: true,
    stderr: true,
    tail: Math.max(10, Math.min(Number(tail) || 200, 1000)),
    timestamps: false
  });
  return demuxLogBuffer(buffer, Boolean(inspect.Config.Tty));
}

async function sendRconCommand(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed) throw new Error("命令不能为空。");
  const config = await readConfigValues();
  if (config.ENABLE_RCON !== "true") {
    throw new Error("RCON 尚未开启。请先在配置中开启 RCON 并重启服务器。");
  }
  const password = config.RCON_PASSWORD || "";
  if (!password) {
    throw new Error("RCON 密码为空。请先设置强密码并重启服务器。");
  }
  const port = Number(config.RCON_PORT || process.env.RCON_PORT || 25575);
  const rcon = await Rcon.connect({ host: RCON_HOST, port, password, timeout: 5000 });
  try {
    return await rcon.send(trimmed);
  } finally {
    rcon.end();
  }
}

async function buildStatus() {
  const [{ container, inspect }, config, runtimeConfig, serverProperties, mods, backups] = await Promise.all([
    getMinecraftContainer(),
    readConfigValues(),
    readEnvFile(RUNTIME_ENV_FILE),
    readServerProperties(),
    listMods(),
    listBackups()
  ]);
  const stats = await readContainerStats(container, inspect);
  return {
    now: new Date().toISOString(),
    panel: {
      defaultPassword: PANEL_PASSWORD === "change-me",
      bindHint: process.env.PANEL_BIND || "127.0.0.1"
    },
    paths: {
      dataDir: DATA_DIR,
      modsDir: MODS_DIR,
      backupDir: BACKUP_DIR,
      runtimeEnvFile: RUNTIME_ENV_FILE,
      composeEnvFile: COMPOSE_ENV_FILE
    },
    container: inspect
      ? {
          name: inspect.Name.replace(/^\//, ""),
          image: inspect.Config.Image,
          id: inspect.Id,
          state: inspect.State.Status,
          running: Boolean(inspect.State.Running),
          health: inspect.State.Health?.Status || null,
          startedAt: inspect.State.StartedAt,
          restartPolicy: inspect.HostConfig.RestartPolicy?.Name || "",
          tty: Boolean(inspect.Config.Tty),
          ports: getPublishedPorts(inspect),
          env: getContainerEnv(inspect)
        }
      : null,
    stats,
    config,
    runtimeConfig,
    serverProperties,
    counts: {
      mods: mods.length,
      enabledMods: mods.filter((mod) => mod.enabled).length,
      backups: backups.length
    }
  };
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  res.json({
    authenticated: Boolean(getSession(req)),
    defaultPassword: PANEL_PASSWORD === "change-me"
  });
});

app.post("/api/login", (req, res) => {
  if (!timingSafePasswordEqual(req.body?.password)) {
    res.status(401).json({ error: "BAD_PASSWORD", message: "密码不正确。" });
    return;
  }
  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionId, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  setSessionCookie(res, sessionId);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (sessionId) sessions.delete(sessionId);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use("/api", requireAuth);

app.get("/api/status", asyncHandler(async (_req, res) => {
  res.json(await buildStatus());
}));

app.get("/api/config", asyncHandler(async (_req, res) => {
  res.json({
    fields: CONFIG_FIELDS,
    values: await readConfigValues(),
    runtimeValues: await readEnvFile(RUNTIME_ENV_FILE)
  });
}));

app.post("/api/config", asyncHandler(async (req, res) => {
  const updated = await saveConfigValues(req.body?.values || {});
  res.json({ ok: true, updated, restartRequired: true });
}));

app.post("/api/rcon/setup", asyncHandler(async (_req, res) => {
  const password = crypto.randomBytes(18).toString("base64url");
  await saveConfigValues({ ENABLE_RCON: "true", RCON_PASSWORD: password });
  res.json({ ok: true, password, restartRequired: true });
}));

app.post("/api/server/:action", asyncHandler(async (req, res) => {
  const action = req.params.action;
  const { container, inspect } = await getMinecraftContainer();
  if (!container) throw new Error("没有找到 Minecraft 容器。请先用 Docker Compose 创建服务。");
  if (action === "start") {
    if (!inspect.State.Running) await container.start();
  } else if (action === "stop") {
    if (inspect.State.Running) await container.stop({ t: 120 });
  } else if (action === "restart") {
    if (inspect.State.Running) await container.restart({ t: 120 });
    else await container.start();
  } else {
    res.status(404).json({ error: "UNKNOWN_ACTION", message: "未知服务器操作。" });
    return;
  }
  res.json({ ok: true, action });
}));

app.get("/api/logs", asyncHandler(async (req, res) => {
  res.type("text/plain").send(await getLogTail(req.query.tail));
}));

app.post("/api/command", asyncHandler(async (req, res) => {
  const response = await sendRconCommand(req.body?.command);
  res.json({ ok: true, response });
}));

app.get("/api/mods", asyncHandler(async (_req, res) => {
  res.json({ mods: await listMods() });
}));

app.post("/api/mods/upload", upload.array("mods", 20), asyncHandler(async (req, res) => {
  await fsp.mkdir(MODS_DIR, { recursive: true });
  const uploaded = [];
  for (const file of req.files || []) {
    const name = safeModName(file.originalname);
    if (!name.endsWith(".jar")) {
      await fsp.rm(file.path, { force: true });
      throw new Error("上传文件必须是 .jar。");
    }
    const target = path.join(MODS_DIR, name);
    if ((await pathExists(target)) && req.body?.overwrite !== "true") {
      await fsp.rm(file.path, { force: true });
      throw new Error(`${name} 已存在。勾选覆盖后再上传。`);
    }
    await fsp.rename(file.path, target);
    uploaded.push(name);
  }
  res.json({ ok: true, uploaded, restartRequired: true });
}));

app.post("/api/mods/:name/toggle", asyncHandler(async (req, res) => {
  const name = safeModName(req.params.name);
  const source = path.join(MODS_DIR, name);
  if (!(await pathExists(source))) throw new Error("mod 文件不存在。");
  const targetName = name.endsWith(".disabled") ? name.replace(/\.disabled$/, "") : `${name}.disabled`;
  await fsp.rename(source, path.join(MODS_DIR, safeModName(targetName)));
  res.json({ ok: true, restartRequired: true });
}));

app.delete("/api/mods/:name", asyncHandler(async (req, res) => {
  const name = safeModName(req.params.name);
  await fsp.rm(path.join(MODS_DIR, name), { force: true });
  res.json({ ok: true, restartRequired: true });
}));

app.get("/api/backups", asyncHandler(async (_req, res) => {
  res.json({ backups: await listBackups() });
}));

app.post("/api/backups", asyncHandler(async (_req, res) => {
  res.json({ ok: true, backup: await createBackup() });
}));

app.get("/api/backups/:name/download", asyncHandler(async (req, res) => {
  const name = safeFileName(req.params.name);
  if (!name.endsWith(".tar.gz")) throw new Error("备份文件名不合法。");
  const filePath = path.join(BACKUP_DIR, name);
  if (!(await pathExists(filePath))) throw new Error("备份文件不存在。");
  res.download(filePath);
}));

app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: "1h" }));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({
    error: "REQUEST_FAILED",
    message: error.message || "请求失败。"
  });
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/ws/logs") || !getSession(req)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", async (ws) => {
  let stream = null;
  try {
    const { container, inspect } = await getMinecraftContainer();
    if (!container) {
      ws.send("没有找到 Minecraft 容器。\n");
      ws.close();
      return;
    }
    stream = await container.logs({
      stdout: true,
      stderr: true,
      follow: true,
      tail: 300,
      timestamps: false
    });
    if (inspect.Config.Tty) {
      stream.on("data", (chunk) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk.toString("utf8"));
      });
    } else {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on("data", (chunk) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk.toString("utf8"));
      });
      stderr.on("data", (chunk) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk.toString("utf8"));
      });
      docker.modem.demuxStream(stream, stdout, stderr);
    }
    stream.on("end", () => ws.close());
    stream.on("error", (error) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(`日志流错误：${error.message}\n`);
    });
  } catch (error) {
    if (ws.readyState === WebSocket.OPEN) ws.send(`日志流启动失败：${error.message}\n`);
    ws.close();
  }
  ws.on("close", () => {
    if (stream && typeof stream.destroy === "function") stream.destroy();
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt < now) sessions.delete(sessionId);
  }
}, 60 * 60 * 1000).unref();

server.listen(PANEL_PORT, "0.0.0.0", () => {
  console.log(`Utopia panel listening on 0.0.0.0:${PANEL_PORT}`);
  if (PANEL_PASSWORD === "change-me") {
    console.warn("PANEL_PASSWORD is still the default value. Change it before exposing the panel.");
  }
});
