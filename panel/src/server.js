"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { PassThrough, Readable } = require("stream");
const { pipeline } = require("stream/promises");

const {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const Docker = require("dockerode");
const express = require("express");
const multer = require("multer");
const { Rcon } = require("rcon-client");
const WebSocket = require("ws");

const execFileAsync = promisify(execFile);

const PANEL_PORT = Number(process.env.PANEL_PORT || 8080);
let panelPassword = process.env.PANEL_PASSWORD || "change-me";
const MINECRAFT_CONTAINER = process.env.MINECRAFT_CONTAINER || "utopia35-mc";
const DATA_DIR = process.env.DATA_DIR || "/data";
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
const COMPOSE_ENV_FILE = process.env.COMPOSE_ENV_FILE || path.join(WORKSPACE_DIR, ".env");
const RUNTIME_ENV_FILE = process.env.RUNTIME_ENV_FILE || path.join(DATA_DIR, "server.env");
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(WORKSPACE_DIR, "backups");
const EXAMPLE_ENV_FILE = process.env.EXAMPLE_ENV_FILE || path.join(WORKSPACE_DIR, ".env.example");
const PLAYER_USERS_FILE = process.env.PLAYER_USERS_FILE || path.join(DATA_DIR, "player-users.json");
const AUDIT_LOG_FILE = process.env.AUDIT_LOG_FILE || path.join(DATA_DIR, "audit-log.json");
const MODS_DIR = path.join(DATA_DIR, "mods");
const SERVER_PROPERTIES_FILE = path.join(DATA_DIR, "server.properties");
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const RCON_HOST = process.env.RCON_HOST || "minecraft";
const BLUEMAP_PORT = Number(process.env.BLUEMAP_PORT || 8100);
const BLUEMAP_HOST_PORT = String(process.env.BLUEMAP_HOST_PORT || BLUEMAP_PORT);
const BLUEMAP_PUBLIC_URL = process.env.BLUEMAP_PUBLIC_URL || "";
const BLUEMAP_INTERNAL_URL = process.env.BLUEMAP_INTERNAL_URL || `http://${RCON_HOST}:${BLUEMAP_PORT}`;
const BLUEMAP_GAME_VERSION = process.env.BLUEMAP_GAME_VERSION || "1.20.1";
const BLUEMAP_MODRINTH_API = "https://api.modrinth.com/v2/project/bluemap/version";
const BLUEMAP_PROJECT_URL = "https://modrinth.com/plugin/bluemap";
const PLAYER_AUTO_WHITELIST = envBool(process.env.PLAYER_AUTO_WHITELIST, false);
let scheduledBackupConfig = readScheduledBackupConfigFromEnv(process.env);
let remoteBackupConfig = readRemoteBackupConfigFromEnv(process.env);

const docker = new Docker({ socketPath: DOCKER_SOCKET });
const app = express();
const server = http.createServer(app);
const upload = multer({
  dest: "/tmp/utopia35-panel-uploads",
  limits: { fileSize: 1024 * 1024 * 1024, files: 20 }
});

const sessions = new Map();
const playerSessions = new Map();
const SESSION_COOKIE = "utopia35_panel";
const PLAYER_SESSION_COOKIE = "utopia35_player";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PLAYER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHAT_HISTORY_LIMIT = 200;
const AUDIT_LOG_LIMIT = 500;
const PLAYER_ACTION_COOLDOWN_MS = Number(process.env.PLAYER_ACTION_COOLDOWN_SECONDS || 60) * 1000;
const PLAYER_DAILY_KIT_COOLDOWN_MS = Number(process.env.PLAYER_DAILY_KIT_HOURS || 24) * 60 * 60 * 1000;
const PLAYER_DAILY_KIT_COMMANDS = (process.env.PLAYER_DAILY_KIT_COMMANDS || "give {player} minecraft:bread 16;give {player} minecraft:torch 16")
  .split(";")
  .map((command) => command.trim())
  .filter(Boolean);
const PLAYER_SPAWN_LOCATION = {
  dimension: normalizeMinecraftDimension(process.env.PLAYER_SPAWN_DIMENSION || "minecraft:overworld"),
  x: readCoordinate(process.env.PLAYER_SPAWN_X, 0),
  y: readCoordinate(process.env.PLAYER_SPAWN_Y, 80),
  z: readCoordinate(process.env.PLAYER_SPAWN_Z, 0)
};
const chatHistory = [];
const playerChatRate = new Map();
const scryptAsync = promisify(crypto.scrypt);

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
app.set("trust proxy", true);
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

function getPlayerSession(req) {
  const sessionId = parseCookies(req)[PLAYER_SESSION_COOKIE];
  if (!sessionId) return null;
  const session = playerSessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    playerSessions.delete(sessionId);
    return null;
  }
  session.expiresAt = Date.now() + PLAYER_SESSION_TTL_MS;
  return session;
}

function requirePlayerAuth(req, res, next) {
  const session = getPlayerSession(req);
  if (session) {
    req.playerSession = session;
    next();
    return;
  }
  res.status(401).json({ error: "PLAYER_NOT_AUTHENTICATED", message: "需要先登录玩家中心。" });
}

