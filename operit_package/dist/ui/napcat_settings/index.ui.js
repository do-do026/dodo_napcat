"use strict";
/*
 * dodo_napcat（com.operit.napcat_pro）设置页（compose_dsl）
 * 通过 ToolPkg.ipc.call 调用 main.js 暴露的桥控制 IPC：
 *   configure / start / stop / status / test_server / run_once / bind_current_chat / set_reply_rules
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Screen;
const CHANNEL = "napcat_pro.bridge.";

function asText(v) { return v == null ? "" : String(v); }

function useStateValue(ctx, key, initialValue) {
  const pair = ctx.useState(key, initialValue);
  return { value: pair[0], set: pair[1] };
}

function callIpc(name, params) {
  try {
    return ToolPkg.ipc.call(CHANNEL + name, params || {});
  } catch (e) {
    return Promise.reject(e);
  }
}

function createSectionTitle(ctx, icon, title) {
  return ctx.UI.Row({ verticalAlignment: "center" }, [
    ctx.UI.Icon({ name: icon, tint: "primary", size: 20 }),
    ctx.UI.Spacer({ width: 8 }),
    ctx.UI.Text({ text: title, style: "titleMedium", fontWeight: "bold", color: "primary" })
  ]);
}

function toErrorText(error) {
  return String((error && error.message) || error || "unknown");
}

function Screen(ctx) {
  const statusState = useStateValue(ctx, "status", {
    configured: false, running: false, serverOk: false, botQq: "",
    queuePending: 0, processedCount: 0, ignoredCount: 0, lastError: ""
  });
  const bridgeUrlState = useStateValue(ctx, "bridgeUrl", "");
  const tokenState = useStateValue(ctx, "token", "");
  const pollIntervalState = useStateValue(ctx, "pollInterval", "3000");
  const pullCountState = useStateValue(ctx, "pullCount", "3");
  const aiTimeoutState = useStateValue(ctx, "aiTimeout", "120000");
  const bindingModeState = useStateValue(ctx, "bindingMode", "fixed");
  const fixedChatIdState = useStateValue(ctx, "fixedChatId", "");
  const characterCardState = useStateValue(ctx, "characterCard", "");
  const groupModeState = useStateValue(ctx, "groupMode", "at_only");
  const keywordsState = useStateValue(ctx, "keywords", "");
  const busyState = useStateValue(ctx, "busy", "");
  const messageState = useStateValue(ctx, "message", "");

  const isBusy = (action) => busyState.value === action;
  const isAnyBusy = busyState.value !== "";
  const setMessage = (text) => messageState.set(text);

  const refresh = async () => {
    busyState.set("refresh");
    try {
      const result = await callIpc("status", {});
      const data = (result && result.data) || result || {};
      const cfg = data.config || {};
      const st = data.state || {};
      const server = data.server || {};
      const queue = data.queue || {};
      statusState.set({
        configured: !!(cfg.bridgeUrl && cfg.bridgeTokenConfigured),
        running: !!st.running,
        serverOk: !!(server && server.ok === true),
        botQq: asText(server.bot_qq || ""),
        queuePending: Number(queue.pending || 0),
        processedCount: Number(st.processedCount || 0),
        ignoredCount: Number(st.ignoredCount || 0),
        lastError: asText(st.lastError || "")
      });
      bridgeUrlState.set(asText(cfg.bridgeUrl || ""));
      pollIntervalState.set(asText(cfg.pollIntervalMs || "3000"));
      pullCountState.set(asText(cfg.pullCount || "3"));
      aiTimeoutState.set(asText(cfg.aiTimeoutMs || "120000"));
      bindingModeState.set(asText(cfg.chatBindingMode || "fixed"));
      fixedChatIdState.set(asText(cfg.fixedChatId || ""));
      characterCardState.set(asText(cfg.characterCardName || ""));
    } catch (e) {
      setMessage("刷新失败：" + toErrorText(e));
    } finally {
      busyState.set("");
    }
  };

  const save = async () => {
    busyState.set("save");
    try {
      const params = {
        bridge_url: bridgeUrlState.value.trim(),
        poll_interval_ms: Number(pollIntervalState.value),
        pull_count: Number(pullCountState.value),
        ai_timeout_ms: Number(aiTimeoutState.value),
        chat_binding_mode: bindingModeState.value,
        fixed_chat_id: fixedChatIdState.value.trim(),
        character_card_name: characterCardState.value.trim()
      };
      if (tokenState.value.trim()) params.token = tokenState.value.trim();
      await callIpc("configure", params);
      tokenState.set("");
      setMessage("连接配置已保存。");
      await refresh();
    } catch (e) {
      setMessage("保存失败：" + toErrorText(e));
    } finally {
      busyState.set("");
    }
  };

  const saveRules = async () => {
    busyState.set("rules");
    try {
      const keywords = keywordsState.value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
      await callIpc("set_reply_rules", { group_reply_mode: groupModeState.value, keywords: keywords });
      setMessage("回复规则已同步到服务器。");
    } catch (e) {
      setMessage("规则保存失败：" + toErrorText(e));
    } finally {
      busyState.set("");
    }
  };

  const start = async () => {
    busyState.set("start");
    try {
      await callIpc("configure", { enabled: true });
      await callIpc("start", {});
      setMessage("桥接已开启。");
      await refresh();
    } catch (e) {
      setMessage("开启失败：" + toErrorText(e));
    } finally {
      busyState.set("");
    }
  };

  const stop = async () => {
    busyState.set("stop");
    try {
      await callIpc("stop", {});
      setMessage("桥接已停止。");
      await refresh();
    } catch (e) {
      setMessage("停止失败：" + toErrorText(e));
    } finally {
      busyState.set("");
    }
  };

  const bindCurrent = async () => {
    busyState.set("bind");
    try {
      const card = characterCardState.value.trim();
      await callIpc("bind_current_chat", card ? { character_card_name: card } : {});
      setMessage("已绑定当前 Operit 对话。");
      await refresh();
    } catch (e) {
      setMessage("绑定失败：" + toErrorText(e));
    } finally {
      busyState.set("");
    }
  };

  const testServer = async () => {
    busyState.set("test");
    try {
      const result = await callIpc("test_server", {});
      const data = (result && result.data) || result || {};
      const health = data.health || {};
      setMessage(health.ok === true ? ("服务器连通，ws_connected=" + !!health.ws_connected) : "服务器不可达或鉴权失败");
    } catch (e) {
      setMessage("测试失败：" + toErrorText(e));
    } finally {
      busyState.set("");
    }
  };

  const runOnce = async () => {
    busyState.set("run_once");
    try {
      const result = await callIpc("run_once", {});
      const data = (result && result.data) || result || {};
      if (data.busy) setMessage("正在处理中，稍候。");
      else if (data.hasMessage === false) setMessage("队列暂无待处理消息。");
      else setMessage("已处理一批消息。");
      await refresh();
    } catch (e) {
      setMessage("执行失败：" + toErrorText(e));
    } finally {
      busyState.set("");
    }
  };

  const modeOptions = [
    { label: "仅 @（at_only）", value: "at_only" },
    { label: "@ 或关键词（keyword_or_at）", value: "keyword_or_at" },
    { label: "选择性（selective）", value: "selective" },
    { label: "全部（all）", value: "all" },
    { label: "关闭（off）", value: "off" }
  ];

  const statusLines = [
    "连接配置：" + (statusState.value.configured ? "已配置" : "未配置"),
    "服务器：" + (statusState.value.serverOk ? "连通" : "未连通"),
    "轮询：" + (statusState.value.running ? "运行中" : "已停止"),
    "队列待处理：" + statusState.value.queuePending,
    "已回复 / 忽略：" + statusState.value.processedCount + " / " + statusState.value.ignoredCount
  ];
  if (statusState.value.botQq) statusLines.push("机器人 QQ：" + statusState.value.botQq);
  if (statusState.value.lastError) statusLines.push("最近错误：" + statusState.value.lastError);

  const msgColor = messageState.value && (messageState.value.indexOf("失败") >= 0 || messageState.value.indexOf("不可达") >= 0 || messageState.value.indexOf("未连通") >= 0) ? "error" : "primary";

  return ctx.UI.LazyColumn({ padding: 16, spacing: 16, content: [
    ctx.UI.Row({ verticalAlignment: "center" }, [
      ctx.UI.Icon({ name: "forum", tint: "primary", size: 24 }),
      ctx.UI.Spacer({ width: 8 }),
      ctx.UI.Text({ text: "渡渡 NapCat 桥", style: "headlineSmall", fontWeight: "bold" })
    ]),
    ctx.UI.Text({ text: "NapCat → Operit → QQ 统一桥设置。", style: "bodyMedium", color: "onSurfaceVariant" }),

    createSectionTitle(ctx, "info", "状态"),
    ctx.UI.Card({ fillMaxWidth: true }, [
      ctx.UI.Column({ padding: 16, spacing: 8 }, statusLines.map((line, i) => ctx.UI.Text({
        key: "s" + i, text: line, style: "bodyMedium", color: "onSurface"
      })))
    ]),

    createSectionTitle(ctx, "link", "连接"),
    ctx.UI.Card({ fillMaxWidth: true }, [
      ctx.UI.Column({ padding: 16, spacing: 12 }, [
        ctx.UI.TextField({ label: "服务器地址（bridge_url）", value: bridgeUrlState.value, onValueChange: bridgeUrlState.set, singleLine: true }),
        ctx.UI.TextField({ label: "Bridge Token（留空保持原值）", value: tokenState.value, onValueChange: tokenState.set, singleLine: true, isPassword: true }),
        ctx.UI.TextField({ label: "轮询间隔（毫秒）", value: pollIntervalState.value, onValueChange: pollIntervalState.set, singleLine: true }),
        ctx.UI.TextField({ label: "批量领取条数", value: pullCountState.value, onValueChange: pullCountState.set, singleLine: true }),
        ctx.UI.TextField({ label: "AI 超时（毫秒）", value: aiTimeoutState.value, onValueChange: aiTimeoutState.set, singleLine: true }),
        ctx.UI.Button({ text: isBusy("test") ? "测试中..." : "测试服务器连通", enabled: !isAnyBusy, fillMaxWidth: true, onClick: async () => await testServer() }),
        ctx.UI.Button({ text: isBusy("save") ? "保存中..." : "保存连接配置", enabled: !isAnyBusy, fillMaxWidth: true, onClick: async () => await save() })
      ])
    ]),

    createSectionTitle(ctx, "chat", "对话绑定"),
    ctx.UI.Card({ fillMaxWidth: true }, [
      ctx.UI.Column({ padding: 16, spacing: 12 }, [
        ctx.UI.Text({ text: "绑定模式", style: "bodySmall", color: "onSurfaceVariant" }),
        ctx.UI.Row({ spacing: 8 }, [
          ctx.UI.Button({ key: "fixed", text: (bindingModeState.value === "fixed" ? "● " : "○ ") + "固定对话", enabled: !isAnyBusy, onClick: () => bindingModeState.set("fixed") }),
          ctx.UI.Button({ key: "auto", text: (bindingModeState.value === "auto" ? "● " : "○ ") + "自动开对话", enabled: !isAnyBusy, onClick: () => bindingModeState.set("auto") })
        ]),
        ctx.UI.TextField({ label: "固定对话 ID（fixed 模式）", value: fixedChatIdState.value, onValueChange: fixedChatIdState.set, singleLine: true }),
        ctx.UI.TextField({ label: "角色卡名称", value: characterCardState.value, onValueChange: characterCardState.set, singleLine: true }),
        ctx.UI.Button({ text: isBusy("bind") ? "绑定中..." : "绑定当前 Operit 对话", enabled: !isAnyBusy, fillMaxWidth: true, onClick: async () => await bindCurrent() })
      ])
    ]),

    createSectionTitle(ctx, "groups", "群回复规则（同步到服务器）"),
    ctx.UI.Card({ fillMaxWidth: true }, [
      ctx.UI.Column({ padding: 16, spacing: 12 }, [
        ctx.UI.Text({ text: "群触发模式", style: "bodySmall", color: "onSurfaceVariant" }),
        ctx.UI.Column({ spacing: 6 }, modeOptions.map((opt) => ctx.UI.Button({
          key: opt.value, text: (groupModeState.value === opt.value ? "● " : "○ ") + opt.label,
          enabled: !isAnyBusy, fillMaxWidth: true, onClick: () => groupModeState.set(opt.value)
        }))),
        ctx.UI.TextField({ label: "触发关键词（逗号分隔）", value: keywordsState.value, onValueChange: keywordsState.set, singleLine: false }),
        ctx.UI.Button({ text: isBusy("rules") ? "保存中..." : "同步回复规则", enabled: !isAnyBusy, fillMaxWidth: true, onClick: async () => await saveRules() })
      ])
    ]),

    createSectionTitle(ctx, "power", "控制"),
    ctx.UI.Card({ fillMaxWidth: true }, [
      ctx.UI.Column({ padding: 16, spacing: 12 }, [
        ctx.UI.Button({ text: isBusy("start") ? "开启中..." : "开启桥接（start）", enabled: !isAnyBusy, fillMaxWidth: true, onClick: async () => await start() }),
        ctx.UI.Button({ text: isBusy("stop") ? "停止中..." : "停止桥接（stop）", enabled: !isAnyBusy, fillMaxWidth: true, onClick: async () => await stop() }),
        ctx.UI.Button({ text: isBusy("run_once") ? "处理中..." : "立即处理一批（run_once）", enabled: !isAnyBusy, fillMaxWidth: true, onClick: async () => await runOnce() }),
        ctx.UI.Button({ text: isBusy("refresh") ? "刷新中..." : "刷新状态", enabled: !isAnyBusy, fillMaxWidth: true, onClick: async () => await refresh() })
      ])
    ]),

    messageState.value ? ctx.UI.Text({ text: messageState.value, style: "bodyMedium", color: msgColor }) : ctx.UI.Spacer({ width: 1 })
  ]});
}

function __operit_render_compose_dsl(ctx) { return Screen(ctx); }
exports.__operit_render_compose_dsl = __operit_render_compose_dsl;
