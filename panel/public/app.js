"use strict";

const state = {
  configFields: [],
  configValues: {},
  logsSocket: null,
  chatSocket: null,
  chatMessages: [],
  statusTimer: null,
  booting: false,
  authenticated: false,
  needsRestart: false,
  lastPlayers: [],
  remoteBackupConfig: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function showAppMessage(message, type = "info") {
  const messageBox = $("#app-message");
  messageBox.textContent = message;
  messageBox.classList.toggle("error", type === "error");
  messageBox.hidden = false;
}

function hideAppMessage() {
  const messageBox = $("#app-message");
  messageBox.hidden = true;
  messageBox.textContent = "";
  messageBox.classList.remove("error");
}

function setNeedsRestart(value, message = "有改动需要重启 Minecraft 才会生效。") {
  state.needsRestart = Boolean(value);
  const notice = $("#restart-notice");
  notice.hidden = !state.needsRestart;
  if (state.needsRestart) {
    notice.querySelector("strong").textContent = message;
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatDate(msOrIso) {
  if (!msOrIso) return "-";
  return new Date(msOrIso).toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function api(path, options = {}) {
  const init = {
    credentials: "same-origin",
    headers: {},
    ...options
  };
  if (init.body && !(init.body instanceof FormData)) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(init.body);
  }
  const response = await fetch(path, init);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof data === "string" ? data : data.message;
    const error = new Error(message || `请求失败：${response.status}`);
    error.status = response.status;
    error.code = typeof data === "string" ? "" : data.error;
    throw error;
  }
  return data;
}

async function handleSessionExpired(error) {
  if (error.code !== "NOT_AUTHENTICATED") return false;
  await setAuthenticated(false);
  $("#login-error").textContent = "登录状态已失效，请重新登录。";
  return true;
}

async function showOperationError(error) {
  if (await handleSessionExpired(error)) return;
  showToast(error.message);
}

async function setAuthenticated(authenticated) {
  state.authenticated = authenticated;
  $("#login-view").hidden = authenticated;
  $("#app-view").hidden = !authenticated;
  if (state.statusTimer) {
    clearInterval(state.statusTimer);
    state.statusTimer = null;
  }
  if (authenticated) {
    await bootApp();
  } else {
    hideAppMessage();
    setNeedsRestart(false);
    if (state.logsSocket) {
      state.logsSocket.close();
      state.logsSocket = null;
    }
    if (state.chatSocket) {
      state.chatSocket.close();
      state.chatSocket = null;
    }
    state.chatMessages = [];
    renderChatMessages();
  }
  window.scrollTo({ top: 0, behavior: "auto" });
}

async function checkSession() {
  const session = await api("/api/session");
  $("#login-warning").hidden = !session.defaultPassword;
  await setAuthenticated(session.authenticated);
}

function activateTab(tabName) {
  $$(".tabs button").forEach((item) => item.classList.toggle("active", item.dataset.tab === tabName));
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tabName}`));
  if (tabName === "console" && !state.logsSocket) connectLogs();
  if (tabName === "chat") {
    loadChatHistory().catch(showOperationError);
    if (!state.chatSocket) connectChat();
  }
  if (tabName === "map") loadMapStatus().catch(showOperationError);
  window.scrollTo({ top: 0, behavior: "auto" });
}

async function refreshAll() {
  const tasks = [
    ["状态", refreshStatus],
    ["地图", loadMapStatus],
    ["聊天", () => loadChatHistory({ silent: true })],
    ["在线玩家", () => loadPlayers({ silent: true })],
    ["配置", loadConfig],
    ["Mod 列表", loadMods],
    ["备份列表", loadBackups]
  ];
  const results = await Promise.allSettled(tasks.map(([, task]) => task()));
  const failures = results
    .map((result, index) => ({ result, label: tasks[index][0] }))
    .filter(({ result }) => result.status === "rejected");
  if (failures.length > 0) {
    const detail = failures.map(({ label, result }) => `${label}：${result.reason.message}`).join("；");
    throw new Error(detail);
  }
}

async function bootApp() {
  if (state.booting) return;
  state.booting = true;
  showAppMessage("已登录，正在加载控制面板数据...");
  try {
    await refreshAll();
    if (!state.authenticated) return;
    hideAppMessage();
    state.statusTimer = setInterval(() => {
      refreshStatus().catch(async (error) => {
        if (await handleSessionExpired(error)) return;
        showAppMessage(`状态刷新失败：${error.message}`, "error");
      });
    }, 5000);
  } catch (error) {
    if (!state.authenticated) return;
    if (await handleSessionExpired(error)) return;
    showAppMessage(`登录成功，但控制面板数据加载失败：${error.message}`, "error");
    showToast(error.message);
  } finally {
    state.booting = false;
  }
}

async function refreshStatus() {
  const status = await api("/api/status");
  renderStatus(status);
}

function renderStatus(status) {
  const container = status.container;
  const statePill = $("#server-state");
  statePill.className = "state-pill";
  if (!container) {
    statePill.textContent = "未创建";
    statePill.classList.add("stopped");
  } else if (container.running) {
    statePill.textContent = container.health ? `运行中 / ${container.health}` : "运行中";
    statePill.classList.add("running");
  } else {
    statePill.textContent = container.state || "已停止";
    statePill.classList.add("stopped");
  }

  $("#metric-container").textContent = container ? container.name : "未创建";
  $("#metric-health").textContent = container?.health || container?.state || "-";
  $("#metric-memory").textContent = status.stats ? `${formatBytes(status.stats.memoryUsage)} / ${formatBytes(status.stats.memoryLimit)}` : "-";
  $("#metric-cpu").textContent = status.stats ? `${status.stats.cpuPercent.toFixed(1)}%` : "-";

  $("#summary-list").innerHTML = definitionList({
    "MOTD": status.config.MOTD,
    "正版验证": status.config.ONLINE_MODE,
    "白名单": status.config.ENABLE_WHITELIST,
    "最大玩家": status.config.MAX_PLAYERS,
    "内存": `${status.config.MIN_MEMORY} / ${status.config.MAX_MEMORY}`,
    "RCON": status.config.ENABLE_RCON,
    "Mods": `${status.counts.enabledMods}/${status.counts.mods} 已启用`,
    "备份": `${status.counts.backups} 个`
  });

  $("#paths-list").innerHTML = definitionList({
    "数据目录": status.paths.dataDir,
    "Mods": status.paths.modsDir,
    "备份": status.paths.backupDir,
    "运行配置": status.paths.runtimeEnvFile,
    "Compose .env": status.paths.composeEnvFile
  });

  if (status.remoteBackup) {
    state.remoteBackupConfig = status.remoteBackup;
    renderRemoteBackupConfig(status.remoteBackup);
  }

  const warning = $("#security-warning");
  if (status.panel.defaultPassword) {
    warning.hidden = false;
    warning.innerHTML = '面板仍在使用默认密码 change-me。不要把面板暴露到公网，先到 <button type="button" class="link-button" data-jump-tab="config">配置</button> 修改面板密码。';
  } else {
    warning.hidden = true;
    warning.textContent = "";
  }
}

function definitionList(items) {
  return Object.entries(items)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value || "-")}</dd>`)
    .join("");
}

