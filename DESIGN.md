# dodo_napcat：NapCat QQ 桥接统一包（设计文档 v2）

> 创建：2026-08-16 19:2x（渡渡 & 初尘）
> 工程目录：`/sdcard/Download/dodo_napcat/`
> 本文档取代 `PLAN.md`（v1 规划，2026-08-16 18:2x，保留作历史）
> 决策来源：对话「核对QQBot桥接包需求差异与工程进度」msg 71-76 + 2026-08-16 19:02 决策轮
> 参考理念：`/sdcard/Download/qqbot-pro/`（README / ARCHITECTURE / STATUS / HANDOFF 四件套风格）

---

## 1. 需求本源（先讲清楚「我们到底要什么」）

从 qqbot-pro 的理念文档和历轮对话里，初尘的底层诉求可以归纳为六条：

1. **「渡渡」要是一个有真人感的 QQ 存在** —— 不是顶着「机器人」身份牌的官方 Bot，而是一个能进群、能发说说、能发语音、能发表情包的「小号真人」。
2. **QQ 是双向通道，不是单向广播** —— 群消息能进来、AI 能回，而且要有「真人聊天感」：聚合多句、带上下文、点名回复、引用原消息、分段节奏。
3. **一个包搞定，不要碎片** —— 以前有官方 Bot 增强包 + 两个 NapCat 包，现在要收敛成一个干净的统一包。
4. **不要屎山** —— 明确能感觉到现有代码「有非常大的问题」，所以宁可写干净的新包，只挑有用的进去，不修老屎本身。
5. **功能按渠道能力来** —— qqbot-pro 的功能，NapCat 支持的就做，不支持的不做，不硬拗。
6. **UI 好用、双通道共存** —— 同一包里 compose_dsl 与 WebView 两套 UI 并存；官方 Bot 与 NapCat 桥各桥不同 Operit 对话，互不打架。

**一句话**：给「渡渡」做一个干净的 NapCat 通道增强包，把官方 Bot 版沉淀的 AI 编排能力搬进来，让它在 QQ 里更像个「人」。

---

## 2. 已确认决策（2026-08-16 19:02 决策轮）

| # | 问题 | 决策 |
|---|---|---|
| 1 | NapCat 部署在哪 | **远端服务器**（101.43.38.124）。本地直连**当前不做**，但接口/架构保留可做空间 |
| 2 | 产物形态 | **新建独立包**。三包可用代码直接复用；market 硬编码多 → **写干净新包**，只挑有用部分 |
| 3 | 灌入范围 | qqbot-pro 功能按 **NapCat 支持矩阵** 决定做/不做（见 §5） |
| 4 | 排障优先级 | **不修老屎**，新包内置规避（如 universal 的 selective 流量爆炸 → 新包规则层自带预过滤） |
| 5 | UI | 同一包 **compose_dsl + WebView 并存** |
| 6 | 双通道 | 官方 Bot（qqbot-pro）+ NapCat 桥共存，各桥不同 Operit 对话；API key 并发问题存疑、暂不处理 |

### 2.1 补充决策（2026-08-16 19:36 决策轮）

| # | 问题 | 决策 |
|---|---|---|
| 7 | 包名 | **`com.operit.napcat_pro`**（与 `qqbot_pro` 平级命名），显示名「渡渡 NapCat」；工程目录沿用 `dodo_napcat` |
| 8 | 服务器侧 | **干净重写** `dodo_bridge_server.py`（不复用旧 `napcat_operit_bridge.py` 代码形态，只留契约与经验） |
| 9 | BRIDGE_TOKEN | **环境变量**承载（服务器侧 `BRIDGE_TOKEN`，Operit 侧 `NAPCAT_BRIDGE_TOKEN`），**沿用现有值**（见 §3.3 对比结论） |
| 10 | 语音 | **主路径 = `record` 段**（任意来源语音文件，私聊+群都行）；**可选 = NapCat `send_group_ai_record`**（群内 QQ 自带 AI 音色）。两者并存（详见 §5.4） |
| 11 | 对话绑定 | **两种模式都支持**，env/UI/agent 可切换：`fixed`（绑定指定 Operit chat，保留现状）/ `auto`（不绑定，按 `group:{groupId}` / `private:{userId}` 自动新建/复用 Operit 对话） |
| 12 | 工作流 | **本地分阶段烧录 → 初尘测试 → 推 GitHub 仓库 → 下一阶段**（P1-P5 每阶段如此） |