function setPlayerSessionCookie(res, sessionId) {
  const maxAge = Math.floor(PLAYER_SESSION_TTL_MS / 1000);
  res.setHeader("Set-Cookie", `${PLAYER_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearPlayerSessionCookie(res) {
  res.setHeader("Set-Cookie", `${PLAYER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function timingSafePasswordEqual(input) {
  const expected = Buffer.from(panelPassword);
  const actual = Buffer.from(String(input || ""));
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function isDefaultPanelPassword() {
  return panelPassword === "change-me";
}

function createPublicError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicCode = code;
  return error;
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

async function moveFileAcrossDevices(source, target) {
  try {
    await fsp.rename(source, target);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await fsp.copyFile(source, target);
    await fsp.rm(source, { force: true });
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

async function loadPanelPasswordFromEnv() {
  const values = await readEnvFile(COMPOSE_ENV_FILE);
  if (values.PANEL_PASSWORD) panelPassword = values.PANEL_PASSWORD;
  remoteBackupConfig = readRemoteBackupConfigFromEnv({ ...process.env, ...values });
  scheduledBackupConfig = readScheduledBackupConfigFromEnv({ ...process.env, ...values });
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

function normalizePanelPassword(value) {
  const password = String(value ?? "");
  if (password.length < 8) {
    throw createPublicError(400, "WEAK_PASSWORD", "新密码至少需要 8 个字符。");
  }
  if (/[\r\n\0]/.test(password)) {
    throw createPublicError(400, "BAD_PASSWORD_VALUE", "新密码不能包含换行或空字符。");
  }
  return password;
}

function normalizePlayerUsername(value) {
  const username = String(value || "").trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    throw createPublicError(400, "BAD_PLAYER_USERNAME", "账号只能包含 3-16 位字母、数字或下划线。");
  }
  return username;
}

function normalizeMinecraftName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    throw createPublicError(400, "BAD_MINECRAFT_NAME", "Minecraft 名称只能包含 3-16 位字母、数字或下划线。");
  }
  return name;
}

function normalizePlayerPassword(value) {
  const password = String(value ?? "");
  if (password.length < 8) {
    throw createPublicError(400, "WEAK_PLAYER_PASSWORD", "密码至少需要 8 个字符。");
  }
  if (/[\r\n\0]/.test(password)) {
    throw createPublicError(400, "BAD_PLAYER_PASSWORD", "密码不能包含换行或空字符。");
  }
  return password;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt:${salt}:${hash.toString("base64url")}`;
}

async function verifyPassword(password, storedHash) {
  const [scheme, salt, hash] = String(storedHash || "").split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scryptAsync(String(password || ""), salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function createEmptyPlayerStore() {
  return { version: 1, users: [] };
}

async function readPlayerStore() {
  try {
    const store = JSON.parse(await fsp.readFile(PLAYER_USERS_FILE, "utf8"));
    return {
      version: 1,
      users: Array.isArray(store.users) ? store.users : []
    };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return createEmptyPlayerStore();
    throw error;
  }
}

async function writePlayerStore(store) {
  await fsp.mkdir(path.dirname(PLAYER_USERS_FILE), { recursive: true });
  const tmp = `${PLAYER_USERS_FILE}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, PLAYER_USERS_FILE);
}

function createEmptyAuditStore() {
  return { version: 1, entries: [] };
}

async function readAuditStore() {
  try {
    const store = JSON.parse(await fsp.readFile(AUDIT_LOG_FILE, "utf8"));
    return {
      version: 1,
      entries: Array.isArray(store.entries) ? store.entries : []
    };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return createEmptyAuditStore();
    throw error;
  }
}

async function writeAuditStore(store) {
  await fsp.mkdir(path.dirname(AUDIT_LOG_FILE), { recursive: true });
  const tmp = `${AUDIT_LOG_FILE}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const entries = (store.entries || []).slice(-AUDIT_LOG_LIMIT);
  await fsp.writeFile(tmp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, AUDIT_LOG_FILE);
}

function sanitizeAuditValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.slice(0, 40).map(sanitizeAuditValue);
  if (typeof value === "object") {
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
      if (/password|secret|access.?key|token|credential/i.test(key)) {
        clean[key] = item ? "[redacted]" : "";
      } else {
        clean[key] = sanitizeAuditValue(item);
      }
    }
    return clean;
  }
  const text = String(value);
  return text.length > 500 ? `${text.slice(0, 500)}...` : value;
}

function sanitizeAuditCommand(command) {
  const text = String(command || "").trim().slice(0, 500);
  if (!/(password|secret|token|key)/i.test(text)) return text;
  return text.replace(/((?:password|secret|token|key)[^\\s=]*\\s*[= ]\\s*)[^\\s]+/gi, "$1[redacted]");
}

async function appendAuditLog(entry) {
  const store = await readAuditStore();
  store.entries.push({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    actorType: entry.actorType || "admin",
    actor: entry.actor || "面板",
    action: entry.action || "unknown",
    target: entry.target || "",
    ok: entry.ok !== false,
    detail: sanitizeAuditValue(entry.detail || {}),
    error: entry.error ? String(entry.error).slice(0, 500) : ""
  });
  await writeAuditStore(store);
}

async function safeAppendAuditLog(entry) {
  try {
    await appendAuditLog(entry);
  } catch (error) {
    console.warn(`[audit] unable to write audit log: ${error.message}`);
  }
}

async function listAuditLogs(limit = 120) {
  const store = await readAuditStore();
  const count = Math.max(1, Math.min(Number(limit) || 120, AUDIT_LOG_LIMIT));
  return store.entries.slice(-count).reverse();
}

async function withAudit(entry, task) {
  try {
    const result = await task();
    await safeAppendAuditLog({ ...entry, ok: true });
    return result;
  } catch (error) {
    await safeAppendAuditLog({ ...entry, ok: false, error: error.message });
    throw error;
  }
}

async function updatePlayerStore(mutator) {
  const store = await readPlayerStore();
  const result = await mutator(store);
  await writePlayerStore(store);
  return result;
}

function publicPlayerUser(user) {
  if (!user) return null;
  const now = Date.now();
  const lastDailyKitAt = user.lastDailyKitAt || "";
  const nextDailyKitAt = lastDailyKitAt ? new Date(new Date(lastDailyKitAt).getTime() + PLAYER_DAILY_KIT_COOLDOWN_MS).toISOString() : "";
  return {
    id: user.id,
    username: user.username,
    minecraftName: user.minecraftName || "",
    status: user.status || "active",
    role: user.role || "player",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || "",
    whitelistRequestedAt: user.whitelistRequestedAt || "",
    whitelistApprovedAt: user.whitelistApprovedAt || "",
    approvedBy: user.approvedBy || "",
    home: user.home || null,
    lastDailyKitAt,
    nextDailyKitAt,
    dailyKitAvailable: !lastDailyKitAt || new Date(lastDailyKitAt).getTime() + PLAYER_DAILY_KIT_COOLDOWN_MS <= now,
    note: user.note || ""
  };
}

async function findPlayerUserById(id) {
  const store = await readPlayerStore();
  return store.users.find((user) => user.id === id) || null;
}

async function getPlayerSessionUser(req) {
  const session = getPlayerSession(req);
  if (!session) return null;
  const user = await findPlayerUserById(session.userId);
  if (!user) {
    playerSessions.delete(parseCookies(req)[PLAYER_SESSION_COOKIE]);
    return null;
  }
  return user;
}

async function changePanelPassword({ currentPassword, newPassword }, currentSessionId) {
  if (!timingSafePasswordEqual(currentPassword)) {
    throw createPublicError(401, "BAD_PASSWORD", "当前密码不正确。");
  }
  const password = normalizePanelPassword(newPassword);
  if (timingSafePasswordEqual(password)) {
    throw createPublicError(400, "SAME_PASSWORD", "新密码不能和当前密码相同。");
  }
  await writeEnvFile(COMPOSE_ENV_FILE, { PANEL_PASSWORD: password }, { seedFrom: EXAMPLE_ENV_FILE });
  panelPassword = password;
  for (const sessionId of sessions.keys()) {
    if (sessionId !== currentSessionId) sessions.delete(sessionId);
  }
  return { defaultPassword: isDefaultPanelPassword() };
}

async function registerPlayerUser(payload = {}) {
  const username = normalizePlayerUsername(payload.username);
  const minecraftName = payload.minecraftName ? normalizeMinecraftName(payload.minecraftName) : "";
  const password = normalizePlayerPassword(payload.password);
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  return updatePlayerStore((store) => {
    if (store.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
      throw createPublicError(409, "PLAYER_USERNAME_EXISTS", "这个账号已经被注册。");
    }
    if (minecraftName && store.users.some((user) => String(user.minecraftName || "").toLowerCase() === minecraftName.toLowerCase())) {
      throw createPublicError(409, "MINECRAFT_NAME_EXISTS", "这个 Minecraft 名称已经被绑定。");
    }
    const user = {
      id: crypto.randomUUID(),
      username,
      minecraftName,
      passwordHash,
      role: "player",
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastLoginAt: "",
      whitelistRequestedAt: "",
      whitelistApprovedAt: "",
      approvedBy: "",
      home: null,
      lastActionAt: "",
      lastDailyKitAt: "",
      note: ""
    };
    store.users.push(user);
    return user;
  });
}

async function loginPlayerUser(payload = {}) {
  const username = normalizePlayerUsername(payload.username);
  const password = String(payload.password || "");
  let matched = null;
  const store = await readPlayerStore();
  for (const user of store.users) {
    if (user.username.toLowerCase() !== username.toLowerCase()) continue;
    matched = user;
    break;
  }
  if (!matched || !(await verifyPassword(password, matched.passwordHash))) {
    throw createPublicError(401, "BAD_PLAYER_LOGIN", "账号或密码不正确。");
  }
  if (matched.status === "disabled") {
    throw createPublicError(403, "PLAYER_DISABLED", "这个玩家账号已被禁用。");
  }
  const now = new Date().toISOString();
  await updatePlayerStore((mutableStore) => {
    const user = mutableStore.users.find((item) => item.id === matched.id);
    if (user) user.lastLoginAt = now;
  });
  return { ...matched, lastLoginAt: now };
}

async function updatePlayerMinecraftName(userId, minecraftNameInput) {
  const minecraftName = normalizeMinecraftName(minecraftNameInput);
  const now = new Date().toISOString();
  return updatePlayerStore((store) => {
    if (store.users.some((user) => user.id !== userId && String(user.minecraftName || "").toLowerCase() === minecraftName.toLowerCase())) {
      throw createPublicError(409, "MINECRAFT_NAME_EXISTS", "这个 Minecraft 名称已经被绑定。");
    }
    const user = store.users.find((item) => item.id === userId);
    if (!user) throw createPublicError(404, "PLAYER_NOT_FOUND", "玩家账号不存在。");
    user.minecraftName = minecraftName;
    user.updatedAt = now;
    if (!user.status || user.status === "unbound" || user.status === "pending") user.status = "active";
    return user;
  });
}

async function approvePlayerWhitelist(userId, approvedBy = "panel") {
  const now = new Date().toISOString();
  let approvedUser = null;
  await updatePlayerStore((store) => {
    const user = store.users.find((item) => item.id === userId);
    if (!user) throw createPublicError(404, "PLAYER_NOT_FOUND", "玩家账号不存在。");
    if (!user.minecraftName) throw createPublicError(400, "PLAYER_NOT_BOUND", "玩家还没有绑定 Minecraft 名称。");
    user.status = "approved";
    user.whitelistApprovedAt = now;
    user.updatedAt = now;
    user.approvedBy = approvedBy;
    approvedUser = user;
  });
  try {
    await sendRconCommand(`whitelist add ${approvedUser.minecraftName}`);
  } catch (error) {
    await updatePlayerStore((store) => {
      const user = store.users.find((item) => item.id === userId);
      if (!user) return;
      user.status = "pending";
      user.note = `白名单命令执行失败：${error.message}`;
      user.updatedAt = new Date().toISOString();
    });
    throw error;
  }
  return approvedUser;
}

async function requestPlayerWhitelist(userId) {
  const now = new Date().toISOString();
  return updatePlayerStore((store) => {
    const user = store.users.find((item) => item.id === userId);
    if (!user) throw createPublicError(404, "PLAYER_NOT_FOUND", "玩家账号不存在。");
    if (!user.minecraftName) throw createPublicError(400, "PLAYER_NOT_BOUND", "请先绑定 Minecraft 名称。");
    if (user.status === "approved") return user;
    user.status = "pending";
    user.whitelistRequestedAt = now;
    user.updatedAt = now;
    user.note = "";
    return user;
  });
}

async function rejectPlayerUser(userId, note = "") {
  const now = new Date().toISOString();
  return updatePlayerStore((store) => {
    const user = store.users.find((item) => item.id === userId);
    if (!user) throw createPublicError(404, "PLAYER_NOT_FOUND", "玩家账号不存在。");
    user.status = "rejected";
    user.note = String(note || "").trim().slice(0, 160);
    user.updatedAt = now;
    return user;
  });
}

async function deletePlayerUser(userId) {
  await updatePlayerStore((store) => {
    const index = store.users.findIndex((item) => item.id === userId);
    if (index === -1) throw createPublicError(404, "PLAYER_NOT_FOUND", "玩家账号不存在。");
    store.users.splice(index, 1);
  });
  for (const [sessionId, session] of playerSessions.entries()) {
    if (session.userId === userId) playerSessions.delete(sessionId);
  }
  return { id: userId };
}

function requireBoundPlayer(user) {
  if (!user?.minecraftName) {
    throw createPublicError(400, "PLAYER_NOT_BOUND", "请先绑定 Minecraft 名称。");
  }
  return user.minecraftName;
}

function assertPlayerActionCooldown(user) {
  const lastActionAt = user.lastActionAt ? new Date(user.lastActionAt).getTime() : 0;
  const remaining = PLAYER_ACTION_COOLDOWN_MS - (Date.now() - lastActionAt);
  if (remaining > 0) {
    throw createPublicError(429, "PLAYER_ACTION_COOLDOWN", `操作冷却中，请 ${Math.ceil(remaining / 1000)} 秒后再试。`);
  }
}

async function markPlayerAction(userId) {
  const now = new Date().toISOString();
  await updatePlayerStore((store) => {
    const user = store.users.find((item) => item.id === userId);
    if (user) user.lastActionAt = now;
  });
}

function parseDataGetVector(response) {
  const match = String(response || "").match(/\[([^\]]+)\]/);
  if (!match) return null;
  const values = match[1]
    .split(",")
    .map((part) => Number(String(part).replace(/[dfl]/gi, "").trim()));
  if (values.length < 3 || values.some((value) => !Number.isFinite(value))) return null;
  return { x: values[0], y: values[1], z: values[2] };
}

function parseDataGetString(response) {
  const match = String(response || "").match(/has the following entity data:\s*"([^"]+)"/i);
  return match?.[1] || "";
}

function parseDataGetNumber(response) {
  const text = String(response || "");
  const quoted = text.match(/has the following entity data:\s*"?(-?\d+(?:\.\d+)?)(?:[bdfsli])?"?/i);
  if (quoted) return Number(quoted[1]);
  const fallback = text.match(/(-?\d+(?:\.\d+)?)(?:[bdfsli])?\s*$/i);
  return fallback ? Number(fallback[1]) : null;
}

function splitTopLevelList(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const items = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (char === quote && prev !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      items.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) items.push(last);
  return items;
}

function parseNbtListPayload(response) {
  const text = String(response || "");
  const marker = "has the following entity data:";
  const markerIndex = text.lastIndexOf(marker);
  const payload = markerIndex === -1 ? text : text.slice(markerIndex + marker.length);
  const start = payload.indexOf("[");
  const end = payload.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return "";
  return payload.slice(start + 1, end);
}

function readNbtString(item, key) {
  const quoted = item.match(new RegExp(`${key}:\\s*"([^"]*)"`));
  if (quoted) return quoted[1];
  const unquoted = item.match(new RegExp(`${key}:\\s*([^,}]+)`));
  return unquoted ? unquoted[1].trim().replace(/[bdfsli]$/i, "") : "";
}

function readNbtNumber(item, key) {
  const raw = readNbtString(item, key);
  if (raw === "") return null;
  const number = Number(String(raw).replace(/[bdfsli]$/i, ""));
  return Number.isFinite(number) ? number : null;
}

function parseInventoryResponse(response) {
  return splitTopLevelList(parseNbtListPayload(response))
    .map((item) => ({
      id: readNbtString(item, "id"),
      count: readNbtNumber(item, "count") ?? readNbtNumber(item, "Count") ?? 0,
      slot: readNbtNumber(item, "Slot"),
      raw: item
    }))
    .filter((item) => item.id)
    .sort((a, b) => (a.slot ?? 999) - (b.slot ?? 999));
}

function formatCoord(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

function readCoordinate(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeMinecraftDimension(value) {
  const dimension = String(value || "").trim().toLowerCase();
  if (dimension === "overworld" || dimension === "nether" || dimension === "end") {
    return `minecraft:${dimension === "nether" ? "the_nether" : dimension === "end" ? "the_end" : "overworld"}`;
  }
  if (/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(dimension)) return dimension;
  return "minecraft:overworld";
}

async function getPlayerLocation(playerName) {
  const [posResponse, dimensionResponse] = await Promise.all([
    sendCheckedRconCommand(`data get entity ${playerName} Pos`, "读取玩家坐标失败。"),
    sendCheckedRconCommand(`data get entity ${playerName} Dimension`, "读取玩家维度失败。")
  ]);
  const pos = parseDataGetVector(posResponse);
  const dimension = parseDataGetString(dimensionResponse);
  if (!pos || !dimension) {
    throw createPublicError(400, "PLAYER_LOCATION_UNAVAILABLE", "读取玩家位置失败，请确认玩家当前在线。");
  }
  return { ...pos, dimension };
}

async function getPlayerDetail(playerNameInput) {
  const playerName = normalizeMinecraftName(playerNameInput);
  const posResponse = await sendCheckedRconCommand(`data get entity ${playerName} Pos`, "读取玩家坐标失败，请确认玩家在线。");
  const dimensionResponse = await sendCheckedRconCommand(`data get entity ${playerName} Dimension`, "读取玩家维度失败，请确认玩家在线。");
  const healthResponse = await sendCheckedRconCommand(`data get entity ${playerName} Health`, "读取玩家生命值失败，请确认玩家在线。");
  const foodResponse = await sendCheckedRconCommand(`data get entity ${playerName} foodLevel`, "读取玩家饥饿值失败，请确认玩家在线。");
  const xpResponse = await sendCheckedRconCommand(`data get entity ${playerName} XpLevel`, "读取玩家经验等级失败，请确认玩家在线。");
  const selectedSlotResponse = await sendCheckedRconCommand(`data get entity ${playerName} SelectedItemSlot`, "读取玩家手持栏失败，请确认玩家在线。");
  const inventoryResponse = await sendCheckedRconCommand(`data get entity ${playerName} Inventory`, "读取玩家背包失败，请确认玩家在线。");
  const enderItemsResponse = await sendCheckedRconCommand(`data get entity ${playerName} EnderItems`, "读取玩家末影箱失败，请确认玩家在线。");
  const location = {
    ...(parseDataGetVector(posResponse) || { x: null, y: null, z: null }),
    dimension: parseDataGetString(dimensionResponse)
  };
  const inventory = parseInventoryResponse(inventoryResponse);
  const selectedSlot = parseDataGetNumber(selectedSlotResponse);
  const selectedItem = inventory.find((item) => item.slot === selectedSlot) || null;
  return {
    name: playerName,
    location,
    health: parseDataGetNumber(healthResponse),
    foodLevel: parseDataGetNumber(foodResponse),
    xpLevel: parseDataGetNumber(xpResponse),
    selectedSlot,
    selectedItem,
    inventory,
    enderItems: parseInventoryResponse(enderItemsResponse),
    raw: {
      inventory: inventoryResponse,
      enderItems: enderItemsResponse
    }
  };
}

async function setPlayerHome(userId) {
  const user = await findPlayerUserById(userId);
  const playerName = requireBoundPlayer(user);
  assertPlayerActionCooldown(user);
  const home = await getPlayerLocation(playerName);
  const now = new Date().toISOString();
  const updated = await updatePlayerStore((store) => {
    const item = store.users.find((entry) => entry.id === userId);
    if (!item) throw createPublicError(404, "PLAYER_NOT_FOUND", "玩家账号不存在。");
    item.home = home;
    item.lastActionAt = now;
    item.updatedAt = now;
    return item;
  });
  return updated;
}

async function teleportPlayerToLocation(user, location, label) {
  const playerName = requireBoundPlayer(user);
  assertPlayerActionCooldown(user);
  await sendCheckedRconCommand(`execute in ${location.dimension} run tp ${playerName} ${formatCoord(location.x)} ${formatCoord(location.y)} ${formatCoord(location.z)}`, "传送失败，请确认玩家在线。");
  await markPlayerAction(user.id);
  return { label, location };
}

async function teleportPlayerHome(userId) {
  const user = await findPlayerUserById(userId);
  if (!user?.home) {
    throw createPublicError(400, "PLAYER_HOME_NOT_SET", "你还没有设置 home。");
  }
  return teleportPlayerToLocation(user, user.home, "home");
}

async function teleportPlayerSpawn(userId) {
  const user = await findPlayerUserById(userId);
  return teleportPlayerToLocation(user, PLAYER_SPAWN_LOCATION, "spawn");
}

async function rescuePlayer(userId) {
  const user = await findPlayerUserById(userId);
  const playerName = requireBoundPlayer(user);
  assertPlayerActionCooldown(user);
  await sendCheckedRconCommand(`effect give ${playerName} minecraft:resistance 10 4 true`, "自救失败，请确认玩家在线。");
  await sendCheckedRconCommand(`effect give ${playerName} minecraft:slow_falling 20 0 true`, "自救失败，请确认玩家在线。");
  await sendCheckedRconCommand(`tp ${playerName} ~ 120 ~`, "自救失败，请确认玩家在线。");
  await markPlayerAction(user.id);
  return { label: "rescue" };
}

async function claimDailyKit(userId) {
  const user = await findPlayerUserById(userId);
  const playerName = requireBoundPlayer(user);
  const lastDailyKitAt = user.lastDailyKitAt ? new Date(user.lastDailyKitAt).getTime() : 0;
  const remaining = PLAYER_DAILY_KIT_COOLDOWN_MS - (Date.now() - lastDailyKitAt);
  if (remaining > 0) {
    throw createPublicError(429, "PLAYER_DAILY_KIT_COOLDOWN", `每日礼包还没刷新，请 ${Math.ceil(remaining / 60 / 60 / 1000)} 小时后再试。`);
  }
  for (const command of PLAYER_DAILY_KIT_COMMANDS) {
    await sendCheckedRconCommand(command.replaceAll("{player}", playerName), "礼包发放失败，请确认玩家在线。");
  }
  const now = new Date().toISOString();
  const updated = await updatePlayerStore((store) => {
    const item = store.users.find((entry) => entry.id === userId);
    if (!item) throw createPublicError(404, "PLAYER_NOT_FOUND", "玩家账号不存在。");
    item.lastDailyKitAt = now;
    item.updatedAt = now;
    return item;
  });
  return updated;
}

function envBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
}

function normalizeRemotePrefix(value) {
  const prefix = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!prefix) return "";
  const segments = prefix.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))) {
    throw createPublicError(400, "BAD_REMOTE_PREFIX", "远端备份路径前缀不合法。");
  }
  return segments.join("/");
}