async function loadConfig() {
  const data = await api("/api/config");
  state.configFields = data.fields;
  state.configValues = data.values;
  renderConfigForm();
}

function renderConfigForm() {
  const groups = new Map();
  for (const field of state.configFields) {
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(field);
  }
  $("#config-groups").innerHTML = Array.from(groups.entries())
    .map(([group, fields]) => `
      <section class="config-group">
        <h3>${escapeHtml(group)}</h3>
        <div class="fields-grid">
          ${fields.map(renderField).join("")}
        </div>
      </section>
    `)
    .join("");
}

function renderField(field) {
  const value = state.configValues[field.key] ?? field.default ?? "";
  if (field.type === "boolean") {
    return `
      <div class="field boolean">
        <label>
          <input name="${field.key}" type="checkbox" ${value === "true" ? "checked" : ""}>
          <span>${escapeHtml(field.label)}</span>
        </label>
      </div>
    `;
  }
  if (field.type === "select") {
    return `
      <label class="field">
        <span>${escapeHtml(field.label)}</span>
        <select name="${field.key}">
          ${field.options.map((option) => `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
        </select>
      </label>
    `;
  }
  if (field.type === "textarea") {
    return `
      <label class="field textarea">
        <span>${escapeHtml(field.label)}</span>
        <textarea name="${field.key}" spellcheck="false">${escapeHtml(value)}</textarea>
      </label>
    `;
  }
  const type = field.type === "password" ? "password" : field.type === "number" ? "number" : "text";
  const attrs = field.type === "number" ? `min="${field.min}" max="${field.max}" step="1"` : "";
  return `
    <label class="field">
      <span>${escapeHtml(field.label)}</span>
      <input name="${field.key}" type="${type}" value="${escapeHtml(value)}" ${attrs}>
    </label>
  `;
}

async function saveConfig(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = {};
  for (const field of state.configFields) {
    const element = form.elements[field.key];
    if (!element) continue;
    if (field.type === "boolean") values[field.key] = element.checked ? "true" : "false";
    else values[field.key] = element.value;
  }
  await api("/api/config", { method: "POST", body: { values } });
  setNeedsRestart(true, "运行配置已保存，需要重启 Minecraft 才会生效。");
  showToast("配置已保存，重启服务器后生效。");
  await refreshAll();
}

async function changePanelPassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = $("#panel-password-message");
  const currentPassword = $("#panel-current-password").value;
  const newPassword = $("#panel-new-password").value;
  const confirmPassword = $("#panel-confirm-password").value;
  message.textContent = "";
  message.classList.remove("error");
  if (newPassword !== confirmPassword) {
    message.textContent = "两次输入的新密码不一致。";
    message.classList.add("error");
    return;
  }
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    await api("/api/panel/password", {
      method: "POST",
      body: { currentPassword, newPassword }
    });
    form.reset();
    message.textContent = "面板密码已修改，当前登录保持有效。";
    showToast("面板密码已修改。");
    await refreshStatus();
    $("#login-warning").hidden = true;
  } catch (error) {
    if (await handleSessionExpired(error)) return;
    message.textContent = error.message;
    message.classList.add("error");
  } finally {
    button.disabled = false;
  }
}

async function runServerAction(action) {
  await api(`/api/server/${action}`, { method: "POST" });
  showToast(`服务器${action === "start" ? "启动" : action === "stop" ? "停止" : "重启"}指令已发送。`);
  if (action === "restart") setNeedsRestart(false);
  setTimeout(refreshStatus, 1200);
}

function appendLog(text) {
  const output = $("#log-output");
  output.textContent += text;
  const lines = output.textContent.split("\n");
  if (lines.length > 900) output.textContent = lines.slice(-900).join("\n");
  output.scrollTop = output.scrollHeight;
}

function connectLogs() {
  if (state.logsSocket && state.logsSocket.readyState === WebSocket.OPEN) {
    state.logsSocket.close();
    return;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  state.logsSocket = new WebSocket(`${protocol}//${location.host}/ws/logs`);
  state.logsSocket.addEventListener("open", () => {
    appendLog("\n[panel] 日志已连接。\n");
    $("#connect-logs-button").textContent = "断开日志";
  });
  state.logsSocket.addEventListener("message", (event) => appendLog(event.data));
  state.logsSocket.addEventListener("close", () => {
    appendLog("\n[panel] 日志已断开。\n");
    $("#connect-logs-button").textContent = "连接日志";
    state.logsSocket = null;
  });
}

function setChatState(label, running = false) {
  const statePill = $("#chat-state");
  statePill.textContent = label;
  statePill.className = `state-pill ${running ? "running" : "stopped"}`;
}

function addChatMessage(message) {
  if (!message?.id) return;
  if (state.chatMessages.some((item) => item.id === message.id)) return;
  state.chatMessages.push(message);
  if (state.chatMessages.length > 200) state.chatMessages = state.chatMessages.slice(-200);
  renderChatMessages();
}

function renderChatMessages() {
  const output = $("#chat-output");
  if (!output) return;
  if (!state.chatMessages.length) {
    output.innerHTML = `<div class="empty-state">还没有聊天消息。</div>`;
    return;
  }
  output.innerHTML = state.chatMessages.map((message) => {
    const type = message.type === "panel" ? "panel" : message.type === "system" ? "system" : "player";
    const time = message.logTime || (message.time ? new Date(message.time).toLocaleTimeString() : "");
    return `
      <article class="chat-message ${type}">
        <div class="chat-meta">
          <strong>${escapeHtml(message.author || (type === "panel" ? "面板" : "系统"))}</strong>
          <span>${escapeHtml(time)}</span>
        </div>
        <div class="chat-bubble">${escapeHtml(message.text || "")}</div>
      </article>
    `;
  }).join("");
  output.scrollTop = output.scrollHeight;
}

async function loadChatHistory(options = {}) {
  try {
    const data = await api("/api/chat/history");
    state.chatMessages = data.messages || [];
    renderChatMessages();
  } catch (error) {
    if (options.silent) {
      state.chatMessages = [];
      renderChatMessages();
      return;
    }
    throw error;
  }
}

function connectChat() {
  if (state.chatSocket && state.chatSocket.readyState === WebSocket.OPEN) {
    state.chatSocket.close();
    return;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  state.chatSocket = new WebSocket(`${protocol}//${location.host}/ws/chat`);
  setChatState("连接中", false);
  $("#connect-chat-button").textContent = "断开聊天";
  state.chatSocket.addEventListener("open", () => {
    setChatState("已连接", true);
  });
  state.chatSocket.addEventListener("message", (event) => {
    try {
      addChatMessage(JSON.parse(event.data));
    } catch {
      addChatMessage({
        id: `system-${Date.now()}`,
        type: "system",
        time: new Date().toISOString(),
        author: "系统",
        text: String(event.data || "")
      });
    }
  });
  state.chatSocket.addEventListener("close", () => {
    setChatState("未连接", false);
    $("#connect-chat-button").textContent = "连接聊天";
    state.chatSocket = null;
  });
}

async function sendChat(event) {
  event.preventDefault();
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message) {
    showToast("聊天内容不能为空。");
    return;
  }
  const button = event.currentTarget.querySelector("button[type='submit']");
  await withButtonBusy(button, "发送中", async () => {
    const result = await api("/api/chat/send", { method: "POST", body: { message } });
    input.value = "";
    addChatMessage(result.message);
  });
}

async function sendCommand(command, outputSelector = "#command-response") {
  const result = await api("/api/command", { method: "POST", body: { command } });
  const output = $(outputSelector);
  output.textContent = result.response || "(命令已发送，无返回内容)";
  output.scrollTop = 0;
  return result;
}

async function loadPlayers(options = {}) {
  try {
    const data = await api("/api/players");
    state.lastPlayers = data.players || [];
    renderPlayers(data);
  } catch (error) {
    state.lastPlayers = [];
    renderPlayers({ players: [], online: null, max: null, raw: error.message, error: true });
    if (options.silent) return;
    throw error;
  }
}

function renderPlayers(data) {
  const count = $("#online-player-count");
  const list = $("#online-player-list");
  count.className = "state-pill";
  if (data.error) {
    count.textContent = "读取失败";
    count.classList.add("stopped");
    list.innerHTML = `<div class="empty-state">${escapeHtml(data.raw || "在线玩家读取失败。")}</div>`;
    return;
  }
  count.textContent = data.online === null ? `${data.players.length} 人在线` : `${data.online}/${data.max}`;
  count.classList.add(data.players.length ? "running" : "stopped");
  list.innerHTML = data.players.length
    ? data.players.map((player) => `<button type="button" class="player-chip" data-player-name="${escapeHtml(player)}">${escapeHtml(player)}</button>`).join("")
    : `<div class="empty-state">${escapeHtml(data.raw || "当前没有玩家在线。")}</div>`;
}

function fillPlayerInputs(player) {
  $$("input[name='player']").forEach((input) => {
    input.value = player;
  });
  showToast(`已填入玩家：${player}`);
}

async function withButtonBusy(button, label, task) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function loadMapStatus() {
  const status = await api("/api/map");
  renderMapStatus(status);
}

function renderMapStatus(status) {
  const statusBox = $("#map-status");
  const frameShell = $("#map-frame-shell");
  const frame = $("#map-frame");
  const installButton = $("#install-bluemap-button");
  const openLink = $("#open-map-link");

  openLink.href = status.mapUrl;
  installButton.hidden = status.installed && status.enabled;
  installButton.textContent = status.installed && !status.enabled ? "启用 BlueMap" : "安装 BlueMap";
  frameShell.hidden = true;
  frame.removeAttribute("src");
  statusBox.classList.remove("error");

  if (!status.installed) {
    statusBox.classList.add("error");
    statusBox.innerHTML = `
      <strong>还没有安装 Web 地图。</strong>
      <span>点击“安装 BlueMap”会下载 Fabric ${escapeHtml(status.gameVersion || "1.20.1")} 版 BlueMap 到 mods 目录。安装后重启 Minecraft，BlueMap 会生成配置和地图网页。</span>
    `;
    return;
  }

  if (!status.enabled) {
    statusBox.classList.add("error");
    statusBox.innerHTML = `
      <strong>BlueMap 已存在但被禁用。</strong>
      <span>点击“启用 BlueMap”或在 Mods 页启用 ${escapeHtml(status.modName)}，然后重启 Minecraft。</span>
    `;
    return;
  }

  if (!status.reachable) {
    const networkHint = status.proxied
      ? "面板会通过 /bluemap/ 代理地图，外网只需要能访问面板端口；如果这里仍不可用，请确认 Minecraft 容器内的 BlueMap 服务已经启动。"
      : `请确认地图公网/反代地址可访问，并检查端口 ${escapeHtml(status.hostPort)} 的发布状态。`;
    statusBox.innerHTML = `
      <strong>BlueMap 已安装，等待地图服务上线。</strong>
      <span>请重启或重新创建 Minecraft 容器。首次启动后 BlueMap 会生成配置；如果地图仍打不开，查看控制台里 BlueMap 的提示。${networkHint}</span>
    `;
    return;
  }

  statusBox.innerHTML = `
    <strong>BlueMap 地图在线。</strong>
    <span>${status.proxied ? "当前地图通过面板 /bluemap/ 同源代理加载，frp 只转发面板端口也能访问。" : "当前地图使用单独的公网/反代地址加载。"} 如果画面正在加载，这是 BlueMap 正在渲染世界。</span>
  `;
  frame.src = status.mapUrl;
  frameShell.hidden = false;
}

async function installBlueMap() {
  $("#install-bluemap-button").disabled = true;
  showToast("正在安装 BlueMap...");
  try {
    const result = await api("/api/map/bluemap/install", { method: "POST" });
    await Promise.all([loadMapStatus(), loadMods()]);
    setNeedsRestart(true, "BlueMap 已安装或启用，需要重启 Minecraft 才会生效。");
    showToast(result.installed ? "BlueMap 已安装。重启 Minecraft 后地图服务会生成。" : result.message || "BlueMap 已安装。");
  } finally {
    $("#install-bluemap-button").disabled = false;
  }
}

async function loadMods() {
  const data = await api("/api/mods");
  $("#mods-list").innerHTML = data.mods.length
    ? data.mods.map((mod) => `
      <div class="table-row">
        <div>
          <div class="table-title">${escapeHtml(mod.name)}</div>
          <div class="table-meta">${mod.enabled ? "已启用" : "已禁用"} · ${formatBytes(mod.size)} · ${formatDate(mod.mtimeMs)}</div>
        </div>
        <div class="table-actions">
          <button class="secondary" data-mod-toggle="${escapeHtml(mod.name)}">${mod.enabled ? "禁用" : "启用"}</button>
          <button class="danger" data-mod-delete="${escapeHtml(mod.name)}">删除</button>
        </div>
      </div>
    `).join("")
    : `<div class="table-row"><div class="table-title">还没有 mod 文件</div></div>`;
}

async function uploadMods(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  const files = $("#mod-files").files;
  if (!files.length) {
    showToast("请选择 .jar 文件。");
    return;
  }
  const formData = new FormData();
  for (const file of files) formData.append("mods", file);
  if ($("#overwrite-mods").checked) formData.append("overwrite", "true");
  await withButtonBusy(button, "上传中", async () => {
    await api("/api/mods/upload", { method: "POST", body: formData });
    $("#mod-files").value = "";
    setNeedsRestart(true, "Mod 已变更，需要重启 Minecraft 才会生效。");
    showToast("Mod 已上传，重启服务器后生效。");
    await loadMods();
  });
}

async function loadBackups() {
  const data = await api("/api/backups");
  state.remoteBackupConfig = data.remoteConfig || state.remoteBackupConfig;
  renderRemoteBackupConfig(state.remoteBackupConfig);
  $("#backups-list").innerHTML = data.backups.length
    ? data.backups.map((backup) => `
      <div class="table-row backup-row">
        <div>
          <div class="table-title">
            <span class="backup-type ${escapeHtml(backup.type || "world")}">${escapeHtml(backup.label || "备份")}</span>
            ${escapeHtml(backup.name)}
          </div>
          <div class="table-meta">${formatBytes(backup.size)} · ${formatDate(backup.createdAt || backup.mtimeMs)} · ${escapeHtml(backup.description || "")}</div>
          <div class="backup-contents">${(backup.contents || []).slice(0, 10).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}${(backup.contents || []).length > 10 ? `<span>+${(backup.contents || []).length - 10} 项</span>` : ""}</div>
        </div>
        <div class="table-actions">
          <a class="download-button" href="/api/backups/${encodeURIComponent(backup.name)}/download">下载</a>
          <button class="secondary" data-backup-upload="${escapeHtml(backup.name)}">上传远端</button>
          <button class="secondary" data-backup-restore="${escapeHtml(backup.name)}">恢复</button>
          <button class="danger" data-backup-delete="${escapeHtml(backup.name)}">删除</button>
        </div>
      </div>
    `).join("")
    : `<div class="table-row"><div class="table-title">还没有备份</div></div>`;
  renderRemoteBackups(data.remote || [], data.remoteError);
}

function backupTypeLabel(type) {
  if (type === "migration") return "完整迁移包";
  if (type === "config") return "配置备份";
  return "地图备份";
}

function renderRemoteBackupConfig(config = {}) {
  const statePill = $("#remote-backup-state");
  if (!statePill) return;
  statePill.className = "state-pill";
  if (config.enabled && config.configured) {
    statePill.textContent = config.autoUpload ? "已启用 / 自动上传" : "已启用";
    statePill.classList.add("running");
  } else if (config.enabled) {
    statePill.textContent = "配置未完整";
    statePill.classList.add("stopped");
  } else {
    statePill.textContent = "未启用";
    statePill.classList.add("stopped");
  }
  const active = document.activeElement;
  if (active?.closest?.("#remote-backup-form") && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)) return;
  $("#remote-backup-enabled").checked = Boolean(config.enabled);
  $("#remote-backup-endpoint").value = config.endpoint || "";
  $("#remote-backup-region").value = config.region || "";
  $("#remote-backup-bucket").value = config.bucket || "";
  $("#remote-backup-prefix").value = config.prefix || "";
  $("#remote-backup-access-key").placeholder = config.accessKeyIdConfigured ? "已配置，留空不修改" : "";
  $("#remote-backup-secret-key").placeholder = config.secretAccessKeyConfigured ? "已配置，留空不修改" : "";
  $("#remote-backup-force-path-style").checked = Boolean(config.forcePathStyle);
  $("#remote-backup-auto-upload").checked = Boolean(config.autoUpload);
}