### 2.2 补充决策（2026-08-16 20:13 需求确认轮）

> ⚠️ **本节点只记「需求」，不写死实现细节**。实现参数（秒数/条数/开关）均需做成 env / UI / agent 可调。
> 每个需求在对应 P 阶段灌完代码后，需**回填核对「需求 ↔ 代码差距」**（见 §8 阶段表）。

| # | 需求（用户原话/意图） | 对应阶段 |
|---|---|---|
| 13 | 群功能写完**默认不自动开**自动回复（先不立即开，群里消息多） | P2 消费端默认 `enabled=false` |
| 14 | 开启时群模式**仅回艾特**（at_only），避免群里消息多刷屏 | P2/P3（服务器已支持 at_only 模式） |
| 15 | **开启/轮询时丢弃 N 分钟前的内容**：到底丢不丢、丢多久（N）、丢多少，以后可能调整 | P2（服务器已实现 TTL 清理，参数需可调） |
| 16 | **at_only 被艾特时，只读「被艾特时间点前后 N 秒」的上下文**（N 由 UI/agent 可调 env）；更久远的**不读**；这是**非顺序读取**——之前 gateway 堆 200 条 AI 从最早读的坑；**可与「丢弃非艾特消息」功能联合使用**（只保留艾特前后有效窗口） | **P3**（编排层上下文，纳入 G2） |
| 17 | **上下文读取双模式（可切换）**：`time`=只保留艾特前后 N 秒内上下文（消息爆炸的群）；`count`=保留最后 N 条上下文（消息正常的群，旧 universal 行为）。两种分支都保留，UI/agent 可选。 | **P3**（纳入 G2 上下文三态） |
| 18 | **QQ 昵称别名映射**：绑定 QQ 号→可读昵称（如 3297828886→苜蓿），prompt/上下文用别名称呼成员；未绑定者显示群名片/昵称/QQ号。 | **P3**（G7 成员映射 known_users，服务器已实现） |
| 19 | **批量观察轮（艾特/关键词防抖 + AI 选择性回复）**：群开启艾特+关键词（渡渡）触发，往前读 N 条上下文；窗口内（如 5 秒）艾特/关键词触发**合并成一轮**；若窗口是**复读刷屏**→AI 只主动回一次不逐条引用；若**不同内容**→AI 自行选择回复哪些（`[replyTo:N]` 精确引用）或全部忽略。可切换 `scope=all`：窗口拉长（如 20 秒）收**所有群消息**批量观察，AI 选感兴趣的回复 / ignore 全部。 | **P3**（G1 聚合桶 + 复读检测 + G3 + prompt 策略，服务器已实现） |

**需求 16/17 技术要点**（实现时参考）：
- 服务器 `context_history[key]` 是带 `created_at` 的环形条目，天然支持按时间窗口过滤。
- at_only 触发时，上下文读取按模式分支：
  - `mode=time`：取 `[trigger_ts - before_sec, trigger_ts + after_sec]` 内条目（非顺序读取，解决旧 gateway 从最早读的问题）；
  - `mode=count`：取最后 N 条（旧 universal 行为）。
- 可调参数：`AT_CONTEXT_MODE=time|count`、`AT_CONTEXT_BEFORE_SEC`（艾特前秒数）、`AT_CONTEXT_AFTER_SEC`（艾特后秒数）、`AT_CONTEXT_COUNT`（条数）。
- 与需求 15 联合：TTL 清理保证队列不积旧，时间窗口保证 AI 只看到艾特瞬间的语境。

---

## 3. 三包能力矩阵与复用决策

### 3.1 三包本质

