"use strict";
/* dodo_napcat（com.operit.napcat_pro）Operit 侧消费端 main.js
 *
 * P2：连接远端桥服务器（dodo_bridge_server），轮询 /api/pull → 调 Operit AI → /api/reply。
 * 设计对齐：
 *  - 服务器负责 收消息/队列/预过滤(at_only)/分段/原生引用/stale清理（需求13/14/15）
 *  - 本包负责 轮询消费 / 对话绑定(fixed|auto，需求11) / AI 生成 / 选择性忽略
 *  - 默认 enabled=false（需求13：写完群功能后不自动开）
 *  - 配置走 schema + NAPCAT_* env（需求：不硬编码，参数可调）
 */

const IPC_CHANNEL = "napcat_pro.bridge.";
const IGNORE_SENTINEL = "[[QQ_BRIDGE_IGNORE]]";
const CONFIG_PATH = "/sdcard/Download/Operit/plugins/com.operit.napcat_pro/config.json";
const STATE_PATH = "/sdcard/Download/Operit/plugins/com.operit.napcat_pro/state.json";

// ==================== 配置 schema（持久化 > env > 默认；数值 clamp；枚举校验） ====================
const DEFAULTS = {
  enabled: false,                    // 需求13：默认不自动开
  bridgeUrl: "http://101.43.38.124:8080",
  bridgeToken: "",
  pollIntervalMs: 3000,              // 3000~60000
  pullCount: 3,                      // 1~10，批量领取（BUG-02）
  chatBindingMode: "fixed",          // fixed=绑 fixedChatId / auto=按 group:gid·private:uid 自动开对话（需求11）
  fixedChatId: "",
  fixedChatTitle: "",
  characterCardName: "",
  aiTimeoutMs: 120000,               // 10000~600000
  concurrency: 1,                    // P2 串行
};

// env 覆盖映射（需求：可调参数都走 env）
const ENV_MAP = {
  enabled: "NAPCAT_ENABLED",
  bridgeUrl: "NAPCAT_BRIDGE_URL",
  bridgeToken: "NAPCAT_BRIDGE_TOKEN",
  pollIntervalMs: "NAPCAT_POLL_INTERVAL_MS",
  pullCount: "NAPCAT_PULL_COUNT",
  chatBindingMode: "NAPCAT_CHAT_BINDING_MODE",
  fixedChatId: "NAPCAT_FIXED_CHAT_ID",
  characterCardName: "NAPCAT_CHARACTER_CARD",
  aiTimeoutMs: "NAPCAT_AI_TIMEOUT_MS",
};

