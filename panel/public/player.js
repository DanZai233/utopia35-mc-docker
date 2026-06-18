"use strict";

const playerState = {
  authenticated: false,
  user: null,
  chatSocket: null,
  chatMessages: []
};

const $ = (selector) => document.querySelector(selector);

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "-";
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

function playerStatusLabel(status) {
  if (status === "approved") return "已加入白名单";
  if (status === "rejected") return "申请被拒绝";
  if (status === "disabled") return "账号已禁用";
  return "待处理";
}

function setAuthenticated(authenticated, user = null) {
  playerState.authenticated = authenticated;
  playerState.user = user;
  $("#player-auth-view").hidden = authenticated;
  $("#player-app-view").hidden = !authenticated;
  if (authenticated) {
    renderUser(user);
    refreshPlayerHome().catch(showError);
    if (!playerState.chatSocket) connectChat();
  } else {
    if (playerState.chatSocket) {
      playerState.chatSocket.close();
      playerState.chatSocket = null;
    }
    playerState.chatMessages = [];
    renderChatMessages();
  }
  window.scrollTo({ top: 0, behavior: "auto" });
}

function renderUser(user) {
  playerState.user = user;
  const status = user?.status || "pending";
  $("#player-account-state").className = `state-pill ${status === "approved" ? "running" : "stopped"}`;
  $("#player-account-state").textContent = playerStatusLabel(status);
  $("#player-metric-username").textContent = user?.username || "-";
  $("#player-metric-minecraft").textContent = user?.minecraftName || "未绑定";
  $("#player-metric-status").textContent = playerStatusLabel(status);
  $("#player-profile-minecraft").value = user?.minecraftName || "";
  const message = $("#player-profile-message");
  if (user?.note) {
    message.textContent = `备注：${user.note}`;
    message.classList.toggle("error", status === "rejected");
  } else if (status === "approved") {
    message.textContent = `已在 ${formatDate(user.whitelistApprovedAt)} 加入白名单。`;
    message.classList.remove("error");
  } else {
    message.textContent = "绑定 Minecraft 名称后，可以申请加入服务器白名单。";
    message.classList.remove("error");
  }
}

function renderOnlinePlayers(data) {
  $("#player-metric-online").textContent = data.online === null ? `${(data.players || []).length} 人` : `${data.online}/${data.max}`;
  const list = $("#player-online-list");
  const players = data.players || [];
  list.innerHTML = players.length
    ? players.map((player) => `<span class="player-chip readonly">${escapeHtml(player)}</span>`).join("")
    : `<div class="empty-state">${escapeHtml(data.raw || "当前没有玩家在线。")}</div>`;
}

async function refreshPlayerHome() {
  const [session, players, history] = await Promise.allSettled([
    api("/api/player/me"),
    api("/api/player/players"),
    api("/api/player/chat/history")
  ]);
  if (session.status === "fulfilled") renderUser(session.value.user);
  if (players.status === "fulfilled") renderOnlinePlayers(players.value);
  else renderOnlinePlayers({ players: [], online: null, max: null, raw: players.reason.message });
  if (history.status === "fulfilled") {
    playerState.chatMessages = history.value.messages || [];
    renderChatMessages();
  }
}

async function checkSession() {
  const session = await api("/api/player/session");
  setAuthenticated(session.authenticated, session.user);
}

async function login(event) {
  event.preventDefault();
  $("#player-login-error").textContent = "";
  try {
    const result = await api("/api/player/login", {
      method: "POST",
      body: {
        username: $("#player-login-username").value,
        password: $("#player-login-password").value
      }
    });
    setAuthenticated(true, result.user);
  } catch (error) {
    $("#player-login-error").textContent = error.message;
  }
}

async function register(event) {
  event.preventDefault();
  $("#player-register-error").textContent = "";
  try {
    const result = await api("/api/player/register", {
      method: "POST",
      body: {
        username: $("#player-register-username").value,
        minecraftName: $("#player-register-minecraft").value,
        password: $("#player-register-password").value
      }
    });
    setAuthenticated(true, result.user);
    showToast("注册成功，已登录玩家中心。");
  } catch (error) {
    $("#player-register-error").textContent = error.message;
  }
}

async function logout() {
  await api("/api/player/logout", { method: "POST" }).catch(() => {});
  setAuthenticated(false);
}