function readRemoteBackupConfigFromEnv(source) {
  let prefix = "";
  try {
    prefix = normalizeRemotePrefix(source.REMOTE_BACKUP_PREFIX);
  } catch {
    prefix = "";
  }
  const endpoint = String(source.REMOTE_BACKUP_ENDPOINT || "").trim();
  const region = String(source.REMOTE_BACKUP_REGION || "").trim() || (endpoint ? "auto" : "us-east-1");
  const config = {
    enabled: envBool(source.REMOTE_BACKUP_ENABLED, false),
    endpoint,
    region,
    bucket: String(source.REMOTE_BACKUP_BUCKET || "").trim(),
    prefix,
    accessKeyId: String(source.REMOTE_BACKUP_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: String(source.REMOTE_BACKUP_SECRET_ACCESS_KEY || ""),
    forcePathStyle: envBool(source.REMOTE_BACKUP_FORCE_PATH_STYLE, Boolean(endpoint)),
    autoUpload: envBool(source.REMOTE_BACKUP_AUTO_UPLOAD, false)
  };
  config.configured = Boolean(config.bucket && config.accessKeyId && config.secretAccessKey);
  return config;
}

function normalizeTimeOfDay(value, fallback = "04:30") {
  const time = String(value || "").trim() || fallback;
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
    throw createPublicError(400, "BAD_BACKUP_TIME", "定时备份时间格式必须是 HH:MM。");
  }
  return time;
}

function normalizeWeekday(value, fallback = 0) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 0 || day > 6) return fallback;
  return day;
}

function normalizeRetention(value, fallback = 7) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 200) return fallback;
  return count;
}

function readScheduledBackupConfigFromEnv(source) {
  return {
    enabled: envBool(source.SCHEDULED_BACKUP_ENABLED, false),
    time: normalizeTimeOfDay(source.SCHEDULED_BACKUP_TIME, "04:30"),
    includeMigrationWeekly: envBool(source.SCHEDULED_BACKUP_MIGRATION_WEEKLY, false),
    migrationWeekday: normalizeWeekday(source.SCHEDULED_BACKUP_MIGRATION_WEEKDAY, 0),
    keepLocal: normalizeRetention(source.SCHEDULED_BACKUP_KEEP_LOCAL, 7),
    uploadRemote: envBool(source.SCHEDULED_BACKUP_UPLOAD_REMOTE, false),
    lastWorldRunKey: String(source.SCHEDULED_BACKUP_LAST_WORLD_RUN || ""),
    lastMigrationRunKey: String(source.SCHEDULED_BACKUP_LAST_MIGRATION_RUN || "")
  };
}

function publicScheduledBackupConfig(config = scheduledBackupConfig) {
  return {
    enabled: config.enabled,
    time: config.time,
    includeMigrationWeekly: config.includeMigrationWeekly,
    migrationWeekday: config.migrationWeekday,
    keepLocal: config.keepLocal,
    uploadRemote: config.uploadRemote,
    lastWorldRunKey: config.lastWorldRunKey,
    lastMigrationRunKey: config.lastMigrationRunKey
  };
}

function normalizeScheduledBackupPayload(payload = {}) {
  return {
    enabled: Boolean(payload.enabled),
    time: normalizeTimeOfDay(payload.time, scheduledBackupConfig.time || "04:30"),
    includeMigrationWeekly: Boolean(payload.includeMigrationWeekly),
    migrationWeekday: normalizeWeekday(payload.migrationWeekday, scheduledBackupConfig.migrationWeekday || 0),
    keepLocal: normalizeRetention(payload.keepLocal, scheduledBackupConfig.keepLocal || 7),
    uploadRemote: Boolean(payload.uploadRemote),
    lastWorldRunKey: scheduledBackupConfig.lastWorldRunKey || "",
    lastMigrationRunKey: scheduledBackupConfig.lastMigrationRunKey || ""
  };
}

async function saveScheduledBackupConfig(payload) {
  const config = normalizeScheduledBackupPayload(payload);
  await writeEnvFile(COMPOSE_ENV_FILE, {
    SCHEDULED_BACKUP_ENABLED: config.enabled ? "true" : "false",
    SCHEDULED_BACKUP_TIME: config.time,
    SCHEDULED_BACKUP_MIGRATION_WEEKLY: config.includeMigrationWeekly ? "true" : "false",
    SCHEDULED_BACKUP_MIGRATION_WEEKDAY: String(config.migrationWeekday),
    SCHEDULED_BACKUP_KEEP_LOCAL: String(config.keepLocal),
    SCHEDULED_BACKUP_UPLOAD_REMOTE: config.uploadRemote ? "true" : "false"
  }, { seedFrom: EXAMPLE_ENV_FILE });
  scheduledBackupConfig = config;
  return publicScheduledBackupConfig(config);
}

function publicRemoteBackupConfig(config = remoteBackupConfig) {
  return {
    enabled: config.enabled,
    configured: config.configured,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    prefix: config.prefix,
    forcePathStyle: config.forcePathStyle,
    autoUpload: config.autoUpload,
    accessKeyIdConfigured: Boolean(config.accessKeyId),
    secretAccessKeyConfigured: Boolean(config.secretAccessKey)
  };
}