function asText(v) { return v == null ? "" : String(v); }
function clampInt(v, min, max, dft) {
  const n = Number(v);
  if (!isFinite(n)) return dft;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function boolVal(v, dft) { return v === undefined ? dft : v === true || v === "true" || v === 1 || v === "1"; }

function envValue(key) {
  try {
    if (typeof getEnv === "function") {
      const v = getEnv(key);
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
  } catch (e) { /* ignore */ }
  return undefined;
}

function normalize(raw) {
  raw = raw || {};
  const mode = asText(raw.chatBindingMode || "").trim().toLowerCase();
  return {
    enabled: boolVal(raw.enabled, DEFAULTS.enabled),
    bridgeUrl: asText(raw.bridgeUrl || DEFAULTS.bridgeUrl).trim(),
    bridgeToken: asText(raw.bridgeToken || "").trim(),
    pollIntervalMs: clampInt(raw.pollIntervalMs, 3000, 60000, DEFAULTS.pollIntervalMs),
    pullCount: clampInt(raw.pullCount, 1, 10, DEFAULTS.pullCount),
    chatBindingMode: (mode === "auto") ? "auto" : "fixed",
    fixedChatId: asText(raw.fixedChatId || "").trim(),
    fixedChatTitle: asText(raw.fixedChatTitle || "").trim(),
    characterCardName: asText(raw.characterCardName || "").trim(),
    aiTimeoutMs: clampInt(raw.aiTimeoutMs, 10000, 600000, DEFAULTS.aiTimeoutMs),
    concurrency: 1,
  };
}

function readJson(path, fallback) {
  try {
    const r = Tools.Files.read({ path: path, environment: "android" });
    const t = asText(r.content || r.text || "").trim();
    return t ? JSON.parse(t) : fallback;
  } catch (e) { return fallback; }
}
function writeJson(path, obj) {
  try {
    Tools.Files.write(path, JSON.stringify(obj, null, 2), false, "android");
  } catch (e) { /* ignore */ }
}
function ensureDir() {
  try {
    toolCall("super_admin:terminal", { command: "mkdir -p " + "'" + CONFIG_PATH.replace(/\/[^/]+$/, "") + "'", timeoutMs: 5000 });
  } catch (e) { /* ignore */ }
}

let cache = null;
function loadConfig() {
  const raw = readJson(CONFIG_PATH, {});
  // env 覆盖
  Object.keys(ENV_MAP).forEach((k) => {
    const ev = envValue(ENV_MAP[k]);
    if (ev !== undefined) raw[k] = ev;
  });
  cache = normalize(raw);
  return cache;
}
function getConfig() {
  if (!cache) loadConfig();
  return cache;
}
function saveConfig(patch) {
  const next = normalize(Object.assign({}, getConfig(), patch || {}));
  ensureDir();
  writeJson(CONFIG_PATH, next);
  cache = next;
  return next;
}

// ==================== 状态 ====================
let state = {
  running: false,
  loopGeneration: 0,
  processing: false,
  lastPollAt: 0,
  lastMessageAt: 0,
  lastReplyAt: 0,
  processedCount: 0,
  ignoredCount: 0,
  failedCount: 0,
  lastError: "",
  startedAt: 0,
  bindings: {},   // auto 模式：conversation_key -> chatId
};
let stateDirty = false;

function persistState() {
  if (!stateDirty) return;
  stateDirty = false;
  try { writeJson(STATE_PATH, state); } catch (e) { /* ignore */ }
}
function loadState() {
  const saved = readJson(STATE_PATH, {});
  if (saved && typeof saved === "object") state = Object.assign(state, saved);
}
function touchState() { stateDirty = true; }

// ==================== 传输层（RemoteServerTransport） ====================
async function httpJson(path, method, body, timeoutMs) {
  const cfg = getConfig();
  const headers = { "Accept": "application/json", "Content-Type": "application/json; charset=utf-8" };
  if (cfg.bridgeToken) headers["X-Bridge-Token"] = cfg.bridgeToken;
  const res = await Tools.Net.http({
    url: cfg.bridgeUrl.replace(/\/+$/, "") + path,
    method: method || "GET",
    headers: headers,
    body: body ? JSON.stringify(body) : undefined,
    timeout_ms: timeoutMs || 15000,
  });
  const txt = asText(res.body || res.content || res.text || "");
  try { return JSON.parse(txt); } catch (e) { return { ok: false, error: "bad json response", raw: txt.slice(0, 300) }; }
}
async function pull(count) { return await httpJson("/api/pull?count=" + (count || 1), "GET", null, 15000); }
async function reply(id, text) { return await httpJson("/api/reply", "POST", { id: id, reply: text }, 30000); }
async function ignoreMsg(id, reason) { return await httpJson("/api/ignore", "POST", { id: id, reason: reason || "" }, 15000); }
async function requeue(id) { try { await httpJson("/api/requeue", "POST", { id: id }, 15000); } catch (e) { /* ignore */ } }
async function serverHealth() { return await httpJson("/health", "GET", null, 8000); }
async function serverStats() { return await httpJson("/api/queue/stats", "GET", null, 8000); }
async function serverConfig(patch) { return await httpJson("/api/config", "POST", patch || {}, 15000); }

// ==================== 角色卡解析 ====================
async function resolveCardId() {
  const cfg = getConfig();
  if (!cfg.characterCardName) return undefined;
  const result = await Tools.Chat.listCharacterCards();
  const cards = Array.isArray(result?.cards) ? result.cards
    : (Array.isArray(result?.data?.cards) ? result.data.cards : []);
  const card = cards.find((item) => asText(item?.name).trim() === cfg.characterCardName.trim());
  return card?.id ? asText(card.id) : undefined;
}

// ==================== 对话绑定（fixed | auto，需求11） ====================
function conversationKey(item) {
  return item.message_type === "group" ? "group:" + item.group_id : "private:" + item.user_id;
}
function conversationTitle(item) {
  return item.message_type === "group" ? ("QQ群 " + item.group_id) : ("QQ私聊 " + item.user_id);
}
async function findChatById(chatId) {
  const found = await Tools.Chat.findChat({ query: chatId, match: "exact", index: 0 });
  return (found?.chat?.id || "") === chatId;
}
async function resolveChatId(item) {
  const cfg = getConfig();
  const key = conversationKey(item);
  if (cfg.chatBindingMode === "fixed" && cfg.fixedChatId) {
    const ok = await findChatById(cfg.fixedChatId);
    if (!ok) throw new Error("固定绑定对话不存在: " + cfg.fixedChatId + "（请先 bind_chat / bind_current_chat）");
    return { chatId: cfg.fixedChatId, key: key, title: cfg.fixedChatTitle || "QQ桥接" };
  }
  // auto：按 conversation_key 复用/新建 Operit 对话
  if (state.bindings[key]) {
    const ok = await findChatById(state.bindings[key]);
    if (ok) return { chatId: state.bindings[key], key: key, title: conversationTitle(item) };
  }
  const cardId = await resolveCardId();
  const created = await Tools.Chat.createNew("QQ桥接", false, cardId || undefined);
  const chatId = asText(created?.chatId || created?.data?.chatId || "").trim();
  if (!chatId) throw new Error("auto 模式创建对话失败");
  try { await Tools.Chat.updateTitle(chatId, conversationTitle(item)); } catch (e) { /* ignore */ }
  state.bindings[key] = chatId;
  touchState();
  return { chatId: chatId, key: key, title: conversationTitle(item) };
}

// ==================== AI 调用 ====================
function stripModelMarkup(text) {
  let t = asText(text);
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/gi, "");
  t = t.replace(/<tool_[^>]*>[\s\S]*?<\/tool_[^>]*>/gi, "").replace(/<tool_result_[^>]*>[\s\S]*?<\/tool_result_[^>]*>/gi, "");
  t = t.replace(/<attachment\b[^>]*>[\s\S]*?<\/attachment>/gi, "");
  t = t.replace(/<\/?(think|attachment|tool_\w+|tool_result_\w+)[^>]*>/gi, "");
  t = t.replace(/<[^>]+>/g, "");
  return t.trim();
}

async function processOne() {
  const cfg = getConfig();
  if (state.processing) return { ok: true, busy: true };
  state.processing = true;
  state.lastPollAt = Date.now();
  let itemId = "";
  try {
    const pulled = await pull(cfg.pullCount);
    const items = Array.isArray(pulled?.items) ? pulled.items : [];
    if (!items.length) {
      state.lastError = "";
      return { ok: true, hasMessage: false };
    }
    const results = [];
    for (const item of items) {
      itemId = asText(item?.id || "");
      const prompt = asText(item?.prompt || "").trim();
      if (!itemId || !prompt) { await requeue(itemId); continue; }
      state.lastMessageAt = Date.now();
      const { chatId } = await resolveChatId(item);
      const cardId = await resolveCardId();
      const aiResult = await Tools.Chat.sendMessage(
        prompt, chatId, cardId || undefined, "QQ桥接",
        { persist_turn: true, notify_reply: false, hide_user_message: true, disable_warning: true, timeout_ms: cfg.aiTimeoutMs }
      );
      const cleaned = stripModelMarkup(aiResult?.aiResponse || aiResult?.data?.aiResponse || "");
      if (cleaned === IGNORE_SENTINEL) {
        await ignoreMsg(itemId, "ai_selective_ignore");
        state.ignoredCount += 1;
        results.push({ id: itemId, ignored: true });
        continue;
      }
      const replyText = cleaned || "我在。";
      await reply(itemId, replyText);
      state.processedCount += 1;
      results.push({ id: itemId, replied: replyText.slice(0, 60) });
    }
    state.lastError = "";
    return { ok: true, hasMessage: results.length > 0, results: results };
  } catch (error) {
    const msg = String(error?.message || error);
    state.lastError = msg;
    state.failedCount += 1;
    if (itemId) await requeue(itemId);
    return { ok: false, error: msg, id: itemId || "" };
  } finally {
    state.processing = false;
    persistState();
  }
}

// ==================== 轮询循环（generation 守护） ====================
async function loop(generation) {
  state.running = true;
  state.startedAt = Date.now();
  touchState();
  while (getConfig().enabled && generation === state.loopGeneration) {
    await processOne();
    if (!getConfig().enabled || generation !== state.loopGeneration) break;
    await Tools.System.sleep(getConfig().pollIntervalMs);
  }
  if (generation === state.loopGeneration) {
    state.running = false;
    touchState();
    persistState();
  }
}
function startLoop() {
  if (state.running) return false;
  state.loopGeneration += 1;
  void loop(state.loopGeneration);
  return true;
}
function stopLoop() {
  if (!state.running) return false;
  state.loopGeneration += 1;   // 作废旧代际，循环自然退出
  state.running = false;
  touchState();
  persistState();
  return true;
}

// ==================== 工具实现（IPC 处理器） ====================
function publicConfig() {
  const c = getConfig();
  return {
    enabled: c.enabled,
    bridgeUrl: c.bridgeUrl,
    bridgeTokenConfigured: !!c.bridgeToken,
    pollIntervalMs: c.pollIntervalMs,
    pullCount: c.pullCount,
    chatBindingMode: c.chatBindingMode,
    fixedChatId: c.fixedChatId,
    fixedChatTitle: c.fixedChatTitle,
    characterCardName: c.characterCardName,
    aiTimeoutMs: c.aiTimeoutMs,
  };
}
function publicState() {
  return {
    running: state.running,
    processing: state.processing,
    startedAt: state.startedAt,
    lastPollAt: state.lastPollAt,
    lastMessageAt: state.lastMessageAt,
    lastReplyAt: state.lastReplyAt,
    processedCount: state.processedCount,
    ignoredCount: state.ignoredCount,
    failedCount: state.failedCount,
    lastError: state.lastError,
    bindingCount: Object.keys(state.bindings || {}).length,
  };
}

async function handleConfigure(payload) {
  payload = payload || {};
  const prev = getConfig();
  const next = saveConfig({
    enabled: payload.enabled !== undefined ? !!payload.enabled : prev.enabled,
    bridgeUrl: payload.bridge_url !== undefined ? asText(payload.bridge_url).trim() : prev.bridgeUrl,
    bridgeToken: payload.token !== undefined ? asText(payload.token).trim() : prev.bridgeToken,
    pollIntervalMs: payload.poll_interval_ms !== undefined ? Number(payload.poll_interval_ms) : prev.pollIntervalMs,
    pullCount: payload.pull_count !== undefined ? Number(payload.pull_count) : prev.pullCount,
    chatBindingMode: payload.chat_binding_mode !== undefined ? asText(payload.chat_binding_mode).trim() : prev.chatBindingMode,
    fixedChatId: payload.fixed_chat_id !== undefined ? asText(payload.fixed_chat_id).trim() : prev.fixedChatId,
    characterCardName: payload.character_card_name !== undefined ? asText(payload.character_card_name).trim() : prev.characterCardName,
    aiTimeoutMs: payload.ai_timeout_ms !== undefined ? Number(payload.ai_timeout_ms) : prev.aiTimeoutMs,
  });
  return { success: true, config: publicConfig() };
}

async function handleStart(payload) {
  payload = payload || {};
  const cfg = getConfig();
  if (!cfg.bridgeUrl) throw new Error("未配置服务器地址（bridge_url）");
  if (!cfg.bridgeToken) throw new Error("未配置 Bridge Token");
  // 验证服务器连通
  const health = await serverHealth();
  if (!health || health.ok !== true) throw new Error("服务器不可达或鉴权失败");
  // fixed 模式必须已绑定
  if (cfg.chatBindingMode === "fixed" && !cfg.fixedChatId) throw new Error("fixed 模式尚未绑定对话（请先 bind_chat / bind_current_chat）");
  // 同步回复规则到服务器（群模式默认 at_only，需求14）
  try { await serverConfig({ group_reply_mode: "at_only" }); } catch (e) { /* 服务器可自行管理 */ }
  const started = startLoop();
  return { success: true, started: started, health: { ws_connected: !!health.ws_connected, bot_qq: health.bot_qq } };
}

async function handleStop() {
  const stopped = stopLoop();
  const cfg = getConfig();
  if (cfg.enabled) { saveConfig({ enabled: false }); }
  return { success: true, stopped: stopped };
}

async function handleStatus() {
  let health = null, stats = null;
  try { health = await serverHealth(); } catch (e) { health = { ok: false, error: "服务器不可达" }; }
  try { stats = await serverStats(); } catch (e) { stats = null; }
  return { success: true, config: publicConfig(), state: publicState(), server: health, queue: stats };
}

async function handleRunOnce() {
  return await processOne();
}

async function handleBindChat(payload) {
  payload = payload || {};
  const chatId = asText(payload.chat_id || "").trim();
  if (!chatId) throw new Error("chat_id 不能为空");
  const exists = await findChatById(chatId);
  if (!exists) throw new Error("对话不存在: " + chatId);
  saveConfig({
    chatBindingMode: "fixed",
    fixedChatId: chatId,
    fixedChatTitle: asText(payload.chat_title || "").trim(),
    characterCardName: payload.character_card_name !== undefined ? asText(payload.character_card_name).trim() : getConfig().characterCardName,
  });
  return { success: true, config: publicConfig() };
}

async function handleBindCurrentChat(payload) {
  payload = payload || {};
  const result = await Tools.Chat.listChats({ limit: 100, sort_by: "updatedAt", sort_order: "desc" });
  const data = result?.data && typeof result.data === "object" ? result.data : result;
  const chats = Array.isArray(data?.chats) ? data.chats : [];
  const currentId = asText(data?.currentChatId || chats.find((item) => item?.isCurrent)?.id || "").trim();
  if (!currentId) throw new Error("无法识别当前 Operit 对话");
  const chat = chats.find((item) => asText(item?.id || "") === currentId) || {};
  const requestedCard = asText(payload.character_card_name || "").trim();
  saveConfig({
    chatBindingMode: "fixed",
    fixedChatId: currentId,
    fixedChatTitle: asText(chat?.title || "").trim(),
    characterCardName: requestedCard || asText(chat?.characterCardName || getConfig().characterCardName || "").trim(),
  });
  return { success: true, config: publicConfig(), boundCurrentChat: true };
}

async function handleSetReplyRules(payload) {
  payload = payload || {};
  // 透传规则到服务器（群模式/私聊模式/关键词/上下文/防抖/分条）
  const patch = {};
  if (payload.owner_qq !== undefined) patch.owner_qq = Number(payload.owner_qq) || 0;
  if (payload.owner_always_reply !== undefined) patch.owner_always_reply = !!payload.owner_always_reply;
  if (payload.group_reply_mode !== undefined) patch.group_reply_mode = asText(payload.group_reply_mode).trim();
  if (payload.private_reply_mode !== undefined) patch.private_reply_mode = asText(payload.private_reply_mode).trim();
  if (payload.keywords !== undefined) patch.keywords = Array.isArray(payload.keywords) ? payload.keywords : asText(payload.keywords).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (payload.private_whitelist !== undefined) patch.private_whitelist = Array.isArray(payload.private_whitelist) ? payload.private_whitelist : [];
  if (payload.group_context_limit !== undefined) patch.group_context_limit = Number(payload.group_context_limit);
  if (payload.private_context_limit !== undefined) patch.private_context_limit = Number(payload.private_context_limit);
  if (payload.debounce_seconds !== undefined) patch.debounce_seconds = Number(payload.debounce_seconds);
  if (payload.split_reply_enabled !== undefined) patch.split_reply_enabled = !!payload.split_reply_enabled;
  if (payload.reply_part_delay_ms !== undefined) patch.reply_part_delay_ms = Number(payload.reply_part_delay_ms);
  if (payload.quote_reply_enabled !== undefined) patch.quote_reply_enabled = !!payload.quote_reply_enabled;
  const result = await serverConfig(patch);
  return { success: true, server: result };
}

async function handleTestServer() {
  const health = await serverHealth();
  return { success: true, health: health };
}

// ==================== IPC 注册 ====================
let ipcRegistered = false;
function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  const on = (name, fn) => ToolPkg.ipc.on(IPC_CHANNEL + name, async (payload) => await fn(payload || {}));
  on("configure", handleConfigure);
  on("start", handleStart);
  on("stop", handleStop);
  on("status", handleStatus);
  on("run_once", handleRunOnce);
  on("bind_chat", handleBindChat);
  on("bind_current_chat", handleBindCurrentChat);
  on("set_reply_rules", handleSetReplyRules);
  on("test_server", handleTestServer);
}

// ==================== 生命周期 ====================
function onApplicationCreate() {
  loadState();
  loadConfig();
  registerIpc();
}

function registerToolPkg() {
  registerIpc();
  // P5 在此注册 compose_dsl + WebView UI（两套并存，需求5）
  return true;
}

// 顶层立即注册（universal 同款：ToolPkg.ipc 需模块加载时注册，而非等生命周期）
loadState();
loadConfig();
registerIpc();

exports.onApplicationCreate = onApplicationCreate;
exports.registerToolPkg = registerToolPkg;
exports.IPC_CHANNEL = IPC_CHANNEL;