"use strict";
/* dodo_napcat（com.operit.napcat_pro）Operit 侧消费端 main.js
 *
 * P2：连接远端桥服务器（dodo_bridge_server），轮询 /api/pull → 调 Operit AI → /api/reply。
 * 设计对齐：
 *  - 服务器负责 收消息/队列/预过滤(keyword_or_at)/分段/原生引用/stale清理（需求13/14/15）
 *  - 本包负责 轮询消费 / 对话绑定(fixed|auto，需求11) / AI 生成 / 选择性忽略
 *  - 默认 enabled=false（需求13：写完群功能后不自动开）；群默认 keyword_or_at（回艾特+关键词，需求14 2026-08-17 更新）
 *  - 配置走 schema + NAPCAT_* env（需求：不硬编码，参数可调）
 */

const IPC_CHANNEL = "napcat_pro.bridge.";
const IGNORE_SENTINEL = "[[QQ_BRIDGE_IGNORE]]";
const CONFIG_PATH = "/sdcard/Download/Operit/plugins/com.operit.napcat_pro/config.json";
const STATE_PATH = "/sdcard/Download/Operit/plugins/com.operit.napcat_pro/state.json";

// ==================== 配置 schema（持久化 > env > 默认；数值 clamp；枚举校验） ====================
const DEFAULTS = {
  enabled: false,                    // 需求13：默认不自动开
  bridgeUrl: "",                     // 用户自填远端桥服务器地址（不在仓库内置真实地址）
  bridgeToken: "",
  pollIntervalMs: 3000,              // 3000~60000
  pullCount: 3,                      // 1~10，批量领取（BUG-02）
  chatBindingMode: "fixed",          // fixed=群绑 fixedChatId / auto=群按 group 自动开对话（需求11）
  fixedChatId: "",
  fixedChatTitle: "",
  privateOwnerChatId: "",            // 主人私聊固定对话（环境变量 NAPCAT_PRIVATE_OWNER_CHAT_ID）；其他人私聊按 C2C 自动建对话（2026-08-17）
  characterCardName: "",
  groupChatBindings: {},             // 需求（2026-08-17）：按群绑定对话 {群ID: chatId}，优先级高于 fixedChatId
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
  privateOwnerChatId: "NAPCAT_PRIVATE_OWNER_CHAT_ID",
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

// 需求（2026-08-17）：按群绑定对话 {群ID: chatId}，优先级高于 fixedChatId；兼容对象与 JSON 字符串
function normalizeGroupBindings(v) {
  const out = {};
  let raw = v;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch (e) { raw = null; }
  }
  if (raw && typeof raw === "object") {
    for (const [k, val] of Object.entries(raw)) {
      const id = asText(val || "").trim();
      if (id) out[asText(k).trim()] = id;
    }
  }
  return out;
}

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
    privateOwnerChatId: asText(raw.privateOwnerChatId || "").trim(),
    characterCardName: asText(raw.characterCardName || "").trim(),
    groupChatBindings: normalizeGroupBindings(raw.groupChatBindings || raw.group_chat_bindings),
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
async function serverGetConfig() { return await httpJson("/api/config", "GET", null, 8000); }

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
  if (!chatId) return false;
  // 用 listChats 遍历匹配（findChat 的 query 语义不确定，避免匹配不上 fallback 到建新对话）
  try {
    const result = await Tools.Chat.listChats({ limit: 500, sort_by: "updatedAt", sort_order: "desc" });
    const data = result && typeof result === "object" && result.data && typeof result.data === "object" ? result.data : result;
    const chats = Array.isArray(data?.chats) ? data.chats : [];
    return chats.some((c) => asText(c?.id) === chatId);
  } catch (e) {
    console.warn("[napcat_pro] findChatById listChats error: " + String((e && e.message) || e));
    return false;
  }
}
async function resolveAutoChat(item, key) {
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

async function resolveChatId(item) {
  const cfg = getConfig();
  const key = conversationKey(item);
  // 群聊：按群绑定 > 固定渡渡对话（fixedChatId）> 按群 auto（需求11 / 2026-08-17 按群绑定）
  if (item.message_type === "group") {
    const gid = String(item.group_id || "");
    const mapped = (cfg.groupChatBindings || {})[gid];
    if (mapped) {
      const ok = await findChatById(mapped);
      if (ok) return { chatId: mapped, key: key, title: cfg.fixedChatTitle || ("QQ群 " + item.group_id) };
    }
    if (cfg.fixedChatId) {
      const ok = await findChatById(cfg.fixedChatId);
      if (ok) return { chatId: cfg.fixedChatId, key: key, title: cfg.fixedChatTitle || "QQ桥接" };
      // 固定对话失效 → fallback auto
    }
    return resolveAutoChat(item, key);
  }
  // 私聊：主人 → privateOwnerChatId（环境变量）；其他人 → C2C 自动建对话（2026-08-17 用户需求）
  if (item.is_owner && cfg.privateOwnerChatId) {
    const ok = await findChatById(cfg.privateOwnerChatId);
    if (ok) return { chatId: cfg.privateOwnerChatId, key: key, title: "QQ私聊（主人）" };
  }
  return resolveAutoChat(item, key);
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

// Service not connected（ChatService 间歇性断）时重试，防单次瞬断丢消息
async function withChatRetry(fn, retries, delayMs) {
  let lastError;
  for (let attempt = 0; attempt <= (retries || 2); attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || error);
      if (msg.indexOf("Service not connected") >= 0 && attempt < (retries || 2)) {
        console.warn("[napcat_pro] ChatService 未连接，重试 " + (attempt + 1) + "/" + (retries || 2));
        await Tools.System.sleep(delayMs || 1500);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
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
      // 细分定位：resolveCardId / resolveChatId / sendMessageStreaming 哪个报 Service not connected
      let chatId = "";
      try {
        const r = await resolveChatId(item);
        chatId = r.chatId;
      } catch (error) {
        const em = String(error?.message || error);
        console.warn("[napcat_pro] FAIL resolveChatId(" + item.message_type + "," + item.user_id + "): " + em);
        throw error;
      }
      let cardId;
      try {
        cardId = await resolveCardId();
      } catch (error) {
        const em = String(error?.message || error);
        console.warn("[napcat_pro] FAIL resolveCardId: " + em);
        throw error;
      }
      // 用 Tools.Chat.sendMessage + senderName（extended_chat/chat_with_agent 验证可用的路径）；
      // sendMessageStreaming 也会触发 ensureServiceConnected，间歇性 Service not connected → withChatRetry 兜底
      let aiResult;
      try {
        aiResult = await withChatRetry(() => Tools.Chat.sendMessage(
          prompt, chatId, cardId || undefined, "渡渡",
          {
            persist_turn: true, notify_reply: false, hide_user_message: true, disable_warning: true,
            timeout_ms: cfg.aiTimeoutMs
          }
        ), 2, 1500);
      } catch (error) {
        const em = String(error?.message || error);
        console.warn("[napcat_pro] FAIL sendMessage(chat=" + chatId + "): " + em);
        throw error;
      }
      const cleaned = stripModelMarkup(aiResult?.aiResponse || aiResult?.data?.aiResponse || aiResult?.content || aiResult?.message || "");
      // 需求（2026-08-17）：ignore 使用范围由代码划界，不靠 prompt 嘴炮——
      // 触发（群@/关键词/主人、私聊主人）必回，AI 无权忽略；只有选择性候选（selection_required 且非触发）才允许忽略
      const forced = (item.message_type === "group" && (item.trigger === "at" || item.trigger === "keyword" || item.trigger === "owner")) ||
                     (item.message_type === "private" && item.trigger === "owner");
      const ignorePermitted = !!item.selection_required && !forced;
      const isIgnored = cleaned === IGNORE_SENTINEL && ignorePermitted;
      console.log("[napcat_pro] round " + (item.message_type || "") + " u" + (item.user_id || "") + " g" + (item.group_id || "") + " chat=" + chatId + " trig=" + (item.trigger || "") + " igPerm=" + ignorePermitted + " -> " + (isIgnored ? "IGNORED" : "REPLY"));
      if (isIgnored) {
        await ignoreMsg(itemId, "ai_selective_ignore");
        state.ignoredCount += 1;
        touchState();
        results.push({ id: itemId, ignored: true });
        continue;
      }
      // 触发必回：AI 就算输出哨兵也被代码拦下，兜底回复，不漏回
      const replyText = (cleaned && cleaned !== IGNORE_SENTINEL) ? cleaned : "我在。";
      await reply(itemId, replyText);
      state.processedCount += 1;
      state.lastReplyAt = Date.now();
      touchState();
      results.push({ id: itemId, replied: replyText.slice(0, 60) });
    }
    state.lastError = "";
    return { ok: true, hasMessage: results.length > 0, results: results };
  } catch (error) {
    const msg = String(error?.message || error);
    console.warn("[napcat_pro] processOne error: " + msg);
    state.lastError = msg;
    state.failedCount += 1;
    touchState();
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
    privateOwnerChatId: c.privateOwnerChatId,
    groupChatBindings: c.groupChatBindings || {},
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
    privateOwnerChatId: payload.private_owner_chat_id !== undefined ? asText(payload.private_owner_chat_id).trim() : prev.privateOwnerChatId,
    characterCardName: payload.character_card_name !== undefined ? asText(payload.character_card_name).trim() : prev.characterCardName,
    groupChatBindings: payload.group_chat_bindings !== undefined ? normalizeGroupBindings(payload.group_chat_bindings) : prev.groupChatBindings,
    aiTimeoutMs: payload.ai_timeout_ms !== undefined ? Number(payload.ai_timeout_ms) : prev.aiTimeoutMs,
  });
  return { success: true, config: publicConfig() };
}