function normalizeRemoteConfigPayload(payload = {}) {
  const previous = remoteBackupConfig;
  const accessKeyIdInput = String(payload.accessKeyId ?? "").trim();
  const secretAccessKeyInput = String(payload.secretAccessKey ?? "");
  const endpoint = String(payload.endpoint ?? "").trim();
  const region = String(payload.region ?? "").trim() || (endpoint ? "auto" : "us-east-1");
  const config = {
    enabled: Boolean(payload.enabled),
    endpoint,
    region,
    bucket: String(payload.bucket ?? "").trim(),
    prefix: normalizeRemotePrefix(payload.prefix),
    accessKeyId: accessKeyIdInput || previous.accessKeyId,
    secretAccessKey: secretAccessKeyInput || previous.secretAccessKey,
    forcePathStyle: Boolean(payload.forcePathStyle),
    autoUpload: Boolean(payload.autoUpload)
  };
  if (config.enabled && !config.bucket) {
    throw createPublicError(400, "REMOTE_BUCKET_REQUIRED", "启用远端备份前需要填写 bucket。");
  }
  if (config.enabled && (!config.accessKeyId || !config.secretAccessKey)) {
    throw createPublicError(400, "REMOTE_CREDENTIALS_REQUIRED", "启用远端备份前需要填写访问密钥。");
  }
  config.configured = Boolean(config.bucket && config.accessKeyId && config.secretAccessKey);
  return config;
}

async function saveRemoteBackupConfig(payload) {
  const config = normalizeRemoteConfigPayload(payload);
  await writeEnvFile(COMPOSE_ENV_FILE, {
    REMOTE_BACKUP_ENABLED: config.enabled ? "true" : "false",
    REMOTE_BACKUP_ENDPOINT: config.endpoint,
    REMOTE_BACKUP_REGION: config.region,
    REMOTE_BACKUP_BUCKET: config.bucket,
    REMOTE_BACKUP_PREFIX: config.prefix,
    REMOTE_BACKUP_ACCESS_KEY_ID: config.accessKeyId,
    REMOTE_BACKUP_SECRET_ACCESS_KEY: config.secretAccessKey,
    REMOTE_BACKUP_FORCE_PATH_STYLE: config.forcePathStyle ? "true" : "false",
    REMOTE_BACKUP_AUTO_UPLOAD: config.autoUpload ? "true" : "false"
  }, { seedFrom: EXAMPLE_ENV_FILE });
  process.env.REMOTE_BACKUP_ENABLED = config.enabled ? "true" : "false";
  process.env.REMOTE_BACKUP_ENDPOINT = config.endpoint;
  process.env.REMOTE_BACKUP_REGION = config.region;
  process.env.REMOTE_BACKUP_BUCKET = config.bucket;
  process.env.REMOTE_BACKUP_PREFIX = config.prefix;
  process.env.REMOTE_BACKUP_ACCESS_KEY_ID = config.accessKeyId;
  process.env.REMOTE_BACKUP_SECRET_ACCESS_KEY = config.secretAccessKey;
  process.env.REMOTE_BACKUP_FORCE_PATH_STYLE = config.forcePathStyle ? "true" : "false";
  process.env.REMOTE_BACKUP_AUTO_UPLOAD = config.autoUpload ? "true" : "false";
  remoteBackupConfig = config;
  return publicRemoteBackupConfig(config);
}

function requireRemoteBackupConfig() {
  if (!remoteBackupConfig.enabled) {
    throw createPublicError(400, "REMOTE_BACKUP_DISABLED", "远端备份尚未启用。");
  }
  if (!remoteBackupConfig.configured) {
    throw createPublicError(400, "REMOTE_BACKUP_NOT_CONFIGURED", "远端备份配置不完整。");
  }
  return remoteBackupConfig;
}

function createS3Client(config = requireRemoteBackupConfig()) {
  return new S3Client({
    region: config.region || "us-east-1",
    endpoint: config.endpoint || undefined,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}

function makeRemoteBackupKey(name, config = requireRemoteBackupConfig()) {
  const safeName = safeFileName(name);
  return config.prefix ? `${config.prefix}/${safeName}` : safeName;
}

function getRemoteSidecarKey(key) {
  return key.replace(/\.tar\.gz$/i, ".json");
}

function normalizeRemoteObjectKey(value, config = requireRemoteBackupConfig()) {
  const key = String(value || "").trim().replace(/^\/+/, "");
  if (!key || !key.endsWith(".tar.gz") || key.includes("\0")) {
    throw createPublicError(400, "BAD_REMOTE_KEY", "远端备份路径不合法。");
  }
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    throw createPublicError(400, "BAD_REMOTE_KEY", "远端备份路径不合法。");
  }
  if (config.prefix && !key.startsWith(`${config.prefix}/`)) {
    throw createPublicError(400, "REMOTE_KEY_OUTSIDE_PREFIX", "只能管理当前前缀下的远端备份。");
  }
  return key;
}

function inferBackupTypeFromKey(key) {
  return inferBackupType(path.posix.basename(key));
}

async function testRemoteBackupConnection(payload = null) {
  const config = payload ? normalizeRemoteConfigPayload(payload) : requireRemoteBackupConfig();
  if (!config.configured) {
    throw createPublicError(400, "REMOTE_BACKUP_NOT_CONFIGURED", "远端备份配置不完整。");
  }
  const client = createS3Client(config);
  await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
  return publicRemoteBackupConfig(config);
}

async function listRemoteBackups() {
  const config = requireRemoteBackupConfig();
  const client = createS3Client(config);
  const prefix = config.prefix ? `${config.prefix}/` : "";
  const backups = [];
  let continuationToken = undefined;
  do {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 100
    }));
    for (const item of result.Contents || []) {
      if (!item.Key?.endsWith(".tar.gz")) continue;
      const name = path.posix.basename(item.Key);
      const type = inferBackupTypeFromKey(item.Key);
      backups.push({
        key: item.Key,
        name,
        size: item.Size || 0,
        uploadedAt: item.LastModified ? item.LastModified.toISOString() : null,
        type,
        label: BACKUP_TYPE_META[type]?.label || "备份",
        description: BACKUP_TYPE_META[type]?.description || "",
        local: await pathExists(path.join(BACKUP_DIR, safeFileName(name)))
      });
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken && backups.length < 500);
  return backups.sort((a, b) => String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || "")));
}

async function uploadObjectToRemote({ key, filePath, contentType }) {
  const config = requireRemoteBackupConfig();
  const client = createS3Client(config);
  const stat = await fsp.stat(filePath);
  const uploadTask = new Upload({
    client,
    params: {
      Bucket: config.bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentLength: stat.size,
      ContentType: contentType
    }
  });
  await uploadTask.done();
}

async function uploadBackupToRemote(name) {
  const safeName = safeFileName(name);
  if (!safeName.endsWith(".tar.gz")) throw createPublicError(400, "BAD_BACKUP_NAME", "备份文件名不合法。");
  const filePath = path.join(BACKUP_DIR, safeName);
  if (!(await pathExists(filePath))) throw createPublicError(404, "BACKUP_NOT_FOUND", "备份文件不存在。");
  const key = makeRemoteBackupKey(safeName);
  await uploadObjectToRemote({ key, filePath, contentType: "application/gzip" });
  const sidecarPath = getBackupSidecarPath(filePath);
  const sidecar = { key };
  if (await pathExists(sidecarPath)) {
    sidecar.sidecarKey = getRemoteSidecarKey(key);
    await uploadObjectToRemote({ key: sidecar.sidecarKey, filePath: sidecarPath, contentType: "application/json; charset=utf-8" });
  }
  return sidecar;
}

async function downloadRemoteObject(key, targetPath) {
  const config = requireRemoteBackupConfig();
  const client = createS3Client(config);
  const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await pipeline(result.Body, fs.createWriteStream(targetPath));
}

async function importRemoteBackup(key, options = {}) {
  const normalizedKey = normalizeRemoteObjectKey(key);
  const name = safeFileName(path.posix.basename(normalizedKey));
  const target = path.join(BACKUP_DIR, name);
  if ((await pathExists(target)) && !options.overwrite) {
    throw createPublicError(409, "BACKUP_ALREADY_EXISTS", "本地已经有同名备份。");
  }
  const tmp = path.join(BACKUP_DIR, `.download-${crypto.randomBytes(6).toString("hex")}-${name}`);
  const tmpSidecar = getBackupSidecarPath(tmp);
  try {
    await downloadRemoteObject(normalizedKey, tmp);
    await fsp.rename(tmp, target);
    try {
      await downloadRemoteObject(getRemoteSidecarKey(normalizedKey), tmpSidecar);
      await fsp.rename(tmpSidecar, getBackupSidecarPath(target));
    } catch (error) {
      await fsp.rm(tmpSidecar, { force: true }).catch(() => {});
      if (error.name !== "NoSuchKey" && error.$metadata?.httpStatusCode !== 404) throw error;
    }
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    await fsp.rm(tmpSidecar, { force: true }).catch(() => {});
    throw error;
  }
  const stat = await fsp.stat(target);
  return {
    name,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    type: inferBackupType(name),
    importedFrom: normalizedKey
  };
}

async function deleteRemoteBackup(key) {
  const config = requireRemoteBackupConfig();
  const normalizedKey = normalizeRemoteObjectKey(key, config);
  const client = createS3Client(config);
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: normalizedKey }));
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: getRemoteSidecarKey(normalizedKey) })).catch(() => {});
  return { key: normalizedKey };
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

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("请求超时。")), ms);
    })
  ]);
}