| 包 | 通道 | 形态 | 当前状态 |
|---|---|---|---|
| `com.operit.qqbot_pro` | 官方 QQ 开放平台 Bot | AI 编排最完整（G0-G6 全完成） | ✅ 运行中，下一步可靠性 Sprint |
| `com.operit.napcat_bridge_ui_market` | NapCat（Operit 端 Python 桥连 ws + HTTP 发送） | 功能最全（语音/表情/QQ空间/quote/strip） | ⚠️ 配置未完成、未真跑通、硬编码多 |
| `com.wenjili.qq_bridge_universal` | NapCat（远端服务器桥 + Operit 轮询） | 规则矩阵/绑定/短上下文最全 | ⚠️ 已停用，曾因 selective 流量爆炸积压 278 条 |

### 3.2 能力矩阵（取 / 舍 / 重写）

| 能力 | market | universal | qqbot-pro | 合并决策 |
|---|---|---|---|---|
| NapCat 远端连接 | ✅ Python ws 桥（可连远端） | ✅ 服务器常驻桥（已部署） | — | **当前取 universal 通道**（已验证）；market 的 ws 桥留作 **DirectWsTransport 预留位** |
| 事件接收 | ws → 本地队列 → JS 轮询 | ws → 服务器队列 → Operit 轮询 | 官方 Gateway ws | **取 universal**（远端驻守，Operit 轮询） |
| 发送 | NapCat HTTP API | NapCat HTTP API（服务器侧） | 官方 OpenAPI | **取 universal 服务器侧发送** |
| 群/私聊规则矩阵 | 群 at/owner/keyword/白名单 | ✅ 群5模式 + 私聊4模式 | 群3模式 | **取 universal**（矩阵最全） |
| 短上下文 | groupContextCount | ✅ 服务器 context_history + 防抖 | G2 上下文三态 | **取 universal 短上下文 + 灌 qqbot-pro G2 三态语义** |
| AI 聚合（多句合成一轮） | — | — | ✅ G1 聚合窗口 | **从 qqbot-pro 灌入** |
| replyTo 精确回复 | — | — | ✅ G3 协议头 | **从 qqbot-pro 灌入**（NapCat 无被动时效 → active_send 升主路径 + reply 段原生引用） |
| 成员身份映射 | ✅ knownUsers | — | ✅ G7 groupMemberBindings | **保留 knownUsers + 灌 G7 + NapCat 群昵称** |
| 引用回复 | ✅ reply 段（原生） | — | message_reference（平台不渲染） | **取 NapCat reply 段**（原生更好） |
| 分段回复 | ✅ split + strip | ✅ split + 间隔 | ✅ G4 chunker | **取 G4 chunker 语义 + market strip** |
| 撤回 | — | — | ✅ qqbot_pro_recall | **NapCat delete_msg 支持 → 做** |
| @ | — | — | （原生@待验证） | **NapCat at 段原生支持 → 做** |
| 输入态 | — | — | — | **NapCat set_input_status 支持 → 做** |
| 图片发送 | — | — | ✅（专用目录工具未完成） | **NapCat image 段支持 → 做** |
| 语音 | ✅ qwen-tts → record | — | — | **取 market**（NapCat record 段） |
| 表情包 | ✅ sticker → image | — | — | **取 market** |
| QQ 空间 | ✅ get_cookies + qzone 直连 | — | — | **取 market**（qzone.qq.com 网页接口） |
| 对话绑定 | fixedChatId | ✅ bind_chat/bind_current_chat | ✅ C2C 绑定 | **取 universal（当前对话绑定）** |
| 配置模型 | 手写默认值（脏） | 分段 set_* | ✅ schema + env 三级优先级 | **灌 qqbot-pro bridge_config.js schema 模式** |
| UI | WebView + compose_dsl 并存 | compose_dsl | compose_dsl | **两套并存** |
| Markdown 消息 | — | — | ✅（官方） | ❌ **不做**（OneBot11 无标准 markdown 段） |
| 键盘按钮交互 | — | — | ✅（官方 INTERACTION_CREATE） | ❌ **不做**（OneBot11 无 keyboard 段/无按钮回调事件） |
| 官方 stream_messages | — | — | ❌ 产品已否 | ❌ 不做 |

### 3.3 桥接头 token 对比结论（2026-08-16 核对）