async function saveProfile(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  await withButtonBusy(button, "保存中", async () => {
    const result = await api("/api/player/profile", {
      method: "POST",
      body: { minecraftName: $("#player-profile-minecraft").value }
    });
    renderUser(result.user);
    showToast("Minecraft 名称已保存。");
  });
}

async function requestWhitelist() {
  const button = $("#player-request-whitelist-button");
  await withButtonBusy(button, "申请中", async () => {
    const result = await api("/api/player/whitelist/request", { method: "POST" });
    renderUser(result.user);
    showToast(result.autoApproved ? "已自动加入白名单。" : "申请已提交，等待管理员处理。");
  });
}

function setChatState(label, running = false) {
  const statePill = $("#player-chat-state");
  statePill.textContent = label;
  statePill.className = `state-pill ${running ? "running" : "stopped"}`;
}

function addChatMessage(message) {
  if (!message?.id) return;
  if (playerState.chatMessages.some((item) => item.id === message.id)) return;
  playerState.chatMessages.push(message);
  if (playerState.chatMessages.length > 200) playerState.chatMessages = playerState.chatMessages.slice(-200);
  renderChatMessages();
}

function renderChatMessages() {
  const output = $("#player-chat-output");
  if (!output) return;
  if (!playerState.chatMessages.length) {
    output.innerHTML = `<div class="empty-state">还没有聊天消息。</div>`;
    return;
  }
  output.innerHTML = playerState.chatMessages.map((message) => {
    const own = playerState.user && (message.author === playerState.user.minecraftName || message.author === playerState.user.username);
    const type = own ? "panel" : message.type === "system" ? "system" : "player";
    const time = message.logTime || (message.time ? new Date(message.time).toLocaleTimeString() : "");
    return `
      <article class="chat-message ${type}">
        <div class="chat-meta">
          <strong>${escapeHtml(message.author || "系统")}</strong>
          <span>${escapeHtml(time)}</span>
        </div>
        <div class="chat-bubble">${escapeHtml(message.text || "")}</div>
      </article>
    `;
  }).join("");
  output.scrollTop = output.scrollHeight;
}

function connectChat() {
  if (playerState.chatSocket && playerState.chatSocket.readyState === WebSocket.OPEN) {
    playerState.chatSocket.close();
    return;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  playerState.chatSocket = new WebSocket(`${protocol}//${location.host}/ws/player-chat`);
  setChatState("连接中", false);
  $("#player-connect-chat-button").textContent = "断开聊天";
  playerState.chatSocket.addEventListener("open", () => setChatState("已连接", true));
  playerState.chatSocket.addEventListener("message", (event) => {
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
  playerState.chatSocket.addEventListener("close", () => {
    setChatState("未连接", false);
    $("#player-connect-chat-button").textContent = "连接聊天";
    playerState.chatSocket = null;
  });
}

async function sendChat(event) {
  event.preventDefault();
  const input = $("#player-chat-input");
  const message = input.value.trim();
  if (!message) {
    showToast("聊天内容不能为空。");
    return;
  }
  const button = event.currentTarget.querySelector("button[type='submit']");
  await withButtonBusy(button, "发送中", async () => {
    const result = await api("/api/player/chat/send", { method: "POST", body: { message } });
    input.value = "";
    addChatMessage(result.message);
  });
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

async function showError(error) {
  if (error.code === "PLAYER_NOT_AUTHENTICATED") {
    setAuthenticated(false);
    return;
  }
  showToast(error.message);
}

function bindEvents() {
  $("#player-login-form").addEventListener("submit", login);
  $("#player-register-form").addEventListener("submit", register);
  $("#player-logout-button").addEventListener("click", () => logout().catch(showError));
  $("#player-profile-form").addEventListener("submit", (event) => saveProfile(event).catch(showError));
  $("#player-request-whitelist-button").addEventListener("click", () => requestWhitelist().catch(showError));
  $("#player-refresh-button").addEventListener("click", () => refreshPlayerHome().catch(showError));
  $("#player-refresh-online-button").addEventListener("click", () => api("/api/player/players").then(renderOnlinePlayers).catch(showError));
  $("#player-connect-chat-button").addEventListener("click", connectChat);
  $("#player-clear-chat-button").addEventListener("click", () => {
    playerState.chatMessages = [];
    renderChatMessages();
  });
  $("#player-chat-form").addEventListener("submit", (event) => sendChat(event).catch(showError));
}

bindEvents();
checkSession().catch((error) => {
  $("#player-auth-view").hidden = false;
  $("#player-login-error").textContent = error.message;
});