function renderRemoteBackups(remote, error) {
  const list = $("#remote-backups-list");
  if (!list) return;
  if (error) {
    list.innerHTML = `<div class="table-row"><div><div class="table-title">远端读取失败</div><div class="table-meta">${escapeHtml(error)}</div></div></div>`;
    return;
  }
  const config = state.remoteBackupConfig || {};
  if (!config.enabled) {
    list.innerHTML = `<div class="table-row"><div class="table-title">远端备份未启用</div></div>`;
    return;
  }
  if (!remote.length) {
    list.innerHTML = `<div class="table-row"><div class="table-title">远端还没有备份</div></div>`;
    return;
  }
  list.innerHTML = remote.map((backup) => `
    <div class="table-row backup-row">
      <div>
        <div class="table-title">
          <span class="backup-type ${escapeHtml(backup.type || "world")}">${escapeHtml(backup.label || "备份")}</span>
          ${escapeHtml(backup.name)}
        </div>
        <div class="table-meta">${formatBytes(backup.size)} · ${formatDate(backup.uploadedAt)} · ${escapeHtml(backup.key)}</div>
      </div>
      <div class="table-actions">
        <button class="secondary" data-remote-import="${escapeHtml(backup.key)}" data-remote-local="${backup.local ? "true" : "false"}">${backup.local ? "重新拉回" : "拉回本地"}</button>
        <button class="danger" data-remote-delete="${escapeHtml(backup.key)}">删除远端</button>
      </div>
    </div>
  `).join("");
}