async function readContainerStats(container, inspect) {
  if (!container || !inspect?.State?.Running) return null;
  try {
    const stats = await withTimeout(container.stats({ stream: false }), 2500);
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

function getBlueMapMod(mods) {
  return mods.find((mod) => /^bluemap-.*\.jar$/i.test(mod.name) || /^bluemap-.*\.jar\.disabled$/i.test(mod.name)) || null;
}

function getExternalBlueMapUrl(req) {
  if (BLUEMAP_PUBLIC_URL) return BLUEMAP_PUBLIC_URL.replace(/\/+$/, "");
  return "/bluemap/";
}

function appendBlueMapHash(url, hash) {
  if (!hash || url.includes("#")) return url;
  return `${url}${hash}`;
}

async function readJsonFile(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function directoryHasFiles(dirPath, maxDepth = 5) {
  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && maxDepth > 0 && (await directoryHasFiles(path.join(dirPath, entry.name), maxDepth - 1))) {
      return true;
    }
  }
  return false;
}

async function getPreferredBlueMapHash(webRoot) {
  let settings;
  try {
    settings = await readJsonFile(path.join(webRoot, "settings.json"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return "";
    throw error;
  }

  const mapIds = Array.isArray(settings.maps) ? settings.maps.filter(Boolean).map(String) : [];
  if (mapIds.length === 0) return "";

  const mapsWithTiles = [];
  for (const mapId of mapIds) {
    const mapDir = path.join(webRoot, "maps", mapId);
    if (await directoryHasFiles(path.join(mapDir, "tiles"))) {
      let mapSettings = {};
      try {
        mapSettings = await readJsonFile(path.join(mapDir, "settings.json"));
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      mapsWithTiles.push({ id: mapId, settings: mapSettings });
    }
  }

  const preferred = mapsWithTiles.find((map) => map.id === "world") || mapsWithTiles[0];
  if (!preferred) return "";

  const startPos = preferred.settings.startPos;
  const x = Array.isArray(startPos) ? Number(startPos[0] || 0) : Number(startPos?.x || 0);
  const z = Array.isArray(startPos) ? Number(startPos[1] || 0) : Number(startPos?.z || 0);
  return `#${preferred.id}:${Math.round(x)}:0:${Math.round(z)}:1500:0:0:0:1:flat`;
}

async function fetchBlueMapVersion() {
  const url = new URL(BLUEMAP_MODRINTH_API);
  url.searchParams.set("loaders", JSON.stringify(["fabric"]));
  url.searchParams.set("game_versions", JSON.stringify([BLUEMAP_GAME_VERSION]));
  const response = await fetch(url, {
    headers: { "User-Agent": "utopia35-mc-panel/0.1" }
  });
  if (!response.ok) {
    throw new Error(`获取 BlueMap 版本失败：${response.status}`);
  }
  const versions = await response.json();
  const version = versions[0];
  const file = version?.files?.find((item) => item.primary) || version?.files?.[0];
  if (!version || !file?.url || !file?.filename) {
    throw new Error(`没有找到适用于 Fabric ${BLUEMAP_GAME_VERSION} 的 BlueMap 版本。`);
  }
  return {
    name: version.name,
    version: version.version_number,
    filename: safeModName(file.filename),
    url: file.url,
    size: file.size,
    sha1: file.hashes?.sha1 || ""
  };
}

async function installBlueMapMod() {
  const mods = await listMods();
  const existing = getBlueMapMod(mods);
  if (existing?.enabled) {
    return { installed: false, mod: existing, message: "BlueMap 已安装。" };
  }
  if (existing && !existing.enabled) {
    const source = path.join(MODS_DIR, existing.name);
    const targetName = existing.name.replace(/\.disabled$/i, "");
    await fsp.rename(source, path.join(MODS_DIR, safeModName(targetName)));
    return { installed: false, mod: { name: targetName, enabled: true }, message: "BlueMap 已启用。" };
  }
  const version = await fetchBlueMapVersion();
  const target = path.join(MODS_DIR, version.filename);
  if (await pathExists(target)) {
    return { installed: false, mod: { name: version.filename, enabled: true }, version, message: "BlueMap 已安装。" };
  }
  const response = await fetch(version.url, {
    headers: { "User-Agent": "utopia35-mc-panel/0.1" }
  });
  if (!response.ok) {
    throw new Error(`下载 BlueMap 失败：${response.status}`);
  }
  const tempFile = path.join(MODS_DIR, `.${crypto.randomBytes(8).toString("hex")}-${version.filename}.tmp`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (version.size && buffer.length !== version.size) {
    throw new Error("BlueMap 下载大小不匹配。");
  }
  await fsp.writeFile(tempFile, buffer);
  await fsp.rename(tempFile, target);
  return { installed: true, mod: { name: version.filename, enabled: true, size: buffer.length }, version };
}

async function checkHttpOk(url) {
  try {
    const response = await withTimeout(fetch(url, { method: "GET" }), 2500);
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

function copyProxyHeaders(sourceHeaders, res) {
  const blocked = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]);
  sourceHeaders.forEach((value, key) => {
    if (!blocked.has(key.toLowerCase())) res.setHeader(key, value);
  });
}

async function proxyBlueMapRequest(req, res) {
  if (!["GET", "HEAD"].includes(req.method)) {
    res.status(405).json({ error: "METHOD_NOT_ALLOWED", message: "BlueMap 代理只支持 GET/HEAD。" });
    return;
  }
  const pathAndQuery = req.originalUrl.slice("/bluemap".length) || "/";
  if (pathAndQuery.startsWith("//")) {
    res.status(400).json({ error: "BAD_BLUEMAP_PATH", message: "BlueMap 路径不合法。" });
    return;
  }
  const target = new URL(pathAndQuery, BLUEMAP_INTERNAL_URL.replace(/\/+$/, "") + "/");
  const headers = {
    "Accept": req.get("accept") || "*/*",
    "Accept-Encoding": "identity",
    "User-Agent": "utopia35-mc-panel/0.1"
  };
  if (req.get("range")) headers.Range = req.get("range");
  const response = await fetch(target, { method: req.method === "HEAD" ? "GET" : req.method, headers });
  res.status(response.status);
  copyProxyHeaders(response.headers, res);
  res.setHeader("X-BlueMap-Proxy", "utopia35-panel");
  if (req.method === "HEAD") {
    if (response.body) await response.body.cancel().catch(() => {});
    res.end();
    return;
  }
  if (!response.body) {
    res.end();
    return;
  }
  Readable.fromWeb(response.body).pipe(res);
}

async function getBlueMapStatus(req) {
  const mods = await listMods();
  const mod = getBlueMapMod(mods);
  const configDir = path.join(DATA_DIR, "config", "bluemap");
  const webRoot = path.join(DATA_DIR, "bluemap", "web");
  const mapHash = await getPreferredBlueMapHash(webRoot);
  const mapUrl = appendBlueMapHash(getExternalBlueMapUrl(req), mapHash);
  return {
    installed: Boolean(mod),
    enabled: Boolean(mod?.enabled),
    modName: mod?.name || "",
    gameVersion: BLUEMAP_GAME_VERSION,
    mapUrl,
    mapHash,
    proxied: !BLUEMAP_PUBLIC_URL,
    internalUrl: BLUEMAP_INTERNAL_URL,
    port: BLUEMAP_PORT,
    hostPort: BLUEMAP_HOST_PORT,
    projectUrl: BLUEMAP_PROJECT_URL,
    configDir,
    webRoot,
    configExists: await pathExists(configDir),
    webRootExists: await pathExists(webRoot),
    reachable: await checkHttpOk(BLUEMAP_INTERNAL_URL)
  };
}

const BACKUP_TYPE_META = {
  world: {
    label: "地图备份",
    description: "只包含世界存档目录。"
  },
  config: {
    label: "配置备份",
    description: "包含服务端配置、名单、KubeJS、默认配置和面板环境配置。"
  },
  migration: {
    label: "完整迁移包",
    description: "包含世界、mods、配置、脚本、名单和启动相关文件，适合换机器恢复体验。"
  }
};

const CONFIG_DATA_ENTRIES = [
  "server.env",
  "server.properties",
  "eula.txt",
  "ops.json",
  "whitelist.json",
  "banned-players.json",
  "banned-ips.json",
  "player-users.json",
  "usercache.json",
  "usernamecache.json",
  "server.config",
  "rhino.local.properties",
  "config",
  "defaultconfigs",
  "kubejs"
];

const MIGRATION_DATA_EXCLUDES = new Set([
  "bluemap",
  "libraries",
  "local",
  "logs",
  "modernfix",
  "versions",
  ".fabric",
  ".mixin.out"
]);

function getBackupSidecarPath(filePath) {
  return filePath.replace(/\.tar\.gz$/i, ".json");
}

function inferBackupType(name) {
  if (name.startsWith("migration-")) return "migration";
  if (name.startsWith("config-")) return "config";
  return "world";
}

async function readBackupManifest(filePath) {
  try {
    return JSON.parse(await fsp.readFile(getBackupSidecarPath(filePath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function listBackups() {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const entries = await fsp.readdir(BACKUP_DIR, { withFileTypes: true });
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tar.gz")) continue;
    const filePath = path.join(BACKUP_DIR, entry.name);
    const stat = await fsp.stat(filePath);
    const manifest = await readBackupManifest(filePath);
    const type = manifest?.type || inferBackupType(entry.name);
    backups.push({
      name: entry.name,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      type,
      label: BACKUP_TYPE_META[type]?.label || "备份",
      description: manifest?.description || BACKUP_TYPE_META[type]?.description || "",
      createdAt: manifest?.createdAt || new Date(stat.mtimeMs).toISOString(),
      contents: manifest?.contents || [],
      itemCount: manifest?.contents?.length || 0
    });
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
  return createBackupPackage("world");
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

async function discoverWorldEntries() {
  const config = await readConfigValues();
  const levelName = config.LEVEL_NAME || "world";
  const names = new Set([levelName, `${levelName}_nether`, `${levelName}_the_end`, "world", "world_nether", "world_the_end"]);
  const entries = [];
  for (const name of names) {
    if (await pathExists(path.join(DATA_DIR, name))) entries.push(name);
  }
  return entries;
}

async function getConfigBackupEntries() {
  const entries = [];
  for (const name of CONFIG_DATA_ENTRIES) {
    if (await pathExists(path.join(DATA_DIR, name))) entries.push({ source: path.join(DATA_DIR, name), archivePath: `data/${name}` });
  }
  for (const name of [".env", "compose.yaml"]) {
    if (await pathExists(path.join(WORKSPACE_DIR, name))) entries.push({ source: path.join(WORKSPACE_DIR, name), archivePath: `workspace/${name}` });
  }
  return entries;
}

async function getMigrationBackupEntries() {
  const entries = [];
  const dataEntries = await fsp.readdir(DATA_DIR, { withFileTypes: true });
  for (const entry of dataEntries) {
    if (MIGRATION_DATA_EXCLUDES.has(entry.name)) continue;
    entries.push({ source: path.join(DATA_DIR, entry.name), archivePath: `data/${entry.name}` });
  }
  for (const name of [".env", "compose.yaml", ".env.example", "mcctl"]) {
    if (await pathExists(path.join(WORKSPACE_DIR, name))) entries.push({ source: path.join(WORKSPACE_DIR, name), archivePath: `workspace/${name}` });
  }
  return entries;
}

async function getBackupEntries(type) {
  if (type === "config") return getConfigBackupEntries();
  if (type === "migration") return getMigrationBackupEntries();
  const worldDirs = await discoverWorldEntries();
  if (worldDirs.length === 0) {
    throw new Error("没有找到 world/world_nether/world_the_end 地图目录。");
  }
  return worldDirs.map((name) => ({ source: path.join(DATA_DIR, name), archivePath: `data/${name}` }));
}

async function createStagedBackupEntry(stageRoot, entry) {
  const target = path.join(stageRoot, entry.archivePath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.symlink(entry.source, target);
}

async function createBackupPackage(type = "world") {
  const normalizedType = BACKUP_TYPE_META[type] ? type : "world";
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const entries = await getBackupEntries(normalizedType);
  if (entries.length === 0) {
    throw new Error("没有找到可备份的内容。");
  }
  const stamp = backupTimestamp();
  const output = path.join(BACKUP_DIR, `${normalizedType}-${stamp}.tar.gz`);
  const stageRoot = path.join(BACKUP_DIR, `.staging-${normalizedType}-${crypto.randomBytes(6).toString("hex")}`);
  const manifest = {
    format: "utopia35-backup-v1",
    type: normalizedType,
    label: BACKUP_TYPE_META[normalizedType].label,
    description: BACKUP_TYPE_META[normalizedType].description,
    createdAt: new Date().toISOString(),
    contents: entries.map((entry) => entry.archivePath).sort(),
    excludes: normalizedType === "migration" ? Array.from(MIGRATION_DATA_EXCLUDES).sort().map((name) => `data/${name}`) : [],
    restoreHint: "在新机器上解压后，将 data/ 合并到服务器 data 目录，将 workspace/.env/compose.yaml 放回项目目录。恢复前请先停止 Minecraft 容器。"
  };
  try {
    await fsp.mkdir(stageRoot, { recursive: true });
    await fsp.writeFile(path.join(stageRoot, "utopia35-backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    for (const entry of entries) {
      await createStagedBackupEntry(stageRoot, entry);
    }
    await execFileAsync("tar", ["-czhf", output, "-C", stageRoot, "."], { timeout: 60 * 60 * 1000 });
    await fsp.writeFile(getBackupSidecarPath(output), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (error) {
    await fsp.rm(output, { force: true }).catch(() => {});
    await fsp.rm(getBackupSidecarPath(output), { force: true }).catch(() => {});
    throw error;
  } finally {
    await fsp.rm(stageRoot, { recursive: true, force: true });
  }
  const stat = await fsp.stat(output);
  return {
    name: path.basename(output),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    type: normalizedType,
    label: manifest.label,
    description: manifest.description,
    createdAt: manifest.createdAt,
    contents: manifest.contents,
    itemCount: manifest.contents.length
  };
}

async function pruneLocalBackups(type, keepLocal) {
  const backups = (await listBackups())
    .filter((backup) => backup.type === type)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const stale = backups.slice(Math.max(0, keepLocal));
  for (const backup of stale) {
    const filePath = path.join(BACKUP_DIR, safeFileName(backup.name));
    await fsp.rm(filePath, { force: true });
    await fsp.rm(getBackupSidecarPath(filePath), { force: true });
  }
  return stale.map((backup) => backup.name);
}

async function createScheduledBackup(type) {
  const backup = await createBackupPackage(type);
  let remote = null;
  let remoteError = "";
  if (scheduledBackupConfig.uploadRemote || (remoteBackupConfig.enabled && remoteBackupConfig.autoUpload)) {
    try {
      remote = await uploadBackupToRemote(backup.name);
    } catch (error) {
      remoteError = error.message;
    }
  }
  const pruned = await pruneLocalBackups(type, scheduledBackupConfig.keepLocal);
  return { backup, remote, remoteError, pruned };
}

async function validateTarMembers(filePath) {
  const [{ stdout }, { stdout: verbose }] = await Promise.all([
    execFileAsync("tar", ["-tzf", filePath], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024
    }),
    execFileAsync("tar", ["-tvzf", filePath], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024
    })
  ]);
  const verboseEntries = verbose.split(/\r?\n/).filter(Boolean);
  for (const entry of verboseEntries) {
    const type = entry[0];
    if (type !== "-" && type !== "d") {
      throw createPublicError(400, "BAD_BACKUP_ARCHIVE", "备份包里包含符号链接或特殊文件，已拒绝恢复。");
    }
  }
  const entries = stdout.split(/\r?\n/).filter(Boolean);
  for (const rawEntry of entries) {
    const entry = rawEntry.replace(/^\.\//, "");
    if (!entry || entry.startsWith("/") || entry.includes("\0")) {
      throw createPublicError(400, "BAD_BACKUP_ARCHIVE", "备份包里包含不安全路径。");
    }
    if (entry.split("/").some((segment) => segment === "..")) {
      throw createPublicError(400, "BAD_BACKUP_ARCHIVE", "备份包里包含不安全路径。");
    }
  }
  return entries;
}

async function readExtractedManifest(root) {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, "utopia35-backup-manifest.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      throw createPublicError(400, "BAD_BACKUP_MANIFEST", "备份包缺少有效的 manifest。");
    }
    throw error;
  }
}

async function validateExtractedRestoreTree(root) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw createPublicError(400, "BAD_BACKUP_ARCHIVE", "备份包里包含符号链接，已拒绝恢复。");
      }
      if (entry.isDirectory()) stack.push(filePath);
    }
  }
}

async function copyPath(source, target) {
  const stat = await fsp.lstat(source);
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (stat.isDirectory()) {
    await fsp.cp(source, target, { recursive: true, force: true, dereference: false });
  } else {
    await fsp.copyFile(source, target);
  }
}

async function restoreBackupPackage(name, options = {}) {
  const safeName = safeFileName(name);
  if (!safeName.endsWith(".tar.gz")) throw createPublicError(400, "BAD_BACKUP_NAME", "备份文件名不合法。");
  if (String(options.confirm || "") !== "RESTORE") {
    throw createPublicError(400, "RESTORE_CONFIRM_REQUIRED", "请输入 RESTORE 确认恢复。");
  }
  const filePath = path.join(BACKUP_DIR, safeName);
  if (!(await pathExists(filePath))) throw createPublicError(404, "BACKUP_NOT_FOUND", "备份文件不存在。");
  await validateTarMembers(filePath);
  const restoreRoot = path.join(BACKUP_DIR, `.restore-${crypto.randomBytes(6).toString("hex")}`);
  const restored = [];
  let stoppedContainer = false;
  try {
    await fsp.mkdir(restoreRoot, { recursive: true });
    await execFileAsync("tar", ["-xzf", filePath, "-C", restoreRoot], { timeout: 60 * 60 * 1000 });
    await validateExtractedRestoreTree(restoreRoot);
    const manifest = await readExtractedManifest(restoreRoot);
    if (manifest.format !== "utopia35-backup-v1") {
      throw createPublicError(400, "UNSUPPORTED_BACKUP_FORMAT", "不支持的备份格式。");
    }

    const { container, inspect } = await getMinecraftContainer();
    if (container && inspect?.State?.Running) {
      await container.stop({ t: 120 });
      stoppedContainer = true;
    }

    for (const rootName of ["data", "workspace"]) {
      const rootPath = path.join(restoreRoot, rootName);
      if (!(await pathExists(rootPath))) continue;
      const entries = await fsp.readdir(rootPath, { withFileTypes: true });
      for (const entry of entries) {
        const source = path.join(rootPath, entry.name);
        const targetBase = rootName === "data" ? DATA_DIR : WORKSPACE_DIR;
        const target = path.join(targetBase, entry.name);
        await copyPath(source, target);
        restored.push(`${rootName}/${entry.name}`);
      }
    }

    await loadPanelPasswordFromEnv().catch(() => {});
    return {
      name: safeName,
      manifest,
      restored,
      stoppedContainer,
      restartRequired: true
    };
  } finally {
    await fsp.rm(restoreRoot, { recursive: true, force: true });
  }
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

function parseChatLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  const timestampMatch = text.match(/^\[([0-9]{2}:[0-9]{2}:[0-9]{2})\]\s+\[[^\]]+\/INFO\]:\s+(.*)$/);
  if (!timestampMatch) return null;
  const [, logTime, body] = timestampMatch;
  const playerMatch = body.match(/^(?:\[Not Secure\]\s+)?<([^>]+)>\s+(.+)$/);
  if (playerMatch) {
    return {
      id: crypto.randomUUID(),
      type: "player",
      time: new Date().toISOString(),
      logTime,
      author: playerMatch[1],
      text: playerMatch[2]
    };
  }
  const rconMatch = body.match(/^\[Not Secure\]\s+\[Rcon\]\s+(.+)$/);
  if (rconMatch) {
    return {
      id: crypto.randomUUID(),
      type: "panel",
      time: new Date().toISOString(),
      logTime,
      author: "面板",
      text: rconMatch[1]
    };
  }
  return null;
}

function appendChatMessage(message) {
  chatHistory.push(message);
  if (chatHistory.length > CHAT_HISTORY_LIMIT) chatHistory.splice(0, chatHistory.length - CHAT_HISTORY_LIMIT);
}

async function getChatTail(tail = CHAT_HISTORY_LIMIT) {
  const logs = await getLogTail(Math.max(100, Math.min(Number(tail) || CHAT_HISTORY_LIMIT, 1000)));
  const messages = logs
    .split(/\r?\n/)
    .map(parseChatLine)
    .filter(Boolean)
    .slice(-CHAT_HISTORY_LIMIT);
  chatHistory.splice(0, chatHistory.length, ...messages);
  return chatHistory;
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

function isRconFailureResponse(response) {
  return /(no player was found|no entity was found|unknown or incomplete command|incorrect argument|that player cannot be found|failed)/i.test(String(response || ""));
}

async function sendCheckedRconCommand(command, publicMessage = "命令执行失败。") {
  const response = await sendRconCommand(command);
  if (isRconFailureResponse(response)) {
    throw createPublicError(400, "RCON_COMMAND_FAILED", `${publicMessage}${response ? ` ${response}` : ""}`);
  }
  return response;
}

function normalizeChatMessage(value) {
  const message = String(value || "").trim();
  if (!message) throw createPublicError(400, "EMPTY_CHAT_MESSAGE", "聊天内容不能为空。");
  if (message.length > 240) throw createPublicError(400, "CHAT_MESSAGE_TOO_LONG", "聊天内容不能超过 240 个字符。");
  if (/[\r\n\0]/.test(message)) throw createPublicError(400, "BAD_CHAT_MESSAGE", "聊天内容不能包含换行或空字符。");
  return message;
}

function tellrawJson(value) {
  return JSON.stringify([
    { text: "[面板] ", color: "light_purple" },
    { text: value, color: "white" }
  ]);
}

function playerTellrawJson(author, value) {
  return JSON.stringify([
    { text: "[玩家中心] ", color: "light_purple" },
    { text: `${author}: `, color: "aqua" },
    { text: value, color: "white" }
  ]);
}

async function sendChatMessage(message) {
  const text = normalizeChatMessage(message);
  await sendRconCommand(`tellraw @a ${tellrawJson(text)}`);
  const item = {
    id: crypto.randomUUID(),
    type: "panel",
    time: new Date().toISOString(),
    logTime: new Date().toTimeString().slice(0, 8),
    author: "面板",
    text
  };
  appendChatMessage(item);
  broadcastChatMessage(item);
  return item;
}

async function sendPlayerChatMessage(user, message) {
  const text = normalizeChatMessage(message);
  const author = user.minecraftName || user.username;
  const lastSentAt = playerChatRate.get(user.id) || 0;
  const remaining = 3000 - (Date.now() - lastSentAt);
  if (remaining > 0) {
    throw createPublicError(429, "PLAYER_CHAT_RATE_LIMITED", `发送太快了，请 ${Math.ceil(remaining / 1000)} 秒后再试。`);
  }
  playerChatRate.set(user.id, Date.now());
  await sendRconCommand(`tellraw @a ${playerTellrawJson(author, text)}`);
  const item = {
    id: crypto.randomUUID(),
    type: "player",
    time: new Date().toISOString(),
    logTime: new Date().toTimeString().slice(0, 8),
    author,
    text
  };
  appendChatMessage(item);
  broadcastChatMessage(item);
  return item;
}

function parsePlayerList(response) {
  const text = String(response || "").trim();
  const match = text.match(/There are (\d+) of a max of (\d+) players online:?\s*(.*)$/i);
  if (!match) {
    return { online: null, max: null, players: [], raw: text };
  }
  const names = match[3]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return {
    online: Number(match[1]),
    max: Number(match[2]),
    players: names,
    raw: text
  };
}

async function getOnlinePlayers() {
  const response = await sendRconCommand("list");
  return parsePlayerList(response);
}

async function buildStatus() {
  const [{ container, inspect }, config, runtimeConfig, serverProperties, mods, backups, playerStore] = await Promise.all([
    getMinecraftContainer(),
    readConfigValues(),
    readEnvFile(RUNTIME_ENV_FILE),
    readServerProperties(),
    listMods(),
    listBackups(),
    readPlayerStore()
  ]);
  const stats = await readContainerStats(container, inspect);
  return {
    now: new Date().toISOString(),
    panel: {
      defaultPassword: isDefaultPanelPassword(),
      bindHint: process.env.PANEL_BIND || "127.0.0.1"
    },
    paths: {
      dataDir: DATA_DIR,
      modsDir: MODS_DIR,
      backupDir: BACKUP_DIR,
      runtimeEnvFile: RUNTIME_ENV_FILE,
      composeEnvFile: COMPOSE_ENV_FILE
    },
    remoteBackup: publicRemoteBackupConfig(),
    scheduledBackup: publicScheduledBackupConfig(),
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
      backups: backups.length,
      playerUsers: playerStore.users.length,
      pendingPlayerUsers: playerStore.users.filter((user) => (user.status || "pending") === "pending").length
    }
  };
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  res.json({
    authenticated: Boolean(getSession(req)),
    defaultPassword: isDefaultPanelPassword()
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

app.get("/api/player/session", asyncHandler(async (req, res) => {
  const user = await getPlayerSessionUser(req);
  const config = await readConfigValues();
  res.json({
    authenticated: Boolean(user),
    user: publicPlayerUser(user),
    server: {
      whitelistEnabled: config.ENABLE_WHITELIST === "true"
    }
  });
}));

app.post("/api/player/register", asyncHandler(async (req, res) => {
  const user = await registerPlayerUser(req.body || {});
  const sessionId = crypto.randomBytes(32).toString("hex");
  playerSessions.set(sessionId, { userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + PLAYER_SESSION_TTL_MS });
  setPlayerSessionCookie(res, sessionId);
  res.json({ ok: true, user: publicPlayerUser(user) });
}));

app.post("/api/player/login", asyncHandler(async (req, res) => {
  const user = await loginPlayerUser(req.body || {});
  const sessionId = crypto.randomBytes(32).toString("hex");
  playerSessions.set(sessionId, { userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + PLAYER_SESSION_TTL_MS });
  setPlayerSessionCookie(res, sessionId);
  res.json({ ok: true, user: publicPlayerUser(user) });
}));

app.post("/api/player/logout", (req, res) => {
  const sessionId = parseCookies(req)[PLAYER_SESSION_COOKIE];
  if (sessionId) playerSessions.delete(sessionId);
  clearPlayerSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/player/me", requirePlayerAuth, asyncHandler(async (req, res) => {
  const user = await findPlayerUserById(req.playerSession.userId);
  const config = await readConfigValues();
  res.json({
    user: publicPlayerUser(user),
    server: {
      whitelistEnabled: config.ENABLE_WHITELIST === "true"
    }
  });
}));

app.post("/api/player/profile", requirePlayerAuth, asyncHandler(async (req, res) => {
  const user = await updatePlayerMinecraftName(req.playerSession.userId, req.body?.minecraftName);
  res.json({ ok: true, user: publicPlayerUser(user) });
}));

app.post("/api/player/whitelist/request", requirePlayerAuth, asyncHandler(async (req, res) => {
  const actor = await findPlayerUserById(req.playerSession.userId);
  const requested = await withAudit({
    actorType: "player",
    actor: actor?.minecraftName || actor?.username || req.playerSession.userId,
    action: "player.requestWhitelist",
    target: actor?.minecraftName || ""
  }, () => requestPlayerWhitelist(req.playerSession.userId));
  let user = requested;
  let autoApproved = false;
  if (PLAYER_AUTO_WHITELIST && requested.minecraftName && requested.status !== "approved") {
    try {
      user = await approvePlayerWhitelist(requested.id, "self-service");
      autoApproved = true;
    } catch {
      user = await findPlayerUserById(requested.id);
    }
  }
  res.json({ ok: true, autoApproved, user: publicPlayerUser(user) });
}));

app.post("/api/player/actions/set-home", requirePlayerAuth, asyncHandler(async (req, res) => {
  const actor = await findPlayerUserById(req.playerSession.userId);
  const user = await withAudit({
    actorType: "player",
    actor: actor?.minecraftName || actor?.username || req.playerSession.userId,
    action: "player.setHome",
    target: actor?.minecraftName || ""
  }, () => setPlayerHome(req.playerSession.userId));
  res.json({ ok: true, user: publicPlayerUser(user) });
}));

app.post("/api/player/actions/home", requirePlayerAuth, asyncHandler(async (req, res) => {
  const actor = await findPlayerUserById(req.playerSession.userId);
  const result = await withAudit({
    actorType: "player",
    actor: actor?.minecraftName || actor?.username || req.playerSession.userId,
    action: "player.teleportHome",
    target: actor?.minecraftName || ""
  }, () => teleportPlayerHome(req.playerSession.userId));
  res.json({ ok: true, result, user: publicPlayerUser(await findPlayerUserById(req.playerSession.userId)) });
}));

app.post("/api/player/actions/spawn", requirePlayerAuth, asyncHandler(async (req, res) => {
  const actor = await findPlayerUserById(req.playerSession.userId);
  const result = await withAudit({
    actorType: "player",
    actor: actor?.minecraftName || actor?.username || req.playerSession.userId,
    action: "player.teleportSpawn",
    target: actor?.minecraftName || ""
  }, () => teleportPlayerSpawn(req.playerSession.userId));
  res.json({ ok: true, result, user: publicPlayerUser(await findPlayerUserById(req.playerSession.userId)) });
}));

app.post("/api/player/actions/rescue", requirePlayerAuth, asyncHandler(async (req, res) => {
  const actor = await findPlayerUserById(req.playerSession.userId);
  const result = await withAudit({
    actorType: "player",
    actor: actor?.minecraftName || actor?.username || req.playerSession.userId,
    action: "player.rescue",
    target: actor?.minecraftName || ""
  }, () => rescuePlayer(req.playerSession.userId));
  res.json({ ok: true, result, user: publicPlayerUser(await findPlayerUserById(req.playerSession.userId)) });
}));

app.post("/api/player/actions/daily-kit", requirePlayerAuth, asyncHandler(async (req, res) => {
  const actor = await findPlayerUserById(req.playerSession.userId);
  const user = await withAudit({
    actorType: "player",
    actor: actor?.minecraftName || actor?.username || req.playerSession.userId,
    action: "player.dailyKit",
    target: actor?.minecraftName || ""
  }, () => claimDailyKit(req.playerSession.userId));
  res.json({ ok: true, user: publicPlayerUser(user) });
}));

app.get("/api/player/players", requirePlayerAuth, asyncHandler(async (_req, res) => {
  res.json(await getOnlinePlayers());
}));

app.get("/api/player/chat/history", requirePlayerAuth, asyncHandler(async (req, res) => {
  res.json({ messages: await getChatTail(req.query.tail) });
}));

app.post("/api/player/chat/send", requirePlayerAuth, asyncHandler(async (req, res) => {
  const user = await findPlayerUserById(req.playerSession.userId);
  if (!user || user.status === "disabled") {
    throw createPublicError(403, "PLAYER_DISABLED", "这个玩家账号不可用。");
  }
  const message = await withAudit({
    actorType: "player",
    actor: user.minecraftName || user.username,
    action: "player.chat.send",
    target: "server-chat"
  }, () => sendPlayerChatMessage(user, req.body?.message));
  res.json({ ok: true, message });
}));

app.use("/api", requireAuth);

app.post("/api/panel/password", asyncHandler(async (req, res) => {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  const result = await changePanelPassword(req.body || {}, sessionId);
  res.json({ ok: true, ...result });
}));

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
  const values = req.body?.values || {};
  const updated = await withAudit({
    action: "config.save",
    target: "server-config",
    detail: { keys: Object.keys(values) }
  }, () => saveConfigValues(values));
  res.json({ ok: true, updated, restartRequired: true });
}));

app.post("/api/rcon/setup", asyncHandler(async (_req, res) => {
  const password = crypto.randomBytes(18).toString("base64url");
  await withAudit({
    action: "rcon.setup",
    target: "server-config"
  }, () => saveConfigValues({ ENABLE_RCON: "true", RCON_PASSWORD: password }));
  res.json({ ok: true, password, restartRequired: true });
}));

app.post("/api/server/:action", asyncHandler(async (req, res) => {
  const action = req.params.action;
  if (!["start", "stop", "restart"].includes(action)) {
    res.status(404).json({ error: "UNKNOWN_ACTION", message: "未知服务器操作。" });
    return;
  }
  await withAudit({ action: `server.${action}`, target: MINECRAFT_CONTAINER }, async () => {
    const { container, inspect } = await getMinecraftContainer();
    if (!container) throw new Error("没有找到 Minecraft 容器。请先用 Docker Compose 创建服务。");
    if (action === "start") {
      if (!inspect.State.Running) await container.start();
    } else if (action === "stop") {
      if (inspect.State.Running) await container.stop({ t: 120 });
    } else if (action === "restart") {
      if (inspect.State.Running) await container.restart({ t: 120 });
      else await container.start();
    }
  });
  res.json({ ok: true, action });
}));

app.get("/api/logs", asyncHandler(async (req, res) => {
  res.type("text/plain").send(await getLogTail(req.query.tail));
}));

app.post("/api/command", asyncHandler(async (req, res) => {
  const command = String(req.body?.command || "").trim();
  const response = await withAudit({
    action: "rcon.command",
    target: command.split(/\s+/)[0] || "command",
    detail: { command: sanitizeAuditCommand(command) }
  }, () => sendRconCommand(command));
  res.json({ ok: true, response });
}));

app.get("/api/players", asyncHandler(async (_req, res) => {
  res.json(await getOnlinePlayers());
}));

app.get("/api/players/:name/detail", asyncHandler(async (req, res) => {
  const name = normalizeMinecraftName(req.params.name);
  const detail = await withAudit({
    action: "player.detail.view",
    target: name
  }, () => getPlayerDetail(name));
  res.json({ detail });
}));

app.get("/api/audit-log", asyncHandler(async (req, res) => {
  res.json({ entries: await listAuditLogs(req.query.limit) });
}));

app.get("/api/player-users", asyncHandler(async (_req, res) => {
  const [store, config] = await Promise.all([readPlayerStore(), readConfigValues()]);
  res.json({
    users: store.users.map(publicPlayerUser),
    server: {
      whitelistEnabled: config.ENABLE_WHITELIST === "true"
    }
  });
}));

app.post("/api/player-users/:id/approve", asyncHandler(async (req, res) => {
  const user = await withAudit({
    action: "playerUser.approveWhitelist",
    target: req.params.id
  }, () => approvePlayerWhitelist(req.params.id, "admin"));
  res.json({ ok: true, user: publicPlayerUser(user) });
}));

app.post("/api/player-users/:id/reject", asyncHandler(async (req, res) => {
  const user = await withAudit({
    action: "playerUser.reject",
    target: req.params.id
  }, () => rejectPlayerUser(req.params.id, req.body?.note));
  res.json({ ok: true, user: publicPlayerUser(user) });
}));

app.delete("/api/player-users/:id", asyncHandler(async (req, res) => {
  const user = await withAudit({
    action: "playerUser.delete",
    target: req.params.id
  }, () => deletePlayerUser(req.params.id));
  res.json({ ok: true, user });
}));

app.get("/api/chat/history", asyncHandler(async (req, res) => {
  res.json({ messages: await getChatTail(req.query.tail) });
}));

app.post("/api/chat/send", asyncHandler(async (req, res) => {
  const message = await withAudit({
    action: "chat.send",
    target: "server-chat"
  }, () => sendChatMessage(req.body?.message));
  res.json({ ok: true, message });
}));

app.get("/api/map", asyncHandler(async (req, res) => {
  res.json(await getBlueMapStatus(req));
}));

app.post("/api/map/bluemap/install", asyncHandler(async (_req, res) => {
  const result = await installBlueMapMod();
  res.json({ ok: true, ...result, restartRequired: true });
}));

app.get("/api/mods", asyncHandler(async (_req, res) => {
  res.json({ mods: await listMods() });
}));

app.post("/api/mods/upload", upload.array("mods", 20), asyncHandler(async (req, res) => {
  const fileNames = (req.files || []).map((file) => file.originalname);
  const uploaded = await withAudit({
    action: "mods.upload",
    target: "mods",
    detail: { files: fileNames, overwrite: req.body?.overwrite === "true" }
  }, async () => {
    await fsp.mkdir(MODS_DIR, { recursive: true });
    const names = [];
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
      await moveFileAcrossDevices(file.path, target);
      names.push(name);
    }
    return names;
  });
  res.json({ ok: true, uploaded, restartRequired: true });
}));

app.post("/api/mods/:name/toggle", asyncHandler(async (req, res) => {
  const name = safeModName(req.params.name);
  await withAudit({
    action: "mods.toggle",
    target: name
  }, async () => {
    const source = path.join(MODS_DIR, name);
    if (!(await pathExists(source))) throw new Error("mod 文件不存在。");
    const targetName = name.endsWith(".disabled") ? name.replace(/\.disabled$/, "") : `${name}.disabled`;
    await fsp.rename(source, path.join(MODS_DIR, safeModName(targetName)));
  });
  res.json({ ok: true, restartRequired: true });
}));

app.delete("/api/mods/:name", asyncHandler(async (req, res) => {
  const name = safeModName(req.params.name);
  await withAudit({
    action: "mods.delete",
    target: name
  }, () => fsp.rm(path.join(MODS_DIR, name), { force: true }));
  res.json({ ok: true, restartRequired: true });
}));

app.get("/api/backups", asyncHandler(async (_req, res) => {
  let remote = [];
  let remoteError = "";
  if (remoteBackupConfig.enabled && remoteBackupConfig.configured) {
    try {
      remote = await listRemoteBackups();
    } catch (error) {
      remoteError = error.message;
    }
  }
  res.json({
    backups: await listBackups(),
    remote,
    remoteError,
    remoteConfig: publicRemoteBackupConfig()
  });
}));

app.post("/api/backups", asyncHandler(async (req, res) => {
  const type = req.body?.type || "world";
  const backup = await withAudit({
    action: "backup.create",
    target: type,
    detail: { uploadRemote: Boolean(req.body?.uploadRemote) }
  }, () => createBackupPackage(type));
  let remote = null;
  let remoteError = "";
  if (req.body?.uploadRemote || (remoteBackupConfig.enabled && remoteBackupConfig.autoUpload)) {
    try {
      remote = await uploadBackupToRemote(backup.name);
    } catch (error) {
      remoteError = error.message;
    }
  }
  res.json({ ok: true, backup, remote, remoteError });
}));

app.get("/api/backups/remote/config", asyncHandler(async (_req, res) => {
  res.json({ config: publicRemoteBackupConfig() });
}));

app.post("/api/backups/remote/config", asyncHandler(async (req, res) => {
  const config = await withAudit({
    action: "backup.remoteConfig.save",
    target: "remote-backup",
    detail: req.body || {}
  }, () => saveRemoteBackupConfig(req.body || {}));
  res.json({ ok: true, config });
}));

app.post("/api/backups/remote/test", asyncHandler(async (_req, res) => {
  res.json({ ok: true, config: await testRemoteBackupConnection(_req.body || null) });
}));

app.get("/api/backups/schedule", asyncHandler(async (_req, res) => {
  res.json({ config: publicScheduledBackupConfig() });
}));

app.post("/api/backups/schedule", asyncHandler(async (req, res) => {
  const config = await withAudit({
    action: "backup.schedule.save",
    target: "scheduled-backup",
    detail: req.body || {}
  }, () => saveScheduledBackupConfig(req.body || {}));
  res.json({ ok: true, config });
}));

app.post("/api/backups/remote/import", asyncHandler(async (req, res) => {
  const backup = await withAudit({
    action: "backup.remoteImport",
    target: req.body?.key || "",
    detail: { overwrite: Boolean(req.body?.overwrite) }
  }, () => importRemoteBackup(req.body?.key, { overwrite: Boolean(req.body?.overwrite) }));
  res.json({ ok: true, backup });
}));

app.delete("/api/backups/remote", asyncHandler(async (req, res) => {
  const remote = await withAudit({
    action: "backup.remoteDelete",
    target: req.body?.key || ""
  }, () => deleteRemoteBackup(req.body?.key));
  res.json({ ok: true, remote });
}));

app.post("/api/backups/:name/remote-upload", asyncHandler(async (req, res) => {
  const name = safeFileName(req.params.name);
  const remote = await withAudit({
    action: "backup.remoteUpload",
    target: name
  }, () => uploadBackupToRemote(name));
  res.json({ ok: true, remote });
}));

app.post("/api/backups/:name/restore", asyncHandler(async (req, res) => {
  const name = safeFileName(req.params.name);
  const restore = await withAudit({
    action: "backup.restore",
    target: name
  }, () => restoreBackupPackage(name, req.body || {}));
  res.json({ ok: true, restore });
}));

app.get("/api/backups/:name/download", asyncHandler(async (req, res) => {
  const name = safeFileName(req.params.name);
  if (!name.endsWith(".tar.gz")) throw new Error("备份文件名不合法。");
  const filePath = path.join(BACKUP_DIR, name);
  if (!(await pathExists(filePath))) throw createPublicError(404, "BACKUP_NOT_FOUND", "备份文件不存在。");
  res.download(filePath);
}));

app.delete("/api/backups/:name", asyncHandler(async (req, res) => {
  const name = safeFileName(req.params.name);
  await withAudit({
    action: "backup.delete",
    target: name
  }, async () => {
    if (!name.endsWith(".tar.gz")) throw new Error("备份文件名不合法。");
    const filePath = path.join(BACKUP_DIR, name);
    if (!(await pathExists(filePath))) throw createPublicError(404, "BACKUP_NOT_FOUND", "备份文件不存在。");
    await fsp.rm(filePath, { force: true });
    await fsp.rm(getBackupSidecarPath(filePath), { force: true });
  });
  res.json({ ok: true });
}));

app.get(/^\/bluemap$/, requireAuth, (_req, res) => {
  res.redirect(302, "/bluemap/");
});

app.use("/bluemap", requireAuth, asyncHandler(proxyBlueMapRequest));

app.get(/^\/player\/?$/, (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "player.html"));
});

app.use(express.static(path.join(__dirname, "..", "public"), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
  }
}));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  if (!error.statusCode || error.statusCode >= 500) console.error(error);
  res.status(error.statusCode || 500).json({
    error: error.publicCode || "REQUEST_FAILED",
    message: error.message || "请求失败。"
  });
});