async function handleStart(payload) {
  payload = payload || {};
  const cfg = getConfig();
  if (!cfg.bridgeUrl) throw new Error("未配置服务器地址（bridge_url）");
  if (!cfg.bridgeToken) throw new Error("未配置 Bridge Token");
  // 对齐文档：fixed 模式须已绑定有效对话
  if (cfg.chatBindingMode === "fixed") {
    if (!cfg.fixedChatId) throw new Error("fixed 模式尚未绑定对话（请先 bind_current_chat 或 configure 固定对话ID）");
    const ok = await findChatById(cfg.fixedChatId);
    if (!ok) throw new Error("fixed 模式绑定的对话不存在或不可用: " + cfg.fixedChatId);
  }
  // 验证服务器连通
  const health = await serverHealth();
  if (!health || health.ok !== true) throw new Error("服务器不可达或鉴权失败");
  // 同步默认群模式 keyword_or_at（需求14，2026-08-17）：仅在服务器当前模式为 off/未配置时写入，不覆盖 UI 已设的模式
  try {
    const remote = await serverGetConfig();
    const cur = (remote && remote.config && remote.config.group_reply_mode) || "";
    if (!cur || cur === "off") await serverConfig({ group_reply_mode: "keyword_or_at" });
  } catch (e) { /* 服务器可自行管理 */ }
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
  let health = null, stats = null, rules = null;
  try { health = await serverHealth(); } catch (e) { health = { ok: false, error: "服务器不可达" }; }
  try { stats = await serverStats(); } catch (e) { stats = null; }
  try { const r = await serverGetConfig(); rules = (r && r.config) || null; } catch (e) { rules = null; }
  return { success: true, config: publicConfig(), state: publicState(), server: health, queue: stats, server_rules: rules };
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
  if (payload.bot_name !== undefined) patch.bot_name = asText(payload.bot_name).trim();
  if (payload.bridge_prompt !== undefined) patch.bridge_prompt = asText(payload.bridge_prompt).trim();
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

function autoStartIfEnabled() {
  // 重启/重新加载后，若 enabled=true 则自动恢复轮询（符合「开关开了就自动跑」预期）
  try {
    if (!getConfig().enabled) return;
    if (state.running) return;
    startLoop();
    console.log("[napcat_pro] auto-start loop (enabled=true)");
  } catch (e) {
    console.warn("[napcat_pro] auto-start skipped: " + String((e && e.message) || e));
  }
}

function registerToolPkg() {
  registerIpc();
  // 重启自动恢复：application_on_create / foreground 时若 enabled=true 自动拉起轮询
  // NOTE(T029同款)：registerAppLifecycleHook 的 function 必须「从 toolpkg 模块导出」，
  // 不能是内部闭包函数——否则宿主拒绝注册（registerAppLifecycleHook function must be exported from a toolpkg module）。
  try {
    ToolPkg.registerAppLifecycleHook({
      id: "napcat_pro_auto_start",
      event: "application_on_create",
      function: exports.autoStartIfEnabled
    });
    ToolPkg.registerAppLifecycleHook({
      id: "napcat_pro_auto_start_fg",
      event: "application_on_foreground",
      function: exports.autoStartIfEnabled
    });
  } catch (e) {
    console.warn("[napcat_pro] lifecycle hook registration skipped: " + String((e && e.message) || e));
  }
  // P5：注册 compose_dsl 设置页 + 侧边栏入口（参考 qqbot_pro / market）
  // screen 必须传模块函数（require 进来的 .default），不能传字符串路径。
  try {
    const napcatSettingsScreen = require("./ui/napcat_settings/index.ui.js");
    const UI_ROUTE = "toolpkg:com.operit.napcat_pro:ui:napcat_settings";
    ToolPkg.registerUiRoute({
      id: "napcat_settings",
      route: UI_ROUTE,
      runtime: "compose_dsl",
      screen: napcatSettingsScreen.default || napcatSettingsScreen,
      params: {},
      keepAlive: false,
      title: { zh: "渡渡 NapCat 桥设置", en: "Dodo NapCat Bridge Settings" }
    });
    ToolPkg.registerNavigationEntry({
      id: "napcat_settings_sidebar",
      route: UI_ROUTE,
      surface: "main_sidebar_plugins",
      title: { zh: "渡渡 NapCat 桥", en: "Dodo NapCat Bridge" },
      icon: "forum",
      order: 95
    });
    console.log("[napcat_pro] UI route registered");
  } catch (error) {
    console.warn("[napcat_pro] UI route registration skipped: " + String((error && error.message) || error));
  }
  return true;
}

// 顶层立即注册（universal 同款：ToolPkg.ipc 需模块加载时注册，而非等生命周期）
loadState();
loadConfig();
registerIpc();
console.log("[napcat_pro] module loaded, enabled=" + String(getConfig().enabled) + ", bridgeUrl=" + (getConfig().bridgeUrl ? "set" : "empty"));

exports.onApplicationCreate = onApplicationCreate;
exports.registerToolPkg = registerToolPkg;
exports.autoStartIfEnabled = autoStartIfEnabled;
exports.IPC_CHANNEL = IPC_CHANNEL;