function readRemoteBackupForm() {
  return {
    enabled: $("#remote-backup-enabled").checked,
    endpoint: $("#remote-backup-endpoint").value.trim(),
    region: $("#remote-backup-region").value.trim(),
    bucket: $("#remote-backup-bucket").value.trim(),
    prefix: $("#remote-backup-prefix").value.trim(),
    accessKeyId: $("#remote-backup-access-key").value.trim(),
    secretAccessKey: $("#remote-backup-secret-key").value,
    forcePathStyle: $("#remote-backup-force-path-style").checked,
    autoUpload: $("#remote-backup-auto-upload").checked
  };
}

async function saveRemoteBackupConfig(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  await withButtonBusy(button, "保存中", async () => {
    const result = await api("/api/backups/remote/config", {
      method: "POST",
      body: readRemoteBackupForm()
    });
    state.remoteBackupConfig = result.config;
    $("#remote-backup-access-key").value = "";
    $("#remote-backup-secret-key").value = "";
    renderRemoteBackupConfig(result.config);
    showToast("远端备份配置已保存。");
    await loadBackups();
  });
}

async function testRemoteBackup() {
  const button = $("#test-remote-backup-button");
  await withButtonBusy(button, "测试中", async () => {
    await api("/api/backups/remote/test", { method: "POST", body: readRemoteBackupForm() });
    showToast("远端备份连接正常。");
    await loadBackups();
  });
}