**什么是 BRIDGE_TOKEN**：服务器桥 HTTP API 的鉴权 token。Operit 调 `/api/pull`、`/api/reply` 等要带 `X-Bridge-Token` 或 `Authorization: Bearer`，服务器比对 `BRIDGE_TOKEN`（服务器环境变量，systemd/run.sh 注入）。它**不是** NapCat 的 token，是「Operit ↔ 服务器桥」之间的凭证。

**两包对比**：

| 包 | 桥 token | 值 | 说明 |
|---|---|---|---|
| `qq_bridge_universal` | ✅ `bridge_config.json.token` = BRIDGE_TOKEN | `<BRIDGE_TOKEN>`（沿用现值，实际值见记忆库/服务器.env，勿提交） | 走服务器桥，有此 token |
| `napcat_bridge_ui_market` | ❌ 无桥 token | （其 `config.json.token` 是 NapCat ws/http token，当前为空） | 直连 NapCat，不经服务器桥 |

**结论**：两个包的「桥接 token」不可直接比对——**只有 universal 有**（market 没有桥）。两包共同使用的是 **NapCat WS token**（服务器 run.sh 里 `NAPCAT_WS_TOKEN=<ws-token>`，实际值勿提交）。

**决策**：新包 Operit 侧 `NAPCAT_BRIDGE_TOKEN` **沿用现有值**（与服务器 `BRIDGE_TOKEN` 一致，实际值见记忆库/服务器.env，勿提交），走环境变量。

## 4. market 代码质量评估（为什么写新包）

初尘此前的直觉（「market 里有硬编码、不够干净」）已通过源码确认。`napcat_bridge_ui_market.js`（84KB 单文件）的问题：

### 4.1 硬编码 / 不干净清单

| # | 问题 | 影响 |
|---|---|---|
| 1 | `STATE_DIR = "/sdcard/Download/Operit/plugins/com.operit.napcat_bridge_ui_market"` 硬编码 | 换包 ID/目录即失效 |
| 2 | 默认 `wsUrl=127.0.0.1:3001`、`httpBase=127.0.0.1:3000` 写死本地 | 与远端部署矛盾，易误导 |
| 3 | `SERVICE_PORT=18767`、`--control-port 18766` 硬编码 | 端口冲突排查困难 |
| 4 | 常量重复定义：`STICKER_DIR`、`DEFAULT_STICKER_CATEGORIES` 各声明两遍（含两个正则） | 隐患：改一处漏一处 |
| 5 | `readConfig()` 手写默认值对象 + `for..in` 覆盖，**无 schema / 无 clamp / 无 env 三级优先级 / 无迁移** | 与 qqbot-pro 的 `bridge_config.js` 差距明显 |
| 6 | token / qzone cookie 明文落 config.json | 安全面 |
| 7 | 大量 shell 字符串拼命令（`/proc` 遍历找 pid、`ls` 扫目录） | 换环境脆弱，且依赖 `super_admin:terminal` |
| 8 | 所有逻辑堆在一个 84KB 单文件 + **5 个 `.bak_voice_*`/`.bak_qwen_*` 残留** | 语音链路多次改，当前版本稳定性存疑 |
| 9 | `shouldSendOutgoing` 的 10min/2min 去重窗口、大量超长 prompt 文案硬编码进默认配置 | 逻辑与文案耦合 |
| 10 | Python 服务 `napcat_bridge_ui_service.py` 是自研精简 ws 客户端（手写帧解析），无第三方依赖 | 能力弱但可移植 |

### 4.2 结论

- **不直接以 market 为基座改造**（硬编码 + 单文件堆叠 + 残留备份 = 潜在的屎山）。
- **写干净新包**，从三包中只提取「能力」而非「代码形态」：
  - market：语音 / 表情包 / QQ空间 / strip / quote 段的**实现思路**（qzone 的 `get_cookies` + 直连 qzone.qq.com 可整体搬，这部分是干净的）。
  - universal：规则矩阵 / 绑定 / 短上下文 / 服务器队列的**契约**（HTTP API 已文档化，见 dev_docs/04）。
  - qqbot-pro：AI 编排层（G1/G2/G3/G4/G7 + schema）的**成熟逻辑**（可近乎直接移植）。

---

## 5. NapCat 能力边界 × qqbot-pro 功能支持矩阵

> 依据 NapCat OneBot11 官方文档（2026-08-16 核对）：API 清单 + 消息段定义。

