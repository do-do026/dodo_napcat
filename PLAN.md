# dodo_napcat：NapCat 桥接包统一规划（PLAN）

> ⚠️ **本文为 v1 历史规划（2026-08-16 18:2x），已被 [DESIGN.md](DESIGN.md)（v2 设计文档）取代**。
> 阅读请直接看 DESIGN.md（含需求本源 / 决策记录 / 能力矩阵 / 架构 / 分阶段 / 环境变量）。
>
> 创建：2026-08-16（渡渡 & 初尘）
> 工程目录：`/sdcard/Download/dodo_napcat/`
> 目标：综合两个现存 NapCat 包（择优合并）+ 灌入 qqbot-pro 的收发理念与功能 + 排障
> 阅读顺序：本文 → 三包源码 → 分阶段实施

## 1. 背景与目标

现有三个包三种通道：

| 包 | 通道 | 定位 |
|---|---|---|
| `com.operit.qqbot_pro`（qqbot-pro） | **官方 QQ 开放平台 Bot** | 合规机器人，聚合/上下文/replyTo/成员绑定/UI 完整 |
| `com.operit.napcat_bridge_ui_market` | **NapCat 本地直连**（ws/http） | 小号桥接 + WebView UI + 语音/表情包/QQ空间 |
| `com.wenjili.qq_bridge_universal` | **NapCat 远端服务器轮询** | 服务器托管 + 对话绑定 + 规则矩阵 + 短上下文 |

**目标**：以 NapCat 为通道（可伪装真人小号、无被动时效、原生引用），灌入 qqbot-pro 的 AI 编排能力，并吸收两个 NapCat 包的各自优点，做一个统一增强版。

## 2. 能力矩阵（择优取）

| 能力 | napcat_market | qq_bridge_universal | qqbot-pro | 合并决策 |
|---|---|---|---|---|
| NapCat 连接 | ✅ 本地 ws/http | ✅ 远端服务器 | — | **取 market（本地直连，少一层依赖）** |
| WebView UI | ✅ | — | compose_dsl UI | **取 market** |
| 回复规则矩阵（群/私聊模式） | 群 at/owner/keyword/白名单 | ✅ 群 off/at_only/keyword_or_at/selective/all + 私聊 off/owner_only/whitelist/keyword/all | 群 at_only/keyword_or_at/all | **取 universal（矩阵最全）** |
| 短上下文（前后 N 条） | ✅ groupContextCount | ✅ group_context_limit + 防抖 | ✅ G2 上下文三态 | 三者合一，**对齐 qqbot-pro 的 groupContextMode 语义** |
| AI 聚合（多消息合成一轮） | — | — | ✅ G1 聚合窗口 | **从 qqbot-pro 灌入** |
| replyTo 精确回复 | — | — | ✅ G3 协议头 | **从 qqbot-pro 灌入**（NapCat 无时效，可增强为主动点名） |
| 成员身份映射 | ✅ knownUsers（qq=身份） | — | ✅ groupMemberBindings | 保留 market 的 knownUsers + **可加 NapCat 群昵称** |
| 引用回复 | ✅ quote（原生） | ✅ | message_reference（平台不渲染） | **取 NapCat quote（更好）** |
| 分段回复 | ✅ split + strip | ✅ split + 间隔毫秒 | ✅ G4 chunker | **取 G4 chunker 语义 + market 的 strip** |
| 语音 | ✅ qwen-tts → NapCat record | — | — | **取 market** |
| 表情包 | ✅ sticker | — | — | **取 market** |
| QQ 空间 | ✅ qzone 全套 | — | — | **取 market** |
| 对话绑定 | ✅ fixedChatId | ✅ bind_chat/bind_current_chat | ✅ C2C 绑定 | **取 universal（可当前对话绑定）** |
| 配置模型 | 单 configure + env | 分段 set_* | ✅ 三级优先级 schema | **对齐 qqbot-pro schema 模式** |

## 3. 灌入 qqbot-pro 功能（可移植 / 需重写）

### ✅ 可直接借鉴/移植（逻辑层）
- **G1 群聚合窗口**：`buildGroupAggregateMessageAsync` + 聚合桶（事件 → 聚合文本）
- **G3 replyTo 协议**：`parseGroupReplyDirective` / 聚合编号 `[#N]` / 锚点选择
- **G4 chunker**：`waifu_chunker.js`（纯逻辑，零依赖）
- **G7 成员绑定**：`resolveMemberLabel`（NapCat 可用 user_id 代替 member_openid）
- **G2 上下文三态**：off / automatic / agent_on_demand 语义
- **配置模型**：`bridge_config.js` 的 schema + env 三级优先级 + clamp/迁移
- **G5 落盘认知**：`persist_turn` 落盘结论通用

