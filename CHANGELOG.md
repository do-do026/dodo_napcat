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

### v0.8 P3 联调修复（2026-08-17 01:00~01:55，真机实测）
- **Tools.Chat 用 sendMessage + senderName**（chat_with_agent 实测路径）——原 sendMessage/sendMessageStreaming 触发 `Service not connected`（Operit ChatService ensureServiceConnected 间歇性绑定失败，反编译 APK 实证）
- **findChatById 改 listChats 遍历匹配**——原 findChat 匹配不上绑定对话 → 乱开新对话
- **配置权威化**：env_preferences.xml 会被 Operit 内存缓存覆盖/读不到 → 弃用 env，config.json 为唯一权威（真实值全部写入）
- **@/关键词主动召唤必回**：selection_required 只在 scope=all（批量观察轮）为 True；trigger 聚合必回不忽略（修 AI 大量 [[QQ_BRIDGE_IGNORE]]）
- 复读抑制引用、waifu 3句分条（私/群均3）保持
- 测试 52/52 全绿；服务器已部署 + 队列清空

## 2026-08-17（运维 + 对齐 + 守护）
### v0.9 重启重登 + 服务器守护 + 默认值对齐（02:35~02:50）
- **QQ/NapCat 重启重登**：`sudo systemctl restart qq-napcat`（新 PID），NapCat **快速登录自动成功**，无需扫码（二维码仍为旧文件）
- **确认无独立"自动重登"脚本**：自动重启靠 `qq-napcat.service`（Restart=always）+ `cleanup_xvfb.sh` 每小时；NapCat 快速登录在会话有效期内自动登，过期需人工扫码
- **新增服务器守护** `server/dodo_bridge_watchdog.sh`（nohup 保活 + 登录守卫 + 心跳日志），cron：每 10 分钟跑 + 每周一 04:30 周期重登
- **新增子包 `napcat_pro_server`**（6 工具：install/run_watchdog/watchdog_status/relogin_qq/fetch_qrcode/server_status），SSH 配置读 `plugins/com.operit.napcat_pro/server.json`
- **需求14 更新**：群默认 `keyword_or_at`（回艾特+关键词，关键词 UI 可调）——README/STATUS/DESIGN/服务器默认值/manifest/子包 METADATA/UI 全部对齐；`start()` 不再覆盖 UI 已设模式，仅在服务器模式为 off/未配置时同步默认
- **UI 对齐**：设置页默认群模式改 keyword_or_at；刷新时从服务器回读 group_reply_mode/keywords（status 新增 server_rules）
- **main.js 修复**：start() 补 fixed 绑定校验（对齐文档）；`lastReplyAt` 开始赋值；计数变化触发持久化；每轮处理加 `[napcat_pro] round ... -> IGNORED/REPLY` 日志（可观测）
- 诊断确认（T014）：消息"没落进对话"的双路径——① Operit 暂停轮询期间，服务器 stale 丢弃 5 分钟前 pending（日志实证最多一次丢 35 条）；② 到 AI 的消息因 `hide_user_message=true` 在绑定对话里不可见、ignore 不留痕 → 看起来"没进来/没 ignore"
- **stale 保留最近一条（需求，04:20）**：`clean_stale_queue()` 改为每会话保留最近一条未处理 pending（`NAPCAT_KEEP_NEWEST_STALE=true`），该条在领取时补拉最近 10 条上下文（`snapshot_context(limit_hint=10)`）——断连恢复后不再把最新回复消息也丢光
- **"开了又断"根因确认**：04:10 日志 `application_on_create` + auto-start 拉起 → Operit 应用进程被系统回收/重启（03:20~04:10 约 50 分钟无拉取），消费端存活完全依赖 Operit 进程（T009 平台限制）；auto-start hook 生效时可自动恢复
- **群聊"艾特全 ignore"根因确认（T016）**：读绑定对话 `2f928270` 实锤——①`owner_always_reply=true` 把主人**每句群聊**（非仅艾特）都强制送进 AI（队列全 `trig=owner`）；②AI 从历史学会输出 `[[QQ_BRIDGE_IGNORE]]`（一条思考原文："不涉及渡渡，不需要插话。忽略"）；③每条触发都带 10 行群聊上下文，AI 见群聊墙更倾向忽略。三者叠加=艾特不回
- **修复（需求，04:30~04:55 定稿）**：①`owner_always_reply` 只保证私聊必回，群聊跟群模式走（仅艾特/关键词触发）；②群触发（@/关键词）**带上下文+必回**（`NAPCAT_GROUP_IMMEDIATE_CONTEXT=0`=标准10条，`<0`才关）；③**ignore 范围由代码划界**（selection_required 只在「选择性观察的非触发候选」为 True；触发无论 scope 必回），prompt 恢复简洁（不再"禁止这个禁止那个"）；④stale 保留的最近一条领取时补拉 10 条上下文
- 按群绑定对话（需求，04:50）**：新增 `groupChatBindings {群ID: chatId}`（优先级>fixedChatId）；群 <群ID> → b547763e「渡渡&初尘」新对话；旧对话 2f928270 已删、fixedChatId 已更新；主人私聊仍走 f128b2c7
- **env 化昵称/提示词（需求，19:2x）**：`NAPCAT_KNOWN_USERS`（主人QQ昵称等别名，走 env 不入库，代码真正读 env 兜底）、`NAPCAT_BOT_NAME`（AI被叫名字/QQ昵称，艾特渲染成 `@渡渡` 让 AI 明确知道在跟它说话，触发轮加"本条消息艾特了你"提示）、`NAPCAT_BRIDGE_PROMPT`（桥接提示词，UI/agent 可改，默认兜底"被触发=直接跟你说话请回应"）——三者均 env 默认 + config 可覆盖，UI 设置页已加对应输入框
- 新 toolpkg 已重建（含 5 文件 19KB）至 packages 目录，**需重启 Operit 生效**

### 事故/教训
- 测试会话 flash 绑到活跃大群并回复，初尘在群里受罪 → **铁律：测试前先问初尘（对话/群/开关）**
- 服务器 LISTEN_HOST 被改成 0.0.0.0（必要但未先问）→ 公网暴露注意安全组/TLS