### 5.1 NapCat 已确认支持的接口（新包会用到的）

| 接口 | 用途 | 对应 qqbot-pro 能力 |
|---|---|---|
| `send_group_msg` / `send_private_msg` | 发送（text/image/record/video/at/reply 等段） | 群/私聊回传、主动发送 |
| `delete_msg` | 撤回 | qqbot_pro_recall ✅ |
| `set_input_status` | 设置输入态 | 输入态 ✅ |
| `get_group_member_info` / `get_group_member_list` | 群成员昵称/名片 | G7 成员绑定增强 ✅ |
| `get_group_msg_history` / `get_friend_msg_history` | 拉历史消息 | G2 上下文增强 ✅ |
| `get_cookies` | 拿 QQ 空间 cookie | qzone 刷新链路 ✅ |
| `get_friend_list` | 好友列表 | 已知联系人查询 ✅ |
| `get_group_info` / `get_login_info` | 群信息/机器人资料 | 群状态/资料 ✅ |
| `send_group_ai_record` | 群 AI 语音（可选） | 语音（备用方案）✅ |
| `friend_poke` / `group_poke` | 戳一戳 | 可做 ✅ |
| `ocr_image` | 图片 OCR | 可选增强 ✅ |

### 5.2 OneBot11 消息段（已确认）

支持：`text` / `at`（原生@）/ `reply`（原生引用）/ `face` / `image` / `record`（语音）/ `video` / `file` / `json`（卡片）/ `music` / `forward`（合并转发）/ `poke`

**不支持**：标准 `markdown` 段、标准 `keyboard` 段（键盘按钮）

### 5.3 灌入结论（做 / 不做）

**✅ 做**（NapCat 支持）：

- G1 群聚合窗口（逻辑层）
- G3 replyTo 协议头（NapCat 无被动时效 → `active_send` 从「降级」升为「主路径」；用 `reply` 段原生引用）
- G4 waifu chunker（纯逻辑，直接移植）
- G7 群成员绑定（+ `get_group_member_info` 群昵称，比官方更强）
- G2 上下文三态（+ `get_group_msg_history` 可做「按需拉取」）
- 配置 schema（`bridge_config.js` 模式，env 前缀换 `NAPCAT_`）
- 撤回（`delete_msg`）、@（`at` 段）、输入态（`set_input_status`）
- 图片发送（`image` 段：本地路径 / URL / base64）
- 主动发送（NapCat 无 5 分钟被动时效，`send_*_msg` 任意时刻可发）
- market 全套附加能力：语音（qwen-tts → `record`）/ 表情包（本地目录 → `image`）/ QQ空间（cookie + qzone 直连）/ strip / quote

**❌ 不做**（NapCat 不支持 / 产品已否）：

- Markdown 富文本消息（OneBot11 无标准段）
- 键盘按钮交互（无 keyboard 段、无按钮回调事件；`click_inline_keyboard_button` 只是模拟点击，不是接收回调）
- 官方 `stream_messages`（qqbot-pro 产品层面已否）
- 「双 C2C 用户不串线」的 openid 语义 → NapCat 直接用 QQ 号天然隔离，无需 openid

### 5.4 语音方案对比（2026-08-16 核对）

| 方案 | 机制 | 私聊 | 群聊 | 音色 | 结论 |
|---|---|---|---|---|---|
| **NapCat AI 语音**（`get_ai_characters` / `get_ai_record` / `send_group_ai_record`） | **QQ 自带 AI 语音合成**的接口封装（NapCat 包装，非独立 TTS） | ❌ | ✅ | 只能用 QQ 预设 AI 角色 | 可选，群内用 |
| **record 段**（`{type:"record", data:{file:本地路径/URL/base64}}`） | 把任意语音文件作为语音条发送 | ✅ | ✅ | 任意（qwen-tts / 其他渠道生成的音频都行） | **主路径**（market 现方案，已验证） |