const logsWss = new WebSocket.Server({ noServer: true });
const chatWss = new WebSocket.Server({ noServer: true });
const playerChatWss = new WebSocket.Server({ noServer: true });
let scheduledBackupRunning = false;

function broadcastChatMessage(message) {
  const payload = JSON.stringify(message);
  for (const wss of [chatWss, playerChatWss]) {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }
}

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/ws/player-chat")) {
    if (!getPlayerSession(req)) {
      socket.destroy();
      return;
    }
    playerChatWss.handleUpgrade(req, socket, head, (ws) => {
      playerChatWss.emit("connection", ws, req);
    });
    return;
  }
  if (!getSession(req)) {
    socket.destroy();
    return;
  }
  if (req.url.startsWith("/ws/logs")) {
    logsWss.handleUpgrade(req, socket, head, (ws) => {
      logsWss.emit("connection", ws, req);
    });
    return;
  }
  if (req.url.startsWith("/ws/chat")) {
    chatWss.handleUpgrade(req, socket, head, (ws) => {
      chatWss.emit("connection", ws, req);
    });
    return;
  }
  socket.destroy();
});

logsWss.on("connection", async (ws) => {
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

chatWss.on("connection", async (ws) => {
  handleChatSocket(ws);
});

playerChatWss.on("connection", async (ws) => {
  handleChatSocket(ws);
});

async function handleChatSocket(ws) {
  let stream = null;
  let buffered = "";
  try {
    const { container, inspect } = await getMinecraftContainer();
    if (!container) {
      ws.send(JSON.stringify({ type: "system", text: "没有找到 Minecraft 容器。", time: new Date().toISOString() }));
      ws.close();
      return;
    }
    stream = await container.logs({
      stdout: true,
      stderr: true,
      follow: true,
      tail: 0,
      timestamps: false
    });
    const onText = (text) => {
      buffered += text;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || "";
      for (const line of lines) {
        const message = parseChatLine(line);
        if (!message) continue;
        appendChatMessage(message);
        broadcastChatMessage(message);
      }
    };
    if (inspect.Config.Tty) {
      stream.on("data", (chunk) => onText(chunk.toString("utf8")));
    } else {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on("data", (chunk) => onText(chunk.toString("utf8")));
      stderr.on("data", (chunk) => onText(chunk.toString("utf8")));
      docker.modem.demuxStream(stream, stdout, stderr);
    }
    stream.on("end", () => ws.close());
    stream.on("error", (error) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "system", text: `聊天流错误：${error.message}`, time: new Date().toISOString() }));
      }
    });
  } catch (error) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "system", text: `聊天流启动失败：${error.message}`, time: new Date().toISOString() }));
    }
    ws.close();
  }
  ws.on("close", () => {
    if (stream && typeof stream.destroy === "function") stream.destroy();
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt < now) sessions.delete(sessionId);
  }
  for (const [sessionId, session] of playerSessions.entries()) {
    if (session.expiresAt < now) playerSessions.delete(sessionId);
  }
}, 60 * 60 * 1000).unref();

