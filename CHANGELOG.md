# dodo_napcat 更新日志（CHANGELOG）

## 2026-08-16（工程首日，密集推进）
### v0.1 需求与决策（18:25~19:36）
- 明确方向：灌 qqbot-pro 能力进 NapCat 包 + 两 NapCat 包择优合并 + 不修老屎写干净新包
- 工程定名 dodo_napcat；决策：NapCat 远端、新建独立包、包名 com.operit.napcat_pro、BRIDGE_TOKEN 走 env 沿用现值、语音 record 段主路径、绑定双模式 fixed/auto、分阶段工作流（烧录→测→推）
- 需求 13~17 落档（默认不自动开 / at_only / 丢N分钟 / 艾特前后N秒 / 上下文双模式）

### v0.2 P1 服务器侧（19:4x~20:1x）
- 干净重写 `server/dodo_bridge_server.py`（~900 行）：队列状态机、触发矩阵、selective 预过滤(BUG-01)、批量领取(BUG-02)、队列管理(BUG-03)、限流+上限(BUG-04)、stale 丢弃、分条+原生引用
- 冒烟测试 18→22 项通过；部署 <你的服务器地址>，旧 universal 桥停用
- **传输层验证**：收（19条进队列）→ pull → reply → **群内原生引用回复成功**（初尘亲测）

### v0.3 P2 Operit 消费端（20:1x~20:3x）
- ToolPkg `com.operit.napcat_pro`：dist/main.js（schema+env+Transport+fixed/auto绑定+轮询+AI+哨兵）+ napcat_pro_bridge 子包（9 工具）
- 烧录成功；修复 **IPC 顶层注册**（原放在生命周期不触发，universal 模式：模块顶层 ToolPkg.ipc.on）

### v0.4 P3 服务器侧 AI 编排（23:0x~23:1x）
- **G1 群聚合桶**：窗口内触发消息合成一轮，聚合文本带 `[#N]` 编号（默认关）
- **G2 上下文双模式**：`count`（最后 N 条，默认）/ `time`（艾特前后 N 秒，需求16/17）
- 测试 28/28 通过并部署

### v0.5 P3 续：G3 replyTo + G7 成员别名映射（23:3x~23:5x）
- **G3 replyTo 协议头**：AI 回复支持 `[replyTo:N]`（前缀行）或 `{"replyTo":N,"content":...}`（JSON）→ 服务器解析并按编号映射到聚合轮中对应消息的 **reply 段原生引用**；越界/无协议头安全回退首条
- **G7 成员别名映射（需求18）**：`known_users`（QQ号→可读昵称），prompt/上下文/聚合文本统一用别名（如 <主人QQ号>→苜蓿），未绑定显示群名片/QQ号
- 测试 39/39 全绿；已部署；`苜蓿` 别名已配到服务器

### v0.6 P3 收尾：批量观察轮（需求19，23:56~00:0x）
- 群回复放开为 **keyword_or_at**（艾特 + 关键词「渡渡」），往前读 10 条上下文（at_context_count=10）
- **5 秒防抖聚合**（group_aggregate_window_ms=5000）：窗口内艾特/关键词触发合并一轮（带编号）
- **复读检测**（repeat_flood_detect）：归一化去重，≥3条且占比≥60% 判定复读 → 代码给 `repeat_flood` 标记 + `suppress_quote`（AI 未显式 [replyTo:N] 时自动引用关闭）→ prompt 引导"只主动回一次不逐条引用"
- **不同内容 → AI 选择性回复**：聚合轮恒 selection_required=True，AI 用 `[replyTo:N]` 精确回应值得回的 / 输出忽略哨兵
- **scope=all 可选**（aggregate_scope）：所有群消息进桶 → 20 秒批量观察轮，AI 选感兴趣的回复或 ignore 全部（回答"能否与选择回复同时开"=能，同一机制）
- 测试 47/47 全绿；已部署+配置生效

### v0.7 P3 收尾：G4 waifu 分句 + 数量参数 env 化（2026-08-17 00:48~00:5x）
- **G4 waifu 分句（移植 qqbot-pro waifu_chunker）**：`。！？\n` 计句、连续换行归一化（只计1句）、400 字符安全兜底；**私聊每 3 句一条、群聊每 5 句一条**（`NAPCAT_PRIVATE_CHUNK_SIZE=3` / `NAPCAT_GROUP_CHUNK_SIZE=5` / `NAPCAT_CHUNK_MAX_CHARS=400`）
- **数量参数全部 env 化 + 默认兜底**（优先级：/api/config 运行时 > config.json > env 默认 > 硬编码）：上下文条数/时间窗/防抖/聚合窗/分条延迟/分句数/复读开关等 20+ 项全部可 env
- 测试 52/52 全绿

### ⚠️ 教训：公开仓库隐私泄漏（2026-08-17 00:1x）
- 首次推 `do-do026/dodo_napcat` 公开仓库时，文档里带了**服务器地址 <服务器IP>**（README/HANDOFF/DESIGN/STATUS/CHANGELOG/DEPLOY 共 6 处），初尘及时发现要求清理
- 已全部清理：服务器地址→`<你的服务器地址>`、BRIDGE/WS token→占位符、**QQ号**（渡渡小号/初尘）→占位符（文档）/假号（测试代码）；上传脚本内置泄漏黑名单（命中即跳过）
- **铁律：公开仓库里永远不放**：服务器 IP、token、密码、QQ号、任何真实凭证；`.env.example` 只用占位符；本地真实值只存记忆库 + 服务器 `.env`

### 事故/教训
- 测试会话 flash 绑到活跃大群并回复，初尘在群里受罪 → **铁律：测试前先问初尘（对话/群/开关）**
- 服务器 LISTEN_HOST 被改成 0.0.0.0（必要但未先问）→ 公网暴露注意安全组/TLS