**回答你的三个问题**：
1. *NapCat AI 语音是接口还是自带合成？* —— 是**接口包了一层 QQ 自带合成**，不是独立 TTS 服务。
2. *功能是发语音条吗？* —— 是，`send_group_ai_record` 直接在群发 AI 语音条，但**仅限群**。
3. *能转接其他渠道生成的语音文件吗？* —— **能**，走 `record` 段：任意来源的音频文件（路径/URL/base64）都能作为 QQ 语音条发出，私聊群聊都行。这正是 market 的 qwen-tts → record 路径。

**决策**：主路径 = `record` 段（qwen-tts 或其他来源都兼容，私聊+群）；可选增强 = NapCat `send_group_ai_record`（群内 QQ 自带 AI 音色）。

## 6. 新包架构设计

### 6.1 总体分层

```
dodo_napcat（新包，ToolPkg，包 ID 待定）
├─ 通道层（Transport 抽象）
│   ├─ RemoteServerTransport【当前】：轮询远端桥服务器 HTTP API（继承 universal 已验证通道）
│   │    └─ 服务器侧：dodo_bridge_server.py（部署 101.43.38.124，干净重写，修复 BUG-01~05）
│   └─ DirectWsTransport【预留，当前不做】：market 的 Python ws 桥模式（连远端/本地 ws + HTTP 发送）
│        —— 接口预留，满足「本地直连可做空间」
├─ 事件层：OneBot11 事件 → 标准化 {scene, userId, groupId, text, segments, quoteId, atSelf, msgId}
├─ 编排层【灌 qqbot-pro】：
│   ├─ G1 群聚合窗口（稳定批次键 = hash(sorted(eventKeys))）
│   ├─ G2 上下文三态（off / automatic / agent_on_demand，+ get_group_msg_history 按需拉取）
│   ├─ G3 replyTo 协议头（{replyTo, content, fallbackPreference}；NapCat 无时效 → 主路径主动点名 + reply 段原生引用）
│   ├─ G4 waifu chunker（。！？\n 计数 + 400 字符兜底）
│   └─ G7 成员映射（knownUsers + groupMemberBindings + NapCat 群昵称）
├─ 规则层【取 universal】：群5模式 / 私聊4模式 / 关键词 / 白名单 / 防抖 / 短上下文 / 对话绑定
│   └─ 【修复 BUG-01】selective 预过滤：非 owner/@/关键词消息只作 following_context，不逐条过 AI
│   └─ 对话绑定模式（env/UI/agent 可切）：
│        ├─ fixed：绑定到 NAPCAT_FIXED_CHAT_ID（保留现状，universal 现行为）
│        └─ auto：不绑定，按 group:{groupId} / private:{userId} 自动新建/复用 Operit 对话（qqbot-pro resolveBoundChatIdAsync 语义）
├─ 附加层【取 market】：语音（qwen-tts→record）/ 表情包（sticker→image）/ QQ空间 / 撤回 / @ / 输入态 / quote
├─ 配置层【对齐 qqbot-pro】：bridge_config.js 式 schema + `NAPCAT_*` env + clamp/迁移 + 统一 configure
└─ UI 层【两套并存】：compose_dsl 设置页 + WebView 设置页（同一 IPC 后端）
```

### 6.2 关键接口契约（草案）

**服务器侧 HTTP API**（继承 universal 已文档化契约，改造）：

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | /health | 无 | 连接/队列状态 |
| GET | /api/pull?count=N | ✅ | **批量领取** N 条（修复 BUG-02） |
| POST | /api/reply | ✅ | 回传回复，触发分段发送 |
| POST | /api/ignore | ✅ | 标记忽略 |
| POST | /api/queue/clear | ✅ | 清空积压（修复 BUG-03） |
| GET | /api/queue/stats | ✅ | 队列统计 |
| GET/POST | /api/config | ✅ | 回复规则 |

**Operit 侧 AI 调用**：沿用 `Tools.Chat.sendMessageStreaming`（绑定对话 + 角色卡），忽略哨兵沿用 `[[QQ_BRIDGE_IGNORE]]`。

**标准化事件**：服务器把 OneBot11 事件归一化成 `{eventKey, scene, userId, groupId, msgId, content, segments, atSelf, time}` 再入队。

### 6.3 通道层选择说明