async function uploadBackupRemote(name, button) {
  await withButtonBusy(button, "上传中", async () => {
    await api(`/api/backups/${encodeURIComponent(name)}/remote-upload`, { method: "POST" });
    showToast("备份已上传到远端。");
    await loadBackups();
  });
}

async function importRemoteBackup(key, button, hasLocal) {
  const overwrite = hasLocal ? confirm("本地已有同名备份，是否覆盖并拉回远端备份？") : false;
  if (hasLocal && !overwrite) return;
  await withButtonBusy(button, "拉回中", async () => {
    await api("/api/backups/remote/import", { method: "POST", body: { key, overwrite } });
    showToast("远端备份已拉回本地。");
    await loadBackups();
    await refreshStatus();
  });
}

async function deleteRemoteBackup(key, button) {
  if (!confirm(`删除远端备份 ${key}？`)) return;
  await withButtonBusy(button, "删除中", async () => {
    await api("/api/backups/remote", { method: "DELETE", body: { key } });
    showToast("远端备份已删除。");
    await loadBackups();
  });
}

async function restoreBackup(name, button) {
  const answer = prompt(`恢复 ${name} 会停止 Minecraft 并覆盖 data/workspace 中同名内容。输入 RESTORE 确认：`);
  if (answer !== "RESTORE") return;
  await withButtonBusy(button, "恢复中", async () => {
    const result = await api(`/api/backups/${encodeURIComponent(name)}/restore`, {
      method: "POST",
      body: { confirm: answer }
    });
    setNeedsRestart(true, "备份已恢复。请检查配置后启动或重启 Minecraft。");
    showToast(`已恢复 ${result.restore.restored.length} 项内容。`);
    await refreshAll();
  });
}