async function updateScheduledBackupRunKeys(updates) {
  scheduledBackupConfig = { ...scheduledBackupConfig, ...updates };
  await writeEnvFile(COMPOSE_ENV_FILE, {
    SCHEDULED_BACKUP_LAST_WORLD_RUN: scheduledBackupConfig.lastWorldRunKey,
    SCHEDULED_BACKUP_LAST_MIGRATION_RUN: scheduledBackupConfig.lastMigrationRunKey
  }, { seedFrom: EXAMPLE_ENV_FILE });
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function checkScheduledBackups() {
  if (scheduledBackupRunning || !scheduledBackupConfig.enabled) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (hhmm !== scheduledBackupConfig.time) return;

  scheduledBackupRunning = true;
  try {
    const today = localDateKey(now);
    if (scheduledBackupConfig.lastWorldRunKey !== today) {
      console.log(`[scheduled-backup] creating world backup for ${today}`);
      const result = await createScheduledBackup("world");
      console.log(`[scheduled-backup] world backup created: ${result.backup.name}${result.remoteError ? `, remote failed: ${result.remoteError}` : ""}`);
      await updateScheduledBackupRunKeys({ lastWorldRunKey: today });
    }

    const migrationKey = `${today}-migration`;
    if (
      scheduledBackupConfig.includeMigrationWeekly &&
      now.getDay() === scheduledBackupConfig.migrationWeekday &&
      scheduledBackupConfig.lastMigrationRunKey !== migrationKey
    ) {
      console.log(`[scheduled-backup] creating migration backup for ${today}`);
      const result = await createScheduledBackup("migration");
      console.log(`[scheduled-backup] migration backup created: ${result.backup.name}${result.remoteError ? `, remote failed: ${result.remoteError}` : ""}`);
      await updateScheduledBackupRunKeys({ lastMigrationRunKey: migrationKey });
    }
  } catch (error) {
    console.error("[scheduled-backup] failed:", error);
  } finally {
    scheduledBackupRunning = false;
  }
}

setInterval(() => {
  checkScheduledBackups().catch((error) => console.error("[scheduled-backup] failed:", error));
}, 60 * 1000).unref();

loadPanelPasswordFromEnv().catch((error) => {
  console.warn(`Unable to load PANEL_PASSWORD from ${COMPOSE_ENV_FILE}: ${error.message}`);
}).finally(() => {
  server.listen(PANEL_PORT, "0.0.0.0", () => {
    console.log(`Utopia panel listening on 0.0.0.0:${PANEL_PORT}`);
    if (isDefaultPanelPassword()) {
      console.warn("PANEL_PASSWORD is still the default value. Change it before exposing the panel.");
    }
  });
});
