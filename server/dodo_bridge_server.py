#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dodo_bridge_server.py — dodo_napcat 服务器侧桥 v1.0

干净重写（替代 napcat_operit_bridge.py / QQ Bridge Universal v0.4.0）。
保留已验证的契约与经验，修复 BUG-01~05：

  BUG-01  selective 预过滤：非 owner/@/关键词 的群消息只作上下文，不逐条过 AI
  BUG-02  批量领取：/api/pull?count=N（有界并发消费）
  BUG-03  队列管理：/api/queue/clear + /api/queue/stats（无需 SSH 清积压）
  BUG-04  速率上限：每会话滑动窗口限流 + 队列最大长度
  BUG-05  TLS/Token：BRIDGE_TOKEN 走环境变量，部署建议 TLS/CF Tunnel

架构：
  NapCat(OneBot11 ws) ──► 归一化/预过滤/防抖 ──► 队列 ──► /api/pull(批量) ──► Operit
  Operit ──► /api/reply{id, reply|segments} ──► 分段/引用 ──► NapCat ws 发送

依赖：websocket-client（pip install websocket-client）
"""
import json
import os
import re
import threading
import time
import uuid
from collections import Counter, defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# ==================== 环境变量配置 ====================
NAPCAT_WS_URL = os.environ.get("NAPCAT_WS_URL", "ws://127.0.0.1:6098")
NAPCAT_WS_TOKEN = os.environ.get("NAPCAT_WS_TOKEN", "")
BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "")
BOT_QQ = int(os.environ.get("BOT_QQ", "0"))
DATA_DIR = os.environ.get("BRIDGE_DATA_DIR", os.path.expanduser("~/.dodo_napcat"))
QUEUE_FILE = os.environ.get("QUEUE_FILE", os.path.join(DATA_DIR, "queue.json"))
CONTEXT_FILE = os.environ.get("CONTEXT_FILE", os.path.join(DATA_DIR, "context.json"))
CONFIG_FILE = os.environ.get("BRIDGE_CONFIG_FILE", os.path.join(DATA_DIR, "reply_config.json"))
LISTEN_HOST = os.environ.get("LISTEN_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8080"))
CLAIM_TTL = int(os.environ.get("CLAIM_TTL", "300"))          # claimed 超时回退秒数
CONTEXT_TEXT_LIMIT = int(os.environ.get("CONTEXT_TEXT_LIMIT", "320"))
QUEUE_MAX_ITEMS = int(os.environ.get("QUEUE_MAX_ITEMS", "500"))  # BUG-04：队列上限
PULL_MAX_COUNT = int(os.environ.get("PULL_MAX_COUNT", "5"))      # BUG-02：单次批量领取上限
RATE_LIMIT_PER_MIN = int(os.environ.get("RATE_LIMIT_PER_MIN", "30"))  # BUG-04：每会话每分钟候选上限
STALE_MSG_TTL_SECONDS = int(os.environ.get("STALE_MSG_TTL_SECONDS", "300"))  # 需求：丢弃 5 分钟前的内容
IGNORE_SENTINEL = "[[QQ_BRIDGE_IGNORE]]"


# 需求（2026-08-17）：所有「涉及数量」的参数都可 env 配置，且带默认兜底值。
# 优先级：/api/config（运行时可改）> config.json（持久化）> env 默认（本函数）> 硬编码兜底。
def _env_int(name, dft):
    try:
        return int(os.environ.get(name, dft))
    except Exception:
        return dft


def _env_bool(name, dft):
    v = os.environ.get(name)
    if v is None:
        return dft
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _known_users_from_env():
    """需求（2026-08-17）：主人QQ昵称等别名走 env（NAPCAT_KNOWN_USERS），不入库不硬编码。"""
    raw = os.environ.get("NAPCAT_KNOWN_USERS", "")
    if isinstance(raw, str) and raw.strip():
        try:
            v = json.loads(raw)
            return v if isinstance(v, dict) else {}
        except Exception:
            return {}
    return {}


# 需求（2026-08-17）：桥接提示词默认兜底（NAPCAT_BRIDGE_PROMPT 可经 UI/agent 覆盖）
DEFAULT_BRIDGE_PROMPT = os.environ.get(
    "NAPCAT_BRIDGE_PROMPT",
    "你正在 QQ 里与用户对话。用户艾特你或触发关键词时，是在直接跟你说话，请以角色身份回应。"
)


KEEP_NEWEST_STALE = _env_bool("NAPCAT_KEEP_NEWEST_STALE", True)   # 需求（2026-08-17）：每会话保留最近一条未处理，避免断连后最新回复消息也被丢光
server_started_at = 0                                             # 需求（2026-08-22）：Gateway（服务器）启动时刻，用于"刚开启回历史消息才引用"


GROUP_MODES = {"off", "at_only", "keyword_or_at", "selective", "all"}
PRIVATE_MODES = {"off", "owner_only", "whitelist", "keyword", "all"}

DEFAULT_REPLY_CONFIG = {
    "owner_qq": _env_int("NAPCAT_OWNER_QQ", 0),
    "owner_always_reply": _env_bool("NAPCAT_OWNER_ALWAYS_REPLY", True),
    "group_reply_mode": os.environ.get("NAPCAT_GROUP_REPLY_MODE", "keyword_or_at"),   # 需求（2026-08-17）：默认回艾特+关键词（关键词可 UI 调），不再承诺仅回艾特
    "keywords": [],
    "private_reply_mode": os.environ.get("NAPCAT_PRIVATE_REPLY_MODE", "owner_only"),
    "private_whitelist": [],
    "group_context_limit": _env_int("NAPCAT_GROUP_CONTEXT_LIMIT", 12),
    "private_context_limit": _env_int("NAPCAT_PRIVATE_CONTEXT_LIMIT", 8),
    "mention_context_limit": _env_int("NAPCAT_MENTION_CONTEXT_LIMIT", 5),
    "following_context_limit": _env_int("NAPCAT_FOLLOWING_CONTEXT_LIMIT", 1),
    "debounce_seconds": _env_int("NAPCAT_DEBOUNCE_SECONDS", 0),
    "split_reply_enabled": _env_bool("NAPCAT_SPLIT_REPLY_ENABLED", True),
    "reply_part_delay_ms": _env_int("NAPCAT_REPLY_PART_DELAY_MS", 450),
    "quote_reply_enabled": _env_bool("NAPCAT_QUOTE_REPLY_ENABLED", True),   # 回复时原生引用原消息（reply 段）
    # 需求（2026-08-22）：引用回复只在 Gateway 刚开启、回复最新一条历史消息时用（catch_up），其他时候不引用
    "quote_catch_up_only": _env_bool("NAPCAT_QUOTE_CATCH_UP_ONLY", True),
    # P3（2026-08-16）：G1 群聚合 + G2 上下文双模式（需求16/17，默认不改变现有行为）
    "group_aggregate_window_ms": _env_int("NAPCAT_GROUP_AGGREGATE_WINDOW_MS", 0),  # 0=不聚合（默认，保持现行为）；>0=群触发消息按窗口合成一轮
    "at_context_mode": os.environ.get("NAPCAT_AT_CONTEXT_MODE", "count"),      # count=取最后N条（默认）/ time=只读艾特前后N秒（需求17）
    "at_context_before_sec": _env_int("NAPCAT_AT_CONTEXT_BEFORE_SEC", 10),     # time 模式：艾特前秒数
    "at_context_after_sec": _env_int("NAPCAT_AT_CONTEXT_AFTER_SEC", 10),      # time 模式：艾特后秒数
    "at_context_count": _env_int("NAPCAT_AT_CONTEXT_COUNT", 10),          # count 模式：上下文条数
    # P3（2026-08-16）：G7 成员别名映射（需求18：QQ号→可读昵称，如 <QQ号>→用户别名）
    "known_users": _known_users_from_env(),   # {"<QQ号>": "用户别名", ...}（需求：走 env 不入库）
    # 需求（2026-08-17）：AI 被称呼的名字 / QQ昵称（如 渡渡），用于把「艾特」渲染成 @渡渡 让 AI 明确知道在跟它说话
    "bot_name": os.environ.get("NAPCAT_BOT_NAME", ""),
    # 需求（2026-08-17）：桥接提示词（UI/agent 可改，默认兜底）
    "bridge_prompt": os.environ.get("NAPCAT_BRIDGE_PROMPT", DEFAULT_BRIDGE_PROMPT),
    # P3（2026-08-16 23:56）：批量观察轮（需求19，用户需求）
    "aggregate_scope": os.environ.get("NAPCAT_AGGREGATE_SCOPE", "trigger"),    # trigger=只聚合艾特/关键词触发消息（5秒防抖）；all=聚合所有群消息（20秒批量观察，AI选择回复/ignore全部）
    "repeat_flood_detect": _env_bool("NAPCAT_REPEAT_FLOOD_DETECT", True),     # 复读检测：窗口内消息文本归一化后高度重复 → 标记复读，AI只主动回一次不逐条引用
    # P3（2026-08-17）：waifu 分句（G4，移植 qqbot-pro）——每 N 句合成一条；`。！？\n` 计数、连续换行归一化、max_chars 兜底
    "private_chunk_size": _env_int("NAPCAT_PRIVATE_CHUNK_SIZE", 3),       # 私聊：每3句一条
    "group_chunk_size": _env_int("NAPCAT_GROUP_CHUNK_SIZE", 5),         # 群聊：每5句一条
    "reply_chunk_max_chars": _env_int("NAPCAT_CHUNK_MAX_CHARS", 400),    # 无句末符文本的字符安全兜底（G4）
    # 需求（2026-08-17）：群即时触发（@/关键词）也要带上下文（AI 需知道在聊什么）+ 必须回复；
    # 0=按标准 at_context_count（10），<0=显式关闭上下文，>0=N 条；批量观察(scope=all)始终带上下文
    "group_immediate_context": _env_int("NAPCAT_GROUP_IMMEDIATE_CONTEXT", 0),
}

# ==================== 全局状态 ====================
_lock = threading.RLock()
_ws_lock = threading.RLock()
ws_app = None
queue = []                       # 待处理队列（含 done/ignored/skipped 供审计）
seen_ids = set()                 # 已入队消息去重
context_history = {}             # conversation_key -> [entry]
context_seen_ids = set()         # 上下文去重
reply_config = dict(DEFAULT_REPLY_CONFIG)
_rate_windows = defaultdict(deque)  # conversation_key -> deque(timestamps)  BUG-04
_group_buckets = {}                 # group_key -> bucket（G1 聚合桶，P3）


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


# ==================== 持久化 ====================
def atomic_json_write(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:
        log(f"read {path} failed: {e}")
        return default


# ==================== 归一化 ====================
def normalize_keywords(value):
    source = value if isinstance(value, list) else re.split(r"[,，\n]", str(value or ""))
    result = []
    for item in source:
        text = str(item or "").strip()
        if text and text not in result:
            result.append(text)
    return result[:50]


def normalize_qq_list(value):
    result = []
    for item in normalize_keywords(value):
        if item.isdigit() and 5 <= len(item) <= 12:
            number = int(item)
            if number not in result:
                result.append(number)
    return result


def normalize_known_users(value):
    """G7（需求18）：QQ号→可读昵称 别名映射。接受 dict / {json字符串} / [["qq","名"],...]。"""
    result = {}
    raw = value or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return result
    items = raw.items() if isinstance(raw, dict) else (raw if isinstance(raw, list) else [])
    for k, v in items:
        qq = str(k or "").strip()
        name = str(v or "").strip()
        if qq.isdigit() and name:
            result[qq] = name
    return dict(list(result.items())[:100])


def display_name(user_id, fallback=""):
    """G7：优先 known_users 别名，其次 QQ 群名片/昵称，最后 QQ 号。"""
    name = reply_config.get("known_users", {}).get(str(user_id or ""), "")
    return name or fallback or str(user_id or "")


def normalize_config(value):
    raw = value if isinstance(value, dict) else {}
    group_mode = str(raw.get("group_reply_mode", DEFAULT_REPLY_CONFIG["group_reply_mode"]))
    private_mode = str(raw.get("private_reply_mode", DEFAULT_REPLY_CONFIG["private_reply_mode"]))
    try:
        owner_qq = int(raw.get("owner_qq") or 0)
    except Exception:
        owner_qq = 0
    return {
        "owner_qq": owner_qq,
        "owner_always_reply": raw.get("owner_always_reply", True) is not False,
        "group_reply_mode": group_mode if group_mode in GROUP_MODES else "keyword_or_at",
        "keywords": normalize_keywords(raw.get("keywords", [])),
        "private_reply_mode": private_mode if private_mode in PRIVATE_MODES else "owner_only",
        "private_whitelist": normalize_qq_list(raw.get("private_whitelist", [])),
        "group_context_limit": max(1, min(50, int(raw.get("group_context_limit") or 12))),
        "private_context_limit": max(1, min(30, int(raw.get("private_context_limit") or 8))),
        "mention_context_limit": max(0, min(10, int(raw.get("mention_context_limit", 5) or 0))),
        "following_context_limit": 1 if int(raw.get("following_context_limit", 1) or 0) > 0 else 0,
        "debounce_seconds": max(0, min(30, int(raw.get("debounce_seconds", 0) or 0))),
        "split_reply_enabled": raw.get("split_reply_enabled", True) is not False,
        "reply_part_delay_ms": max(0, min(5000, int(raw.get("reply_part_delay_ms", 450) or 0))),
        "quote_reply_enabled": raw.get("quote_reply_enabled", True) is not False,
        "quote_catch_up_only": raw.get("quote_catch_up_only", True) is not False,
        # P3：G1 聚合 + G2 上下文双模式
        "group_aggregate_window_ms": max(0, min(60000, int(raw.get("group_aggregate_window_ms", 0) or 0))),
        "at_context_mode": "time" if str(raw.get("at_context_mode", "count")).lower() == "time" else "count",
        "at_context_before_sec": max(0, min(120, int(raw.get("at_context_before_sec", 10) or 0))),
        "at_context_after_sec": max(0, min(120, int(raw.get("at_context_after_sec", 10) or 0))),
        "at_context_count": max(1, min(50, int(raw.get("at_context_count", 12) or 0))),
        "known_users": normalize_known_users(raw.get("known_users", DEFAULT_REPLY_CONFIG.get("known_users", {}))),
        "bot_name": str(raw.get("bot_name") or DEFAULT_REPLY_CONFIG.get("bot_name") or "").strip(),
        "bridge_prompt": (str(raw.get("bridge_prompt") or DEFAULT_REPLY_CONFIG.get("bridge_prompt") or "").strip()) or DEFAULT_BRIDGE_PROMPT,
        "aggregate_scope": "all" if str(raw.get("aggregate_scope", "trigger")).lower() == "all" else "trigger",
        "repeat_flood_detect": raw.get("repeat_flood_detect", True) is not False,
        "private_chunk_size": max(1, min(20, int(raw.get("private_chunk_size", 3) or 0))),
        "group_chunk_size": max(1, min(20, int(raw.get("group_chunk_size", 5) or 0))),
        "reply_chunk_max_chars": max(1, min(2000, int(raw.get("reply_chunk_max_chars", 400) or 0))),
        "group_immediate_context": max(-1, min(50, int(raw.get("group_immediate_context", 0) or 0))),
    }


def load_state():
    global queue, seen_ids, context_history, context_seen_ids, reply_config
    data = read_json(QUEUE_FILE, [])
    queue = data if isinstance(data, list) else []
    seen_ids = set()
    for item in queue:
        for merged_id in item.get("qq_message_ids") or []:
            merged_id = str(merged_id or "")
            if merged_id:
                seen_ids.add(merged_id)
    context_data = read_json(CONTEXT_FILE, {})
    conversations = context_data.get("conversations", context_data) if isinstance(context_data, dict) else {}
    context_history = conversations if isinstance(conversations, dict) else {}
    context_seen_ids = {
        str(entry.get("message_id"))
        for entries in context_history.values() if isinstance(entries, list)
        for entry in entries if isinstance(entry, dict) and entry.get("message_id")
    }
    reply_config = normalize_config(read_json(CONFIG_FILE, DEFAULT_REPLY_CONFIG))


def save_queue():
    with _lock:
        atomic_json_write(QUEUE_FILE, queue)


def save_context():
    atomic_json_write(CONTEXT_FILE, {"version": 1, "conversations": context_history})


def save_reply_config():
    atomic_json_write(CONFIG_FILE, reply_config)


# ==================== 会话/上下文 ====================
def context_limit(key):
    return reply_config["group_context_limit"] if key.startswith("group:") else reply_config["private_context_limit"]


def conversation_key(message_type, user_id, group_id=0):
    return f"group:{int(group_id or 0)}" if message_type == "group" else f"private:{int(user_id or 0)}"


def append_context_entry(key, entry):
    entries = context_history.setdefault(key, [])
    entries.append(entry)
    limit = context_limit(key)
    if len(entries) > limit:
        del entries[:-limit]
    message_id = str(entry.get("message_id") or "")
    if message_id:
        context_seen_ids.add(message_id)
    save_context()


# ==================== G2 上下文快照（需求16/17：双模式） ====================
def snapshot_context(key, trigger_ts, trigger, limit_hint=None):
    """按双模式取上下文快照：
    - at 触发 + at_context_mode=time：取 [trigger_ts-before, trigger_ts+after] 内条目（非顺序读取）
    - 其他：取最后 N 条（count 模式，默认行为）
    """
    entries = context_history.get(key, [])
    if not entries:
        return []
    mode = reply_config["at_context_mode"]
    if trigger == "at" and mode == "time":
        lo = trigger_ts - reply_config["at_context_before_sec"]
        hi = trigger_ts + reply_config["at_context_after_sec"]
        return [dict(x) for x in entries if int(x.get("created_at") or 0) >= lo and int(x.get("created_at") or 0) <= hi]
    # count 模式：at 触发用 at_context_count，否则用 group_context_limit
    n = reply_config["at_context_count"] if trigger == "at" else (limit_hint or context_limit(key))
    return [dict(x) for x in entries][-n:] if n > 0 else []


# ==================== G1 群聚合桶（P3） ====================
def bucket_key(group_id):
    return "group:" + str(group_id)


def detect_repeat_flood(events):
    """复读检测（需求19）：归一化后若高度重复（最多文本占比≥60% 且 ≥3条）→ True。
    代码只给"事实"（是否复读），AI 决定怎么回。
    """
    if not reply_config.get("repeat_flood_detect", True) or len(events) < 3:
        return False

    def _norm(s):
        return re.sub(r"[\s，。！？!?,.、~～]+", "", str(s or "")).lower()[:50]
    counts = Counter(_norm(e.get("text")) for e in events)
    top, top_n = counts.most_common(1)[0]
    if not top:
        return False
    return top_n >= max(2, int(len(events) * 0.6))


def _flush_group_bucket(key):
    with _lock:
        bucket = _group_buckets.pop(key, None)
        if not bucket or not bucket.get("events"):
            return
        events = bucket["events"]
        first_ts = bucket["first_ts"]
        last_ts = bucket["last_ts"]

        # 聚合文本（带编号，供 G3 replyTo 使用）
        lines = []
        for i, ev in enumerate(events, 1):
            clock = time.strftime("%H:%M", time.localtime(int(ev.get("ts") or 0))) if ev.get("ts") else "--:--"
            lines.append("[#%d][%s][%s] %s" % (i, display_name(ev.get("user_id"), ev.get("nickname")), clock, ev.get("text") or ""))
        agg_text = "\n".join(lines)

        # G2 双模式上下文：窗口 = [first_ts - before, last_ts + after]
        trigger_ts = first_ts
        # 需求（2026-08-17）：触发（@/关键词/主人）也要带上下文（AI 需知道在聊什么）；仅 group_immediate_context<0 显式关闭
        if reply_config["group_immediate_context"] < 0:
            recent_context = []
        elif reply_config["at_context_mode"] == "time":
            lo = first_ts - reply_config["at_context_before_sec"]
            hi = last_ts + reply_config["at_context_after_sec"]
            recent_context = [dict(x) for x in context_history.get(key, [])
                              if int(x.get("created_at") or 0) >= lo and int(x.get("created_at") or 0) <= hi]
        else:
            n = reply_config["group_immediate_context"] if reply_config["group_immediate_context"] > 0 else reply_config["at_context_count"]
            recent_context = [dict(x) for x in context_history.get(key, [])][-n:] if n > 0 else []

        owner = bool(reply_config["owner_qq"] and events[0].get("user_id") == reply_config["owner_qq"])
        first_ev = events[0]
        # 需求19：复读检测（代码给事实）——复读轮 AI 只主动回一次，不逐条引用
        repeat_flood = detect_repeat_flood(events)
        # 批量观察轮（scope=all）：AI 从候选中选择回复哪些（replyTo编号）或全部忽略
        # trigger 聚合（@/关键词主动召唤）：必回（selection_required=False），AI 不能忽略
        # 需求（2026-08-17）：ignore 范围由代码划界——只有批量观察里「非触发」普通群消息可选忽略；
        # @/关键词/主人触发无论 scope 都必回（selection_required=False，Operit 侧据此拦下 ignore）
        trig_forced = first_ev.get("trigger") in ("at", "keyword", "owner")
        selection_required = (reply_config.get("aggregate_scope") == "all") and not trig_forced
        trigger = first_ev.get("trigger") or "all"
        # 复读时默认不自动引用（AI 未显式指定 [replyTo:N] 时）
        suppress_quote = repeat_flood
        # 去掉已入 context 的当前批次自身，避免把"正在处理的"当上下文
        recent_context = [x for x in recent_context if x.get("message_id") not in set(
            e.get("message_id") for e in events if e.get("message_id"))]

        if rate_limited(key):
            log(f"rate limited (agg) {key}")
            return
        pending_count = sum(1 for x in queue if x.get("status") == "pending")
        if pending_count >= QUEUE_MAX_ITEMS:
            log(f"queue full (agg) {key}")
            return

        item = {
            "id": uuid.uuid4().hex,
            "qq_message_id": first_ev.get("message_id", ""),
            "qq_message_ids": [e.get("message_id", "") for e in events if e.get("message_id")],
            "conversation_key": key,
            "message_type": "group",
            "user_id": first_ev.get("user_id", 0),
            "group_id": first_ev.get("group_id", 0),
            "nickname": first_ev.get("nickname", ""),
            "text": agg_text,
            "messages": [agg_text],
            "message_count": len(events),
            "is_owner": owner,
            "trigger": trigger,
            "selection_required": selection_required,
            "repeat_flood": repeat_flood,
            "suppress_quote": suppress_quote,
            "context": recent_context,
            "created_at": first_ts,
            "last_message_at": last_ts,
            "ready_at": int(time.time()),
            "status": "pending",
            "claimed_at": 0,
            "reply": "",
        }
        queue.append(item)
        for ev in events:
            mid = ev.get("message_id", "")
            if mid:
                seen_ids.add(mid)
        save_queue()
        log(f"agg flush {key}: {len(events)} events merged -> {item['id']}")


def add_to_group_bucket(key, ev, now_ms):
    """把一条群触发消息放入聚合桶（窗口滑动）。"""
    with _lock:
        bucket = _group_buckets.get(key)
        if not bucket:
            bucket = {"key": key, "events": [], "first_ts": now_ms, "last_ts": now_ms, "timer": None}
            _group_buckets[key] = bucket
        bucket["events"].append(ev)
        bucket["last_ts"] = now_ms
        # 取消旧 timer，窗口滑动
        if bucket.get("timer"):
            try:
                bucket["timer"].cancel()
            except Exception:
                pass
        window = reply_config["group_aggregate_window_ms"]
        t = threading.Timer(window / 1000.0, _flush_group_bucket, args=(key,))
        t.daemon = True
        bucket["timer"] = t
        t.start()
        log(f"agg bucket {key}: +1 -> {len(bucket['events'])} (window {window}ms)")


def flush_all_buckets():
    with _lock:
        keys = list(_group_buckets.keys())
    for k in keys:
        _flush_group_bucket(k)


# ==================== 消息解析 ====================
def reply_target_id(data):
    msg = data.get("message")
    if isinstance(msg, list):
        for seg in msg:
            if isinstance(seg, dict) and seg.get("type") == "reply":
                return str((seg.get("data") or {}).get("id") or "")
    return ""


def is_at_bot(data):
    msg = data.get("message")
    if isinstance(msg, list):
        for seg in msg:
            if isinstance(seg, dict) and seg.get("type") == "at":
                if str((seg.get("data") or {}).get("qq")) == str(BOT_QQ):
                    return True
    return bool(BOT_QQ and f"[CQ:at,qq={BOT_QQ}" in str(data.get("raw_message", "")))


def message_text(data):
    msg = data.get("message")
    parts = []
    if isinstance(msg, list):
        for seg in msg:
            if not isinstance(seg, dict):
                continue
            typ = seg.get("type")
            d = seg.get("data") or {}
            if typ == "text":
                parts.append(str(d.get("text", "")))
            elif typ == "image":
                parts.append("[图片]")
            elif typ == "record":
                parts.append("[语音]")
            elif typ == "video":
                parts.append("[视频]")
            elif typ == "file":
                parts.append("[文件]")
            elif typ == "reply":
                parts.append("[回复消息]")
            elif typ == "at" and str(d.get("qq")) != str(BOT_QQ):
                parts.append("@" + str(d.get("qq", "")))
    text = "".join(parts).strip()
    if text:
        return text
    raw = str(data.get("raw_message", "")).strip()
    if BOT_QQ:
        raw = re.sub(rf"\[CQ:at,qq={BOT_QQ}(?:,[^\]]*)?\]\s*", "", raw).strip()
    return raw or ("在吗" if is_at_bot(data) else "[非文本消息]")


def keyword_hit(text):
    return any(keyword in text for keyword in reply_config["keywords"])


# ==================== 触发路由（BUG-01：selective 预过滤） ====================
def route_message(message_type, user_id, text, at_bot):
    """返回 (should_enqueue, selection_required, trigger)。

    - should_enqueue=False → 只进上下文，不进 AI 候选队列（BUG-01 核心）
    - selection_required=True → AI 需判断是否回复（selective 候选）
    """
    owner = bool(reply_config["owner_qq"] and user_id == reply_config["owner_qq"])
    # 需求（2026-08-17）：owner_always_reply 只保证「私聊」必回；群聊跟群模式走（仅艾特/关键词触发），
    # 避免主人每句群聊都被强制送进 AI 却几乎全被忽略（实测 AI 全回 [[QQ_BRIDGE_IGNORE]]）
    if owner and reply_config["owner_always_reply"] and message_type != "group":
        return True, False, "owner"
    hit = keyword_hit(text)
    if message_type == "group":
        mode = reply_config["group_reply_mode"]
        if mode == "off":
            return False, False, "off"
        if mode == "at_only":
            return at_bot, False, "at"
        if mode == "keyword_or_at":
            return hit or at_bot, False, "keyword" if hit else "at"
        if mode == "all":
            return True, False, "all"
        if mode == "selective":
            # 【BUG-01 修复】只有 @/关键词 才成为 AI 候选；其余群消息不排队，只作上下文/后续语境。
            # 需求（2026-08-17）：selective 模式下艾特必回（selection_required=False），关键词为可选候选（True）
            if at_bot:
                return True, False, "at"
            if hit:
                return True, True, "keyword"
            return False, False, "context_only"
    else:
        mode = reply_config["private_reply_mode"]
        if mode == "off":
            return False, False, "off"
        if mode == "owner_only":
            return owner, False, "owner"
        if mode == "whitelist":
            return user_id in reply_config["private_whitelist"], False, "whitelist"
        if mode == "keyword":
            return hit, False, "keyword"
        if mode == "all":
            return True, False, "all"
    return False, False, "off"


# ==================== 速率上限（BUG-04） ====================
def rate_limited(key):
    if RATE_LIMIT_PER_MIN <= 0:
        return False
    now = time.time()
    window = _rate_windows[key]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= RATE_LIMIT_PER_MIN:
        return True
    window.append(now)
    return False


# ==================== 防抖合并 ====================
def pending_merge_candidate(key, user_id, now):
    if reply_config["debounce_seconds"] <= 0:
        return None
    for item in reversed(queue):
        if item.get("status") != "pending":
            continue
        if item.get("conversation_key") != key or int(item.get("user_id") or 0) != user_id:
            continue
        if now <= int(item.get("ready_at") or 0):
            return item
        break
    return None


def attach_following_group_context(key, entry, now, excluded_item=None):
    if reply_config["following_context_limit"] <= 0:
        return None
    for item in reversed(queue):
        if item is excluded_item or item.get("status") != "pending":
            continue
        if item.get("message_type") != "group" or item.get("conversation_key") != key:
            continue
        if item.get("is_owner") or item.get("trigger") not in ("at", "keyword"):
            continue
        if int(item.get("ready_at") or 0) < now:
            continue
        following = item.setdefault("following_context", [])
        if following:
            return None
        following.append(dict(entry))
        item["following_context_count"] = 1
        log(f"attached following context to {item.get('id')}: {str(entry.get('text') or '')[:80]}")
        return item
    return None


# ==================== 入队 ====================
def enqueue_message(data):
    msg_type = data.get("message_type")
    user_id = int(data.get("user_id") or 0)
    group_id = int(data.get("group_id") or 0)
    if not user_id or user_id == BOT_QQ or msg_type not in ("private", "group"):
        return
    text = message_text(data)
    qq_message_id = str(data.get("message_id", ""))
    sender = data.get("sender") or {}
    nickname = sender.get("card") or sender.get("nickname") or str(user_id)
    at_bot = is_at_bot(data)
    should_process, selection_required, trigger = route_message(msg_type, user_id, text, at_bot)
    owner = bool(reply_config["owner_qq"] and user_id == reply_config["owner_qq"])
    key = conversation_key(msg_type, user_id, group_id)
    now = int(time.time())

    with _lock:
        if qq_message_id and (qq_message_id in seen_ids or qq_message_id in context_seen_ids):
            return

        prior_entries = context_history.get(key, [])
        prior_last_user = int(prior_entries[-1].get("user_id") or 0) if prior_entries else 0
        merge_item = pending_merge_candidate(key, user_id, now)
        is_continuation = bool(merge_item and prior_last_user == user_id)

        # 群友 @/关键词 触发取专用前文窗口；其他沿用普通群窗口（G2 双模式）
        # 需求（2026-08-17）：触发也要带上下文（AI 需知道在聊什么）；仅 group_immediate_context<0 显式关闭
        if msg_type == "group":
            if reply_config["group_immediate_context"] < 0:
                recent_context = []
            elif not owner and trigger in ("at", "keyword"):
                recent_context = snapshot_context(key, now, trigger, limit_hint=reply_config["group_immediate_context"] if reply_config["group_immediate_context"] > 0 else reply_config["mention_context_limit"])
            else:
                recent_context = snapshot_context(key, now, trigger)
        else:
            recent_context = snapshot_context(key, now, trigger)

        current_entry = {
            "message_id": qq_message_id,
            "created_at": now,
            "user_id": user_id,
            "nickname": nickname,
            "text": text,
            "at_bot": at_bot,
            "reply_to": reply_target_id(data),
            "is_bot": False,
        }

        # 私聊未获准时默认不留存；但允许接在已触发轮次后作连续补充
        if msg_type == "private" and not should_process and not is_continuation:
            log(f"dropped private {user_id}: not allowed by current mode")
            return

        append_context_entry(key, current_entry)

        # G1（P3）：群触发 + 聚合开启 → 进聚合桶，窗口到期合成一轮
        # 需求19：aggregate_scope=all 时，所有群消息（非 off）都进桶 → 批量观察轮（20秒），AI 选择回复/ignore 全部
        if (msg_type == "group" and reply_config["group_aggregate_window_ms"] > 0
                and (should_process or reply_config["aggregate_scope"] == "all") and trigger != "off"):
            add_to_group_bucket(key, {
                "message_id": qq_message_id,
                "user_id": user_id,
                "group_id": group_id,
                "nickname": nickname,
                "text": text,
                "at_bot": at_bot,
                "trigger": trigger,
                "selection_required": True,
                "ts": now,
            }, now)
            return

        # 已触发轮次在防抖窗口内继续收同一发送者消息
        if is_continuation:
            merge_item.setdefault("messages", [merge_item.get("text", "")])
            merge_item["messages"].append(text)
            merge_item["text"] = "\n".join(str(x) for x in merge_item["messages"] if str(x).strip())
            merge_item.setdefault("qq_message_ids", [merge_item.get("qq_message_id", "")])
            if qq_message_id:
                merge_item["qq_message_ids"].append(qq_message_id)
                seen_ids.add(qq_message_id)
            merge_item["message_count"] = len(merge_item["messages"])
            merge_item["last_message_at"] = now
            merge_item["ready_at"] = now + reply_config["debounce_seconds"]
            save_queue()
            log(f"debounce merged {msg_type} {user_id}, count={merge_item['message_count']}")
            return

        if msg_type == "group":
            attached = attach_following_group_context(key, current_entry, now)
            if attached:
                save_queue()

        if not should_process:
            log(f"context only {msg_type} {user_id}: {text[:80]}")
            return

        # BUG-04：会话速率上限（只对候选消息计数）
        if rate_limited(key):
            log(f"rate limited {key}: {text[:60]}")
            return

        # BUG-04：队列上限保护
        pending_count = sum(1 for x in queue if x.get("status") == "pending")
        if pending_count >= QUEUE_MAX_ITEMS:
            log(f"queue full ({QUEUE_MAX_ITEMS}), drop candidate {key}: {text[:60]}")
            return

        item = {
            "id": uuid.uuid4().hex,
            "qq_message_id": qq_message_id,
            "qq_message_ids": [qq_message_id] if qq_message_id else [],
            "conversation_key": key,
            "message_type": msg_type,
            "user_id": user_id,
            "group_id": group_id,
            "nickname": nickname,
            "text": text,
            "messages": [text],
            "message_count": 1,
            "is_owner": owner,
            "trigger": trigger,
            "selection_required": selection_required,
            "context": recent_context,
            "created_at": now,
            "last_message_at": now,
            "ready_at": now + reply_config["debounce_seconds"],
            "status": "pending",
            "claimed_at": 0,
            "reply": "",
        }
        queue.append(item)
        if qq_message_id:
            seen_ids.add(qq_message_id)
        save_queue()
    log(f"queued {msg_type} {user_id} via {trigger}: {text[:80]}")


# ==================== WebSocket ====================
def on_ws_message(ws, message):
    try:
        data = json.loads(message)
        if data.get("post_type") == "message":
            enqueue_message(data)
    except Exception as e:
        log(f"ws message error: {e}")


def on_ws_open(ws):
    log("connected to NapCat WebSocket")


def on_ws_close(ws, code, message):
    log(f"NapCat WebSocket closed: {code} {message}")


def on_ws_error(ws, error):
    log(f"NapCat WebSocket error: {error}")


def ws_loop():
    global ws_app
    headers = [f"Authorization: Bearer {NAPCAT_WS_TOKEN}"] if NAPCAT_WS_TOKEN else None
    while True:
        try:
            import websocket
            ws_app = websocket.WebSocketApp(
                NAPCAT_WS_URL, header=headers,
                on_open=on_ws_open, on_message=on_ws_message,
                on_close=on_ws_close, on_error=on_ws_error,
            )
            ws_app.run_forever(ping_interval=25, ping_timeout=10)
        except Exception as e:
            log(f"ws loop error: {e}")
        time.sleep(3)


def ws_send(payload):
    with _ws_lock:
        if not ws_app or not ws_app.sock or not ws_app.sock.connected:
            raise RuntimeError("NapCat WebSocket is not connected")
        ws_app.send(json.dumps(payload, ensure_ascii=False))


# ==================== 领取（BUG-02：批量） ====================
def clean_stale_queue():
    """需求（2026-08-16）：开启/轮询时丢弃 5 分钟（STALE_MSG_TTL_SECONDS）以前的内容。

    只清理 pending（未处理）的过期项；已 done/ignored/skipped 保留作审计。
    需求（2026-08-17）：每个会话（群/私聊）保留「最近一条未处理」的 pending，
    避免长时间断连后把最新一条回复消息也丢光；该条在领取时会补拉最近 10 条上下文。
    """
    if STALE_MSG_TTL_SECONDS <= 0:
        return 0
    cut = int(time.time()) - STALE_MSG_TTL_SECONDS
    removed = 0
    with _lock:
        # 先找出每会话最近一条 pending（用于 stale 保留）
        newest_pending = {}
        for item in queue:
            if item.get("status") != "pending":
                continue
            key = item.get("conversation_key") or ""
            cur = newest_pending.get(key)
            if cur is None or int(item.get("created_at") or 0) > int(cur.get("created_at") or 0):
                newest_pending[key] = item
        keep = []
        for item in queue:
            ts = int(item.get("created_at") or 0)
            # 只丢「确知年龄 > TTL」的 pending；created_at<=0（未知年龄/旧格式）不误删
            if item.get("status") == "pending" and ts > 0 and ts < cut:
                key = item.get("conversation_key") or ""
                # 需求（2026-08-17）：每会话保留最近一条未处理，领取时补拉上下文
                if KEEP_NEWEST_STALE and newest_pending.get(key) is item:
                    item["stale_kept"] = True
                    keep.append(item)
                    continue
                removed += 1
                continue
            keep.append(item)
        if removed:
            queue[:] = keep
            save_queue()
            log(f"dropped {removed} stale messages (older than {STALE_MSG_TTL_SECONDS}s); kept newest pending per conversation")
    return removed


def claim_next(count=1):
    """按就绪顺序批量领取。返回 list[item]（最多 count 条）。

    领取前先丢弃 5 分钟前的过期 pending（需求：轮询时丢弃旧内容）。
    """
    now = int(time.time())
    count = max(1, min(int(count or 1), PULL_MAX_COUNT))
    clean_stale_queue()
    with _lock:
        changed = False
        for item in queue:
            if item.get("status") == "claimed" and now - int(item.get("claimed_at") or 0) > CLAIM_TTL:
                item["status"], item["claimed_at"] = "pending", 0
                changed = True
        claimed = []
        for item in queue:
            if len(claimed) >= count:
                break
            if item.get("status") != "pending":
                continue
            if int(item.get("ready_at") or 0) > now:
                continue
            item["status"], item["claimed_at"] = "claimed", now
            # 需求（2026-08-17）：stale 保留的最近一条，领取时补拉最近 10 条上下文（避免断连恢复后 AI 缺语境）
            if item.get("stale_kept"):
                key = item.get("conversation_key") or ""
                item["context"] = snapshot_context(key, now, str(item.get("trigger") or ""), limit_hint=10)
                item.pop("stale_kept", None)
            # 需求（2026-08-22）：标记「Gateway 刚开启回的历史消息」——created_at 早于服务器启动时刻，用于"仅此时引用"
            item["catch_up"] = int(item.get("created_at") or 0) < server_started_at
            claimed.append(item)
        if claimed or changed:
            save_queue()
        return [dict(x) for x in claimed]


# ==================== Prompt 组装 ====================
def format_context_line(entry):
    ts = int(entry.get("created_at") or 0)
    clock = time.strftime("%H:%M:%S", time.localtime(ts)) if ts else "--:--:--"
    speaker = "本账号AI" if entry.get("is_bot") else f"{display_name(entry.get('user_id'), entry.get('nickname'))}（QQ {entry.get('user_id', '')}）"
    markers = []
    if entry.get("at_bot"):
        # 需求（2026-08-17）：把「艾特」渲染成 @<bot_name>，让 AI 明确知道这条消息在直接跟它说话
        bn = reply_config.get("bot_name") or ""
        markers.append(f"艾特我(@{bn})" if bn else "艾特我")
    if entry.get("reply_to"):
        markers.append("回复消息")
    prefix = "[" + "/".join(markers) + "] " if markers else ""
    text = str(entry.get("text") or "").replace("\n", " ").strip()
    if len(text) > CONTEXT_TEXT_LIMIT:
        text = text[:CONTEXT_TEXT_LIMIT] + "…"
    return f"[{clock}] {speaker}: {prefix}{text}"


def format_prompt(item):
    origin = (f"QQ私聊，发送者{display_name(item['user_id'], item['nickname'])}（QQ {item['user_id']}）" if item["message_type"] == "private"
              else f"QQ群 {item['group_id']}，发送者{display_name(item['user_id'], item['nickname'])}（QQ {item['user_id']}）")
    context = item.get("context") or []
    block = ""
    if context:
        block = "【最近短上下文，从旧到新】\n" + "\n".join(format_context_line(x) for x in context) + "\n【上下文结束】\n\n"
    following_context = item.get("following_context") or []
    following_block = ""
    if following_context:
        following_block = (
            "\n\n【触发消息之后紧接的一条群消息，仅供补充语境】\n"
            + "\n".join(format_context_line(x) for x in following_context[:1])
            + "\n【后续语境结束】"
        )
    selection = ""
    # 需求（2026-08-17）：ignore 使用范围由 selection_required 代码划界（见 _flush_group_bucket / route_message），
    # prompt 保持简洁——只有允许忽略的选择性候选才给哨兵说明，触发轮根本不提忽略
    if item.get("selection_required"):
        selection = (
            "这是一条选择性回复候选。请结合上下文判断是否自然、有必要插话。"
            f"若不应回复，只输出 {IGNORE_SENTINEL}；若应回复，只输出真正要发到QQ的正文。"
        )
    messages = [str(x).strip() for x in (item.get("messages") or [item.get("text", "")]) if str(x).strip()]
    if len(messages) > 1:
        current_title = f"【当前需要一起处理的连续消息，共{len(messages)}条（从旧到新）】"
        current_text = "\n".join(f"{index + 1}. {text}" for index, text in enumerate(messages))
    else:
        current_title = "【当前消息】"
        current_text = messages[0] if messages else str(item.get("text") or "")
    split_hint = "若有多句话，请使用中文句号“。”分隔，不要用换行代替分句。" if reply_config["split_reply_enabled"] else ""
    replyto_hint = ""
    if item["message_type"] == "group" and len(item.get("qq_message_ids") or []) > 1:
        base = "当前是多条群消息合成的同一轮，各条已编号（[#N]）。"
        if item.get("repeat_flood"):
            base += "检测到这是复读刷屏（内容高度重复）。请只发一条主动回复（不要逐条引用、不要复读内容、不要用[replyTo]），可自然接话或略过。"
        else:
            base += "若你的回复要精确回应其中某条，可在正文前加一行 `[replyTo:N]`；不加则默认回复首条。"
        if reply_config["aggregate_scope"] == "all":
            base += "本窗口包含所有群消息（不止艾特/关键词）：请挑选真正值得回应的一两条回应，其余忽略；都不值得就直接只输出忽略哨兵。"
        else:
            base += "这是艾特/关键词触发的候选：可选择性回应其中值得回的，其余忽略。"
        replyto_hint = base
    # 需求（2026-08-17）：桥接提示词（UI/agent 可改，默认兜底）
    bridge_prompt = (reply_config.get("bridge_prompt") or "").strip()
    bridge_prompt_block = f"\n【桥接设定】{bridge_prompt}\n" if bridge_prompt else ""
    # 需求（2026-08-17）：艾特触发时明确告诉 AI「这条消息在直接跟它说话」
    addressed = ""
    if item.get("trigger") == "at":
        bn = (reply_config.get("bot_name") or "").strip()
        addressed = f"【本条消息艾特了你{'（@' + bn + '）' if bn else ''}，是直接跟你说话，请回应对方。】\n"
    return (
        f"[QQ_BRIDGE_MESSAGE_ID:{item['id']}]\n这是来自{origin}的消息。"
        f"{selection}{replyto_hint}请以当前绑定角色自然处理，不解释桥接流程，不复述提示，不输出消息ID。"
        f"连续消息已经合成同一轮，请整体理解，不要机械逐条作答。{split_hint}"
        f"{bridge_prompt_block}\n\n"
        f"{block}{addressed}{current_title}\n{display_name(item['user_id'], item['nickname'])}: {current_text}{following_block}"
    )


# ==================== 发送 ====================
def find_item(item_id):
    return next((x for x in queue if x.get("id") == item_id), None)


def parse_reply_protocol(reply, item):
    """G3：解析 AI 返回的 replyTo 协议头。

    支持格式：
      [replyTo:N]回复正文...   （前缀行，聚合轮专用）
      {"replyTo":N,"content":"回复正文"}  （整体 JSON）
    返回 (target_qq_message_id, clean_reply)。无协议头 → 默认引用首条（qq_message_id）。
    """
    raw = (reply or "").strip()
    ids = item.get("qq_message_ids") or []
    target = item.get("qq_message_id") or (ids[0] if ids else "")
    clean = raw
    if not raw:
        return target, clean
    if raw.startswith("{"):
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict) and obj.get("replyTo") is not None and obj.get("content") is not None:
                idx = int(obj["replyTo"])
                if ids and 1 <= idx <= len(ids):
                    target = ids[idx - 1]
                clean = str(obj["content"]).strip() or clean
                return target, clean
        except Exception:
            pass
    m = re.match(r"^\s*\[replyTo[:：]?\s*(\d+)\]\s*(.*)$", raw, re.S)
    if m:
        idx = int(m.group(1))
        if ids and 1 <= idx <= len(ids):
            target = ids[idx - 1]
        clean = m.group(2).strip() or clean
    return target, clean


def append_bot_reply(item, reply):
    append_context_entry(conversation_key(item["message_type"], item["user_id"], item.get("group_id") or 0), {
        "message_id": "bot:" + str(item.get("id") or uuid.uuid4().hex), "created_at": int(time.time()),
        "user_id": BOT_QQ, "nickname": "本账号AI", "text": reply, "at_bot": False,
        "reply_to": str(item.get("qq_message_id") or ""), "is_bot": True,
    })


def _waifu_split_text(text, flush_sentences, max_chars):
    """G4 waifu chunker（移植 qqbot-pro waifu_chunker.js，批处理语义）。

    句末计数：。！？\\n（连续换行只计 1 句）；输出归一化：连续换行压成单个换行；
    max_chars 独立安全兜底，避免无句末符文本无限增长。返回片段数组。
    """
    def _norm_newlines(s):
        return re.sub(r"\n{2,}", "\n", s)
    SENTENCE_END = set("。！？\n")
    buffer = str(text or "")
    out = []
    while True:
        count = 0
        last_nl = False
        i = 0
        n = len(buffer)
        hit = False
        while i < n:
            ch = buffer[i]
            if ch == "\n":
                if not last_nl:
                    count += 1
                last_nl = True
            else:
                if ch in SENTENCE_END:
                    count += 1
                last_nl = False
            i += 1
            if count >= flush_sentences or i >= max_chars:
                hit = True
                break
        if not hit:
            break
        seg = _norm_newlines(buffer[:i]).strip()
        if seg:
            out.append(seg)
        buffer = buffer[i:]
    tail = _norm_newlines(buffer).strip()
    if tail:
        out.append(tail)
    return out


def split_reply_parts(reply, scene="group"):
    """G4 waifu 分句：私聊每 private_chunk_size 句一条，群聊每 group_chunk_size 句一条。"""
    if not reply_config["split_reply_enabled"]:
        return [reply.strip()]
    n = reply_config["group_chunk_size"] if scene == "group" else reply_config["private_chunk_size"]
    parts = _waifu_split_text(reply, max(1, int(n)), reply_config.get("reply_chunk_max_chars", 400))
    return parts or [reply.strip()]


def build_outgoing_message(item, text, index, total, target_qid=None):
    """构造发送给 NapCat 的 message 段数组。

    quote_reply_enabled：回复第一段时原生引用原消息（reply 段）。
    target_qid：G3 指定要引用的消息 id（聚合轮按 [replyTo:N] 编号映射）。
    支持扩展标签（P4）：[image:...] / [voice:...] 在此处转成段。
    """
    segs = []
    qid = target_qid or item.get("qq_message_id")
    # 需求19：复读轮（suppress_quote）且 AI 未显式指定 [replyTo:N] → 不自动引用，只主动回复一次
    suppress = bool(item.get("suppress_quote")) and not target_qid
    # 需求（2026-08-22）：引用回复只在 Gateway 刚开启、回复最新一条历史消息时（catch_up = created_at 早于服务器启动时刻）用；
    # 其他时候不再引用（quote_catch_up_only 默认 True；设为 False 恢复"每条都引用"旧行为）
    catch_up_only = reply_config.get("quote_catch_up_only", True)
    is_catch_up = bool(item.get("catch_up"))
    if (reply_config["quote_reply_enabled"] and index == 0 and qid and not suppress
            and ((not catch_up_only) or is_catch_up)):
        segs.append({"type": "reply", "data": {"id": str(qid)}})
    segs.append({"type": "text", "data": {"text": text}})
    return segs


def send_reply_parts(item, reply):
    target_qid, clean_reply = parse_reply_protocol(reply, item)
    saved_parts = item.get("reply_parts")
    saved_count = int(item.get("sent_part_count") or 0)
    if isinstance(saved_parts, list) and saved_parts and saved_count > 0:
        parts = [str(x) for x in saved_parts]
        effective_reply = str(item.get("reply") or reply)
        target_qid = item.get("quote_target_id") or target_qid
    else:
        parts = split_reply_parts(clean_reply, item.get("message_type") or "group")
        effective_reply = clean_reply
        item["reply"] = clean_reply
        item["reply_parts"] = parts
        item["sent_part_count"] = 0
        item["quote_target_id"] = target_qid
    sent_count = max(0, min(len(parts), int(item.get("sent_part_count") or 0)))
    save_queue()
    total = len(parts)
    for index in range(sent_count, total):
        payload = ({"action": "send_private_msg", "params": {"user_id": item["user_id"]}}
                   if item["message_type"] == "private" else
                   {"action": "send_group_msg", "params": {"group_id": item["group_id"]}})
        payload["params"]["message"] = build_outgoing_message(item, parts[index], index, total, target_qid)
        ws_send(payload)
        item["sent_part_count"] = index + 1
        save_queue()
        if index + 1 < total and reply_config["reply_part_delay_ms"] > 0:
            time.sleep(reply_config["reply_part_delay_ms"] / 1000.0)
    return parts, effective_reply


# ==================== HTTP ====================
class Handler(BaseHTTPRequestHandler):
    server_version = "DodoNapcatBridge/1.0"

    def log_message(self, fmt, *args):
        log("http " + (fmt % args))

    def auth_ok(self):
        token = self.headers.get("X-Bridge-Token", "")
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
        return bool(BRIDGE_TOKEN) and token == BRIDGE_TOKEN

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    def queue_stats(self):
        now = int(time.time())
        with _lock:
            return {
                "pending": sum(1 for x in queue if x.get("status") == "pending"),
                "ready": sum(1 for x in queue if x.get("status") == "pending" and int(x.get("ready_at") or 0) <= now),
                "claimed": sum(1 for x in queue if x.get("status") == "claimed"),
                "done": sum(1 for x in queue if x.get("status") == "done"),
                "ignored": sum(1 for x in queue if x.get("status") == "ignored"),
                "skipped": sum(1 for x in queue if x.get("status") == "skipped"),
                "total": len(queue),
                "max": QUEUE_MAX_ITEMS,
            }

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            connected = bool(ws_app and ws_app.sock and ws_app.sock.connected)
            stats = self.queue_stats()
            return self.send_json(200, {
                "ok": True, "ws_connected": connected, "bot_qq": BOT_QQ,
                "server": "dodo_bridge_server/1.0", **stats,
                "config": {
                    "group_reply_mode": reply_config["group_reply_mode"],
                    "private_reply_mode": reply_config["private_reply_mode"],
                    "debounce_seconds": reply_config["debounce_seconds"],
                    "split_reply_enabled": reply_config["split_reply_enabled"],
                    "quote_reply_enabled": reply_config["quote_reply_enabled"],
                    "quote_catch_up_only": reply_config["quote_catch_up_only"],
                    "group_aggregate_window_ms": reply_config["group_aggregate_window_ms"],
                    "at_context_mode": reply_config["at_context_mode"],
                    "at_context_before_sec": reply_config["at_context_before_sec"],
                    "at_context_after_sec": reply_config["at_context_after_sec"],
                    "at_context_count": reply_config["at_context_count"],
                    "aggregate_scope": reply_config["aggregate_scope"],
                    "repeat_flood_detect": reply_config["repeat_flood_detect"],
                    "known_users": reply_config["known_users"],
                    "bot_name": reply_config["bot_name"],
                    "bridge_prompt": reply_config["bridge_prompt"],
                    "private_chunk_size": reply_config["private_chunk_size"],
                    "group_chunk_size": reply_config["group_chunk_size"],
                    "reply_chunk_max_chars": reply_config["reply_chunk_max_chars"],
                    "group_immediate_context": reply_config["group_immediate_context"],
                    "pull_max_count": PULL_MAX_COUNT,
                    "rate_limit_per_min": RATE_LIMIT_PER_MIN,
                    "keep_newest_stale": KEEP_NEWEST_STALE,
                },
            })
        if not self.auth_ok():
            return self.send_json(401, {"ok": False, "error": "unauthorized"})
        if path == "/api/config":
            return self.send_json(200, {"ok": True, "config": reply_config})
        if path == "/api/queue/stats":
            return self.send_json(200, {"ok": True, **self.queue_stats()})
        if path == "/api/pull":
            count = 1
            try:
                count = int(urlparse(self.path).query and dict(
                    kv.split("=", 1) for kv in urlparse(self.path).query.split("&") if "=" in kv).get("count", "1") or "1")
            except Exception:
                count = 1
            items = claim_next(count)
            if not items:
                return self.send_json(200, {"ok": True, "has_message": False, "items": []})
            return self.send_json(200, {
                "ok": True, "has_message": True, "items": [{
                    "id": x["id"], "message_type": x["message_type"], "user_id": x["user_id"],
                    "group_id": x["group_id"], "created_at": int(x.get("created_at") or 0),
                    "selection_required": x.get("selection_required") is True,
                    "is_owner": x.get("is_owner") is True,
                    "trigger": str(x.get("trigger") or ""),
                    "prompt": format_prompt(x),
                } for x in items],
            })
        return self.send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if not self.auth_ok():
            return self.send_json(401, {"ok": False, "error": "unauthorized"})
        try:
            body = self.read_body()
        except Exception:
            return self.send_json(400, {"ok": False, "error": "invalid json"})
        if path == "/api/config":
            global reply_config
            with _lock:
                reply_config = normalize_config({**reply_config, **body})
                save_reply_config()
                for key, entries in list(context_history.items()):
                    if isinstance(entries, list) and len(entries) > context_limit(key):
                        context_history[key] = entries[-context_limit(key):]
                save_context()
            return self.send_json(200, {"ok": True, "config": reply_config})
        if path == "/api/reply":
            item_id = str(body.get("id", ""))
            segments = body.get("segments")   # 可选：完整 OneBot 段数组（P4 用）
            reply = str(body.get("reply", "")).strip()
            if not item_id or (not reply and not segments):
                return self.send_json(400, {"ok": False, "error": "id and reply/segments required"})
            with _lock:
                item = find_item(item_id)
                if not item:
                    return self.send_json(404, {"ok": False, "error": "message not found"})
                if item.get("status") == "done":
                    return self.send_json(200, {"ok": True, "duplicate": True})
            try:
                if segments:
                    # P4 预留：直接发送自定义段数组
                    payload = ({"action": "send_private_msg", "params": {"user_id": item["user_id"], "message": segments}}
                               if item["message_type"] == "private" else
                               {"action": "send_group_msg", "params": {"group_id": item["group_id"], "message": segments}})
                    ws_send(payload)
                    parts = [reply or "[segments]"]
                else:
                    with _lock:
                        parts, reply = send_reply_parts(item, reply)
            except Exception as e:
                return self.send_json(503, {"ok": False, "error": str(e)})
            with _lock:
                item.update({"status": "done", "reply": reply, "replied_at": int(time.time())})
                append_bot_reply(item, reply)
                save_queue()
            return self.send_json(200, {"ok": True, "parts": len(parts)})
        if path == "/api/ignore":
            item_id = str(body.get("id", ""))
            with _lock:
                item = find_item(item_id)
                if not item:
                    return self.send_json(404, {"ok": False, "error": "message not found"})
                item.update({"status": "ignored", "claimed_at": 0, "ignored_at": int(time.time()),
                             "ignore_reason": str(body.get("reason", ""))})
                save_queue()
            return self.send_json(200, {"ok": True})
        if path == "/api/requeue":
            with _lock:
                item = find_item(str(body.get("id", "")))
                if not item:
                    return self.send_json(404, {"ok": False, "error": "message not found"})
                item.update({"status": "pending", "claimed_at": 0})
                save_queue()
            return self.send_json(200, {"ok": True})
        if path == "/api/queue/clear":
            # BUG-03：清空 pending/claimed（保留 done/ignored/skipped 审计 + 已回传项）
            removed = 0
            with _lock:
                keep = []
                for item in queue:
                    if item.get("status") in ("pending", "claimed"):
                        removed += 1
                        continue
                    keep.append(item)
                queue[:] = keep
                save_queue()
            log(f"queue cleared: removed {removed}")
            return self.send_json(200, {"ok": True, "removed": removed})
        if path == "/api/context/clear":
            removed = 0
            with _lock:
                if body.get("all") is True:
                    removed = sum(len(x) for x in context_history.values() if isinstance(x, list))
                    context_history.clear()
                else:
                    keys = []
                    if int(body.get("group_id") or 0):
                        keys.append(f"group:{int(body['group_id'])}")
                    if int(body.get("user_id") or 0):
                        keys.append(f"private:{int(body['user_id'])}")
                    for key in keys:
                        removed += len(context_history.pop(key, []))
                context_seen_ids.clear()
                for entries in context_history.values():
                    for entry in entries:
                        if entry.get("message_id"):
                            context_seen_ids.add(str(entry["message_id"]))
                save_context()
            return self.send_json(200, {"ok": True, "removed": removed})
        return self.send_json(404, {"ok": False, "error": "not found"})


# ==================== 入口 ====================
def main():
    global server_started_at
    if not BRIDGE_TOKEN:
        raise RuntimeError("BRIDGE_TOKEN is required")
    if not BOT_QQ:
        raise RuntimeError("BOT_QQ is required")
    server_started_at = int(time.time())  # 需求（2026-08-22）：记录 Gateway 启动时刻，判定"刚开启回历史消息才引用"
    os.makedirs(DATA_DIR, exist_ok=True)
    load_state()
    clean_stale_queue()  # 需求：开启时丢弃 5 分钟前的内容
    threading.Thread(target=ws_loop, daemon=True).start()
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    log(f"dodo_bridge_server listening on {LISTEN_HOST}:{LISTEN_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()