### ❌ 不可移植（必须重写）
- 官方鉴权（access_token）→ NapCat token
- 官方 Gateway ws → NapCat ws（OneBot11 事件格式）
- 官方发送 API → NapCat `/send_group_msg` / `/send_private_msg`（+ `message_type`、`message`、`quote` 段）
- 被动回复时效 → 无（NapCat 主动发，active_send 变常规路径）

## 4. 架构建议（推荐基座）

```
统一包（ToolPkg）
├─ 通道层：NapCat 本地直连（market 模式）—— ws 收事件 + http 发送
├─ 事件层：OneBot11 事件 → 标准化 {scene,userId,groupId,text,quoteId}
├─ 编排层【灌 qqbot-pro】：聚合窗口 → 上下文 → AI（sendMessageStreaming）→ chunker
│     ├─ replyTo 协议头（编号选择，NapCat 主动引用）
│     └─ 成员映射（knownUsers + NapCat 群昵称）
├─ 规则层【取 universal】：群/私聊回复模式矩阵 + 防抖 + 短上下文
├─ 附加层【取 market】：语音 / 表情包 / QQ空间 / WebView UI
└─ 配置层【对齐 qqbot-pro】：schema + `NAPCAT_*` env + 统一 configure
```

## 5. 排障点清单（需检查）

1. **voice 迭代残留**：market 有 5 个 `.bak_voice_*`/`.bak_qwen_*` 备份 → 语音链路曾多次改，需确认当前版本 record 发送是否稳定
2. **Python 服务**：`napcat_bridge_ui_service.py` 需确认启动/端口/与 JS 交互正常
3. **universal 远端架构**：server python 依赖远端部署，本地直连后此层可能废弃 → 确认是否还要保留
4. **token/密钥**：两个包 token 存储方式，统一到 env，避免明文
5. **事件去重/幂等**：对比 qqbot-pro 的 records/eventKey 去重，NapCat 重连是否会重推
6. **quote 段构造**：OneBot11 的 `CQ:reply` 与 `message.reply` 两种引用方式兼容性
7. **WebView UI vs compose_dsl**：napcat_market 用 WebView，qqbot-pro 用 compose_dsl（已修通）→ 统一时选型
8. **QQ空间 Cookie**：`qzone_cookie` 易失效，刷新链路要健壮

## 6. 分阶段计划

- **P0 侦察**：读透两个 NapCat 包源码（market 1399 行 + universal 635/768 行 + SHORT_CONTEXT 661 行）
- **P1 统一基座**：以 market 本地直连为基座，吸收 universal 规则矩阵 + 短上下文 + 绑定
- **P2 灌入 AI 编排**：聚合 / replyTo / chunker / 成员映射 / 配置 schema（从 qqbot-pro 移植）
- **P3 排障**：按 §5 清单逐项修
- **P4 UI 统一**：选 compose_dsl 或 WebView，补设置页
- **P5 留档**：README / ARCHITECTURE / STATUS / HANDOFF + GitHub

## 7. 环境变量草案（`NAPCAT_*`）

```
NAPCAT_WS_URL / NAPCAT_HTTP_BASE / NAPCAT_TOKEN / NAPCAT_SELF_ID
NAPCAT_OWNER_QQ / NAPCAT_FIXED_CHAT_ID / NAPCAT_CHARACTER_CARD
NAPCAT_GROUP_MODE / NAPCAT_PRIVATE_MODE / NAPCAT_KEYWORDS
NAPCAT_GROUP_CONTEXT_MODE / NAPCAT_GROUP_CONTEXT_LIMIT
NAPCAT_DEBOUNCE_MS / NAPCAT_SPLIT_ENABLED
NAPCAT_VOICE_ENABLED / NAPCAT_VOICE_API_KEY / NAPCAT_VOICE_MODEL / NAPCAT_VOICE_VOICE_ID
NAPCAT_QZONE_ENABLED / NAPCAT_QZONE_UIN / NAPCAT_QZONE_COOKIE
```

> 待办：P0 完成后更新本文件，补充源码级对比结论与最终选型。

*本文件由渡渡与初尘维护。当前状态：P0 侦察中（已解包两个 NapCat 包源码，规模 3790 行）。*