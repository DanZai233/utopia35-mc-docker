"use strict";

const state = {
  configFields: [],
  configValues: {},
  logsSocket: null,
  statusTimer: null
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
    throw new Error(message || `请求失败：${response.status}`);
  }
  return data;
}

function setAuthenticated(authenticated) {
  $("#login-view").hidden = authenticated;
  $("#app-view").hidden = !authenticated;
  if (authenticated) {
    refreshAll();
    state.statusTimer = setInterval(refreshStatus, 5000);
  } else if (state.statusTimer) {
    clearInterval(state.statusTimer);
  }
}

async function checkSession() {
  const session = await api("/api/session");
  $("#login-warning").hidden = !session.defaultPassword;
  setAuthenticated(session.authenticated);
}

async function refreshAll() {
  await Promise.all([refreshStatus(), loadConfig(), loadMods(), loadBackups()]);
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

  const warning = $("#security-warning");
  if (status.panel.defaultPassword) {
    warning.hidden = false;
    warning.textContent = "面板仍在使用默认密码 change-me。不要把面板暴露到公网，先修改 .env 里的 PANEL_PASSWORD。";
  } else {
    warning.hidden = true;
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
  showToast("配置已保存，重启服务器后生效。");
  await refreshAll();
}

async function runServerAction(action) {
  await api(`/api/server/${action}`, { method: "POST" });
  showToast(`服务器${action === "start" ? "启动" : action === "stop" ? "停止" : "重启"}指令已发送。`);
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
  });
}

async function sendCommand(command) {
  const result = await api("/api/command", { method: "POST", body: { command } });
  $("#command-response").textContent = result.response || "(命令已发送，无返回内容)";
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
  const files = $("#mod-files").files;
  if (!files.length) {
    showToast("请选择 .jar 文件。");
    return;
  }
  const formData = new FormData();
  for (const file of files) formData.append("mods", file);
  if ($("#overwrite-mods").checked) formData.append("overwrite", "true");
  await api("/api/mods/upload", { method: "POST", body: formData });
  $("#mod-files").value = "";
  showToast("Mod 已上传，重启服务器后生效。");
  await loadMods();
}

async function loadBackups() {
  const data = await api("/api/backups");
  $("#backups-list").innerHTML = data.backups.length
    ? data.backups.map((backup) => `
      <div class="table-row">
        <div>
          <div class="table-title">${escapeHtml(backup.name)}</div>
          <div class="table-meta">${formatBytes(backup.size)} · ${formatDate(backup.mtimeMs)}</div>
        </div>
        <div class="table-actions">
          <a class="download-button" href="/api/backups/${encodeURIComponent(backup.name)}/download">下载</a>
        </div>
      </div>
    `).join("")
    : `<div class="table-row"><div class="table-title">还没有备份</div></div>`;
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
      setAuthenticated(true);
    } catch (error) {
      $("#login-error").textContent = error.message;
    }
  });

  $("#logout-button").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    setAuthenticated(false);
  });

  $$(".tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".tabs button").forEach((item) => item.classList.toggle("active", item === button));
      $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${button.dataset.tab}`));
      if (button.dataset.tab === "console" && !state.logsSocket) connectLogs();
    });
  });

  $$("[data-action]").forEach((button) => {
    button.addEventListener("click", () => runServerAction(button.dataset.action).catch((error) => showToast(error.message)));
  });

  $("#config-form").addEventListener("submit", (event) => saveConfig(event).catch((error) => showToast(error.message)));
  $("#setup-rcon-button").addEventListener("click", async () => {
    const result = await api("/api/rcon/setup", { method: "POST" });
    await loadConfig();
    showToast(`RCON 已启用，密码已生成：${result.password}。重启服务器后可用。`);
  });

  $("#connect-logs-button").addEventListener("click", connectLogs);
  $("#clear-logs-button").addEventListener("click", () => {
    $("#log-output").textContent = "";
  });
  $("#command-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#command-input");
    await sendCommand(input.value);
    input.value = "";
  });

  $$(".quick-grid form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await sendCommand(buildCommandFromTemplate(form));
    });
  });

  $("#mod-upload-form").addEventListener("submit", (event) => uploadMods(event).catch((error) => showToast(error.message)));
  $("#mods-list").addEventListener("click", async (event) => {
    const toggle = event.target.closest("[data-mod-toggle]");
    const del = event.target.closest("[data-mod-delete]");
    if (toggle) {
      await api(`/api/mods/${encodeURIComponent(toggle.dataset.modToggle)}/toggle`, { method: "POST" });
      showToast("Mod 状态已修改，重启服务器后生效。");
      await loadMods();
    }
    if (del && confirm(`删除 ${del.dataset.modDelete}？`)) {
      await api(`/api/mods/${encodeURIComponent(del.dataset.modDelete)}`, { method: "DELETE" });
      showToast("Mod 已删除，重启服务器后生效。");
      await loadMods();
    }
  });

  $("#create-backup-button").addEventListener("click", async () => {
    showToast("正在创建备份...");
    await api("/api/backups", { method: "POST" });
    showToast("备份已创建。");
    await loadBackups();
  });
}

bindEvents();
checkSession().catch((error) => {
  $("#login-view").hidden = false;
  $("#login-error").textContent = error.message;
});