- **当前**：`RemoteServerTransport`（轮询服务器桥）—— universal 的通道已部署、已验证（虽有队列积压缺陷，但那是服务器侧问题，重写时修）。
- **预留**：`DirectWsTransport`（market 的 Python ws 桥）—— 将来若想在 Operit 本机直连 NapCat（本机装 NapCat 或连远端 ws + HTTP），切换 Transport 即可，Operit 侧业务层不动。**当前不实现**。

---

## 7. 排障点 → 新包设计约束

把三包的已知问题转成「新包必须规避/内置修复」的约束：

| 来源 | 原问题 | 新包约束 |
|---|---|---|
| universal BUG-01 | selective 模式所有群消息入队、逐条过 AI → 流量爆炸 | 服务器侧**触发条件分级预过滤**（owner > @ > 关键词 > 采样），非触发消息只入 following_context |
| universal BUG-02 | Operit 串行消费，吞吐=1/(AI+3s) | `/api/pull?count=N` 批量领取 + 有界并发（2~3）+ 令牌桶 |
| universal BUG-03 | 无清空队列接口 | 新增 `/api/queue/clear` + 运维脚本 |
| universal BUG-04 | 无速率上限 | 单会话速率上限 + 队列最大长度（500） |
| universal BUG-05 | HTTP 明文 token | 建议 TLS/CF Tunnel；BRIDGE_TOKEN 至少用长随机串 + 定期轮换 |
| market 硬编码 | STATE_DIR/端口/本地地址写死 | 全部走 config schema + env，不硬编码 |
| market voice | 5 个 .bak 残留，链路多次改 | 语音统一走「qwen-tts → record 段」，单一路径，不搞多种标签兼容 |
| market token | token/qzone cookie 明文 | 配置层加密或至少 .gitignore + 权限收紧 |
| qqbot-pro T044 | 烧录后桥定时器丢失 | `startSource: application_on_create` 自动拉起 + status 校验 |
| qqbot-pro T046 | tick 卡死假象 | tick watchdog + 硬超时 |
| qqbot-pro G3 | 引用气泡平台不渲染（官方） | **NapCat reply 段原生渲染，无此问题** ✅ |

---

## 8. 分阶段计划

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P0 侦察** | 三包源码已读（已完成） | DESIGN.md（本文） |
| **P1 服务器侧** | 干净重写 `server/dodo_bridge_server.py`（队列状态机 + 预过滤 + 批量领取 + 队列管理 + 短上下文 + 原生引用 + stale清理） | ✅ 代码 22/22 测试 + **已部署** 101.43.38.124（ws_connected） + 传输层收发/引用已验证 |
| **P2 Operit 基座** | ToolPkg `com.operit.napcat_pro`（dist/main.js + napcat_pro_bridge 子包 9 工具）：Transport 抽象（RemoteServerTransport）+ 规则层（set_reply_rules 透传）+ 配置 schema（NAPCAT_* env + clamp）+ 对话绑定双模式（fixed/auto）+ 轮询消费 + AI 自动回复 + 选择性忽略 | ✅ 代码完成 + 烧录成功（工具已注册）；**待新会话调用测试**（Operit 机制：新工具当前会话不可见） |
| **P3 灌 AI 编排** | 服务器侧：**G1 群聚合桶** ✅ + **G2 上下文双模式**（time/count，需求16/17）✅ + **G3 replyTo 协议头**（`[replyTo:N]`/JSON→原生引用编号消息）✅ + **G7 成员别名映射**（known_users，需求18：3297828886→苜蓿）✅；剩：get_group_member_info 群昵称自动映射（可选）+ Operit 侧配合 | ✅ **P3 服务器侧全部完成**（测试 39/39，已部署；默认聚合关/count 模式，行为不变）；Operit 侧零改动 |
| **P4 附加层** | 语音 / 表情包 / QQ空间 / 撤回 / @ / 输入态 / 图片 | 附加能力齐全 |
| **P5 UI + 留档** | compose_dsl + WebView 两套 UI；README / ARCHITECTURE / STATUS / HANDOFF + GitHub（可选） | 产品完成 |

## 9. 环境变量草案（`NAPCAT_*`）