function buildCommandFromTemplate(form) {
  let command = form.dataset.commandTemplate;
  for (const input of Array.from(form.elements)) {
    if (!input.name) continue;
    const value = input.value.trim();
    command = command.replaceAll(`{${input.name}}`, value);
  }
  return command.replace(/\s+/g, " ").trim();
}

function bindEvents() {
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("#login-error").textContent = "";
    try {
      await api("/api/login", { method: "POST", body: { password: $("#login-password").value } });
      await setAuthenticated(true);
    } catch (error) {
      $("#login-error").textContent = error.message;
    }
  });

  $("#logout-button").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST" });
    } catch (error) {
      if (error.code !== "NOT_AUTHENTICATED") showToast(error.message);
    }
    await setAuthenticated(false);
  });

  $$(".tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      activateTab(button.dataset.tab);
    });
  });

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-jump-tab]");
    if (!target) return;
    activateTab(target.dataset.jumpTab);
  });

  $$("[data-action]").forEach((button) => {
    button.addEventListener("click", () => runServerAction(button.dataset.action).catch(showOperationError));
  });

  $("#config-form").addEventListener("submit", (event) => saveConfig(event).catch(showOperationError));
  $("#panel-password-form").addEventListener("submit", (event) => changePanelPassword(event).catch(showOperationError));
  $("#remote-backup-form").addEventListener("submit", (event) => saveRemoteBackupConfig(event).catch(showOperationError));
  $("#test-remote-backup-button").addEventListener("click", () => testRemoteBackup().catch(showOperationError));
  $("#setup-rcon-button").addEventListener("click", async () => {
    try {
      const result = await api("/api/rcon/setup", { method: "POST" });
      await loadConfig();
      setNeedsRestart(true, "RCON 配置已变更，需要重启 Minecraft 才会生效。");
      showToast(`RCON 已启用，密码已生成：${result.password}。重启服务器后可用。`);
    } catch (error) {
      await showOperationError(error);
    }
  });

  $("#connect-logs-button").addEventListener("click", connectLogs);
  $("#connect-chat-button").addEventListener("click", connectChat);
  $("#clear-chat-button").addEventListener("click", () => {
    state.chatMessages = [];
    renderChatMessages();
  });
  $("#chat-form").addEventListener("submit", (event) => sendChat(event).catch(showOperationError));
  $("#refresh-map-button").addEventListener("click", () => loadMapStatus().catch(showOperationError));
  $("#install-bluemap-button").addEventListener("click", () => installBlueMap().catch(showOperationError));
  $("#refresh-players-button").addEventListener("click", () => loadPlayers().catch(showOperationError));
  $("#refresh-mods-button").addEventListener("click", () => loadMods().catch(showOperationError));
  $("#refresh-backups-button").addEventListener("click", () => loadBackups().catch(showOperationError));
  $("#restart-from-notice-button").addEventListener("click", () => runServerAction("restart").catch(showOperationError));
  $("#clear-logs-button").addEventListener("click", () => {
    $("#log-output").textContent = "";
  });
  $("#command-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#command-input");
    try {
      await sendCommand(input.value);
      input.value = "";
    } catch (error) {
      await showOperationError(error);
    }
  });

  $$(".quick-grid form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button[type='submit']");
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "执行中";
      $("#player-command-response").textContent = "正在执行命令...";
      try {
        await sendCommand(buildCommandFromTemplate(form), "#player-command-response");
        await loadPlayers().catch(() => {});
      } catch (error) {
        await showOperationError(error);
        if (error.code !== "NOT_AUTHENTICATED") $("#player-command-response").textContent = error.message;
      } finally {
        button.disabled = false;
        button.textContent = originalText;
      }
    });
  });

  $("#clear-player-response-button").addEventListener("click", () => {
    $("#player-command-response").textContent = "还没有执行玩家命令。";
  });

  $("#online-player-list").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-player-name]");
    if (!chip) return;
    fillPlayerInputs(chip.dataset.playerName);
  });

  $("#mod-upload-form").addEventListener("submit", (event) => uploadMods(event).catch(showOperationError));
  $("#mods-list").addEventListener("click", async (event) => {
    const toggle = event.target.closest("[data-mod-toggle]");
    const del = event.target.closest("[data-mod-delete]");
    try {
      if (toggle) {
        await api(`/api/mods/${encodeURIComponent(toggle.dataset.modToggle)}/toggle`, { method: "POST" });
        setNeedsRestart(true, "Mod 状态已变更，需要重启 Minecraft 才会生效。");
        showToast("Mod 状态已修改，重启服务器后生效。");
        await loadMods();
      }
      if (del && confirm(`删除 ${del.dataset.modDelete}？`)) {
        await api(`/api/mods/${encodeURIComponent(del.dataset.modDelete)}`, { method: "DELETE" });
        setNeedsRestart(true, "Mod 已删除，需要重启 Minecraft 才会生效。");
        showToast("Mod 已删除，重启服务器后生效。");
        await loadMods();
      }
    } catch (error) {
      await showOperationError(error);
    }
  });

  $$("[data-create-backup]").forEach((button) => {
    button.addEventListener("click", async () => {
      const type = button.dataset.createBackup;
      try {
        await withButtonBusy(button, "创建中", async () => {
          showToast(`正在创建${backupTypeLabel(type)}...`);
          const result = await api("/api/backups", { method: "POST", body: { type } });
          showToast(result.remoteError ? `${backupTypeLabel(type)}已创建，但远端上传失败：${result.remoteError}` : `${backupTypeLabel(type)}已创建。`);
          await loadBackups();
          await refreshStatus();
        });
      } catch (error) {
        await showOperationError(error);
      }
    });
  });

  $("#backups-list").addEventListener("click", async (event) => {
    const del = event.target.closest("[data-backup-delete]");
    const upload = event.target.closest("[data-backup-upload]");
    const restore = event.target.closest("[data-backup-restore]");
    try {
      if (upload) {
        await uploadBackupRemote(upload.dataset.backupUpload, upload);
        return;
      }
      if (restore) {
        await restoreBackup(restore.dataset.backupRestore, restore);
        return;
      }
      if (del) {
        if (!confirm(`删除备份 ${del.dataset.backupDelete}？`)) return;
        await api(`/api/backups/${encodeURIComponent(del.dataset.backupDelete)}`, { method: "DELETE" });
        showToast("备份已删除。");
        await loadBackups();
        await refreshStatus();
      }
    } catch (error) {
      await showOperationError(error);
    }
  });

  $("#remote-backups-list").addEventListener("click", async (event) => {
    const remoteImport = event.target.closest("[data-remote-import]");
    const remoteDelete = event.target.closest("[data-remote-delete]");
    try {
      if (remoteImport) {
        await importRemoteBackup(remoteImport.dataset.remoteImport, remoteImport, remoteImport.dataset.remoteLocal === "true");
      }
      if (remoteDelete) {
        await deleteRemoteBackup(remoteDelete.dataset.remoteDelete, remoteDelete);
      }
    } catch (error) {
      await showOperationError(error);
    }
  });
}

bindEvents();
checkSession().catch((error) => {
  $("#login-view").hidden = false;
  $("#login-error").textContent = error.message;
});