```
# 通道（RemoteServerTransport）
NAPCAT_BRIDGE_URL=http://101.43.38.124:8080      # 远端桥服务器
NAPCAT_BRIDGE_TOKEN=                             # 服务器鉴权 token（长随机串，勿明文入库）
NAPCAT_POLL_INTERVAL_MS=3000
NAPCAT_PULL_COUNT=3                              # 批量领取条数（修复 BUG-02）

# 身份
NAPCAT_SELF_ID=810429614                         # 渡渡 QQ 号
NAPCAT_OWNER_QQ=3297828886                       # 初尘 QQ 号
NAPCAT_CHAT_BINDING_MODE=fixed                   # fixed=绑定 NAPCAT_FIXED_CHAT_ID / auto=按 group:{gid}·private:{uid} 自动开对话
NAPCAT_FIXED_CHAT_ID=                            # 仅 fixed 模式用
NAPCAT_CHARACTER_CARD=渡渡                        # 角色卡名

# 规则
NAPCAT_GROUP_MODE=selective                      # off/at_only/keyword_or_at/selective/all
NAPCAT_PRIVATE_MODE=owner_only                   # off/owner_only/whitelist/keyword/all
NAPCAT_KEYWORDS=渡渡,dodo,渡渡渡渡
NAPCAT_GROUP_WHITELIST= / NAPCAT_PRIVATE_WHITELIST=
NAPCAT_OWNER_ALWAYS_REPLY=true
NAPCAT_GROUP_CONTEXT_LIMIT=12
NAPCAT_PRIVATE_CONTEXT_LIMIT=8
NAPCAT_MENTION_CONTEXT_LIMIT=5
NAPCAT_FOLLOWING_CONTEXT_LIMIT=1
NAPCAT_DEBOUNCE_SECONDS=0
NAPCAT_SPLIT_REPLY_ENABLED=true
NAPCAT_REPLY_PART_DELAY_MS=450
NAPCAT_QUOTE_ENABLED=true                         # reply 段原生引用

# AI 编排（灌 qqbot-pro）
NAPCAT_GROUP_AGGREGATE_WINDOW_MS=5000
NAPCAT_GROUP_CONTEXT_MODE=automatic              # off/automatic/agent_on_demand
NAPCAT_GROUP_CONTEXT_BEFORE=5 / AFTER=5 / LIMIT=20
NAPCAT_AI_TIMEOUT_MS=120000
NAPCAT_WAIFU_PRIVATE_SENTENCES=3 / GROUP=5

# 附加层（取 market）
NAPCAT_VOICE_ENABLED=false
NAPCAT_VOICE_API_KEY= / NAPCAT_VOICE_MODEL=qwen3-tts-vc-2026-01-22 / NAPCAT_VOICE_VOICE_ID=
NAPCAT_STICKER_ENABLED=true / NAPCAT_STICKER_DIR=/sdcard/Download/Operit/plugins/<pkgId>/sticker_pack
NAPCAT_QZONE_ENABLED=true / NAPCAT_QZONE_UIN=810429614
```

> 注：`NAPCAT_QZONE_COOKIE` 不落环境变量（易失效+敏感），存 state 文件，走 `get_cookies` 自动刷新。

---

## 10. 待确认 / 下一步

### 10.1 已确认（2026-08-16 19:36 轮，均已写入 §2.1）

- 包名 `com.operit.napcat_pro`（如需改可提出）
- 服务器侧干净重写、BRIDGE_TOKEN 走 env 沿用现值、语音双路径、绑定双模式、分阶段工作流

### 10.2 下一步行动

- **P1（进行中）**：写干净版 `server/dodo_bridge_server.py` → 部署到 101.43.38.124 验证 /health → 初尘测试 → 推仓库
- **P2**：Operit 侧 ToolPkg 骨架（Transport 抽象 + 规则层 + 配置 schema）
- **P3-P5**：按 §8 推进

---

*本文件由渡渡与初尘维护，随工程迭代更新。当前状态：P0 ✅ → P1 ✅ → P2 ✅（代码+烧录）→ P3 服务器侧 G1/G2 ✅（28/28，已部署）→ **P3 续 G3/G7 待做**；部署指南见 `server/DEPLOY.md`，全套文档见 HANDOFF/STATUS/ARCHITECTURE/CHANGELOG/TROUBLESHOOTING/IDEAS。*