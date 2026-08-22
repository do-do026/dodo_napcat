# dodo_napcat 排障记录（TROUBLESHOOTING）

> 新坑先查这里，避免重复踩。每条：现象 → 根因 → 解法。

## T001 新 ToolPkg 工具当前会话不可见（Tool not found）
- 现象：烧录后 `package_proxy` 调 `napcat_pro_bridge:xxx` 报 "Tool not found"；`use_package("napcat_pro_bridge")` 报 not found。
- 根因：Operit 机制——新工具注册后**当前会话工具索引不可见**，需新开会话（qqbot-pro 同样踩过）。
- 解法：**新开会话**后调用；用户开子包开关是对的操作，但当前会话仍看不到。

## T002 ToolPkg IPC channel not registered
- 现象：工具能调到（如 test_server），但报 "ToolPkg.ipc channel is not registered: napcat_pro.bridge.test_server"。
- 根因：`main.js` 把 `registerIpc()` 放在 registerToolPkg / onApplicationCreate 里，未触发。
- 解法：**在模块顶层直接执行** `loadState(); loadConfig(); registerIpc();`（universal 同款：顶层 `ToolPkg.ipc.on(...)`）。已修复烧录。

## T003 改 config.json 不生效
- 现象：改 Operit 侧 config.json 后行为没变。
- 根因：main.js 的 `getConfig()` 用内存缓存 `cache`，只在模块加载时 loadConfig。
- 解法：改完需**重载包 / 重启 Operit** 才生效；或通过 configure 工具写（走 saveConfig 会刷新 cache）。

## T004 服务器 HTTP 公网暴露（0.0.0.0:8080）
- 现象：服务器桥监听 0.0.0.0（手机要连），HTTP 明文暴露公网。
- 根因：LISTEN_HOST=0.0.0.0（必要，否则一加连不上；旧 universal 同样如此）。风险：无 TLS、/health 无鉴权。
- 现状：`/api/*` 全部校验 BRIDGE_TOKEN（32字节随机），非裸奔。
- 解法：①腾讯云轻量防火墙收紧 8080 源 IP（手机出口 IP 111.60.84.160，会变需关注）②后续上 TLS/CF Tunnel（BUG-05）。

## T005 测试事故：flash 绑活跃大群乱回复
- 现象：测试会话把桥绑到活跃大群（<群ID>），自动回复处理群消息，flash 以"渡渡"身份回了不该回的，初尘群里受罪。
- 根因：测试没对齐场景（绑了活跃大群、没先确认开关）。
- 解法：**铁律——新功能测试前先问初尘**：绑哪个对话 / 哪个群 / 开不开自动回复。（当时自动回复已关、群 at_only；2026-08-17 已开启 keyword_or_at 并完成受控测试。）

## T006 Tailscale 软件打不开（magisk-tailscaled 被 KernelSU 禁用）
- 详见记忆库「排查：Tailscale软件打不开…」。当前无害（网络正常，桥接走公网），保持禁用；恢复时启用 magisk-tailscaled 模块。

## T007 server 侧引用（quote）验证
- 现象/确认：08-16 传输层测试时，群内回复带原生引用（reply 段）成功——NapCat 引用无被动时效、原生渲染，是优势。

## T008 旧包/旧快照混淆
- `qqbot_pro_v030.toolpkg` 是 08-07 旧快照（缺 G3-G6），勿误烧。
- 旧 `napcat_operit_bridge.py`（qq-bridge-universal 服务器桥）已停 + systemd disable；数据在 ~/.qq_bridge_universal/，可回滚。

## T009 Operit 重启后桥循环不自动恢复（qqbot-pro 同款坑）
- 现象：Operit 重启/烧录后，消费端轮询没跑（state.json 不存在、服务器队列 pending 堆积）；日志无 `[napcat_pro]` 标记。
- 根因：T029（宿主 registration session 未激活 → registerToolPkg/hooks 不触发）+ T044（烧录重置 JS 运行时，内存 timer 丢失）。
- 解法：①包侧已照抄 qqbot-pro 正确姿势（create+foreground 双 auto-start hook + 顶层 module loaded 日志）②宿主坑不可全依赖 → 保留 UI「开启桥接(start)」「立即处理一批(run_once)」手动兜底 ③烧录后必须重启 Operit / 手动 start 验证。
- 验证：重启后看 packageLogs 有无 `[napcat_pro] module loaded`；有则桥应自动跑，没有则手动 start（新会话调工具或 UI）。

## T010 烧录 SOP（对齐 qqbot-pro T044）
- 每次 `debug_install_toolpkg` 后：JS 运行时重建、timer 丢失 → 必须**重启 Operit** 或手动 `start`，并确认服务器队列开始被消费（pending 下降）。
- 顺带确认包 enabled=true + 子包 napcat_pro_bridge 已激活。

## T011 Tools.Chat 报 "Service not connected"（ChatService 间歇性断）
- 现象：桥 pull 正常、AI 调用偶尔成功偶尔 `Service not connected`；readMessages/chat_with_agent 能用但桥调用失败。
- 根因（反编译 Operit APK）：`StandardChatManagerTool` 的 createNew/send 等写操作要 `ensureServiceConnected(intent)` **bind Android ChatService**，连不上就抛该错；读操作（readMessages/findChat）不依赖。
- 解法：①改用 `Tools.Chat.sendMessage(message, chatId, cardId, senderName, options)`（chat_with_agent/extended_chat 实测路径，第4参传角色名如"渡渡"）②`withChatRetry` 对 Service not connected 自动重试 2 次。
- 关联：env 直改不可靠（见 T012）。

## T012 env_preferences.xml 直改不生效/被覆盖
- 现象：直接把 NAPCAT_* 写进 env_preferences.xml，重启后"变量没了"；config.json 的 bridgeUrl 等被清空。
- 根因：Operit 用 SharedPreferences **内存缓存**读 env；直接改文件要么读不到（getEnv 走内存）、要么重启时被内存旧值覆盖回写。config.json 被 UI/工具保存空值覆盖同理。
- 解法：**弃用 env 路线，config.json 为唯一权威**（真实值写进 /sdcard/Download/Operit/plugins/com.operit.napcat_pro/config.json）；改配置用 UI 或 configure 工具，勿手改 env 文件。

## T013 @渡渡不回（AI 大量 [[QQ_BRIDGE_IGNORE]]）
- 现象：群 @/关键词触发，AI 全选择忽略，用户等不到回复。
- 根因：聚合轮 selection_required 恒为 True → AI 把主动召唤当"可选忽略"。
- 解法：selection_required 只在 `aggregate_scope=all`（批量观察轮）为 True；trigger（@/关键词）必回不忽略（v0.8）。

## T014 消息"没落进绑定对话/AI 没发 ignore"（2026-08-17 确认）
- 现象：用户在另一个窗口看到桥报 AI ignore，但绑定的 Operit 对话里既没消息也没 ignore 痕迹，上下文也没落进去，怀疑消息根本没被接进 Operit。
- 根因（两条路径叠加）：
  1. **stale 静默丢弃**：Operit 消费端暂停轮询（应用挂起/重启未自动恢复，见 T009）期间，服务器 pending 消息堆积，下次 pull 时 `clean_stale_queue()` 把超过 5 分钟（STALE_MSG_TTL_SECONDS=300）的 pending 直接丢弃。日志实证：一次最多丢 35 条（23:10/23:40/23:58/00:51…）。这类消息**从未到 AI**，无任何记录。
  2. **hide_user_message=true + ignore 不留痕**：被 AI 处理的轮次里，QQ 消息以隐藏形式喂给 AI，绑定对话 UI 里看不到；AI 输出哨兵时只调 /api/ignore 标记，不写任何可见消息 → 看起来"没进来、没 ignore"。
- 解法：
  - ① 保 Operit 轮询：确认 auto-start hook 生效（重启后看 packageLogs 有 `[napcat_pro] auto-start loop`），必要时手动 start；这是 T009 同款，无法完全依赖宿主。
  - ② 可观测：v0.9 起每轮处理写日志 `[napcat_pro] round ... -> IGNORED/REPLY`，重载后可精确区分"到了 AI 被 ignore"与"根本没被拉取（stale 丢）"。
  - ③ 若要不丢：调大 STALE_MSG_TTL_SECONDS 或把消费端做成常驻保活（当前依赖 Operit 前台/生命周期，平台限制）。
  - ④ v0.9+：stale 清理**每会话保留最近一条未处理**（`NAPCAT_KEEP_NEWEST_STALE=true`），领取时补拉最近 10 条上下文——断连恢复后最新回复消息不会丢光。

## T015 桥接"开了又断"（Operit 进程被系统回收/重启，2026-08-17 确认）
- 现象：用户没手动停，桥接轮询却停了；过一会儿又自己恢复（或需手动 start）。
- 根因：Operit 应用进程被 Android 系统回收/杀后台（03:20~04:10 无任何 pull，04:10 日志 `application_on_create` 应用重建 + auto-start 拉起）。消费端 JS 轮询完全依赖 Operit 进程存活——T009 同源平台限制，非代码 bug。
- 解法：
  - ① 手机侧：给 Operit 加系统白名单/电池无限制，避免后台被杀（治本）。
  - ② 兜底：auto-start hook（create+foreground）已启用，应用重建/回前台会自动拉起轮询；确认 packageLogs 有 `[napcat_pro] auto-start loop`。
  - ③ 断连期间消息：靠 T014④ 的 stale 保留最近一条 + 10 条上下文补救。

## T016 群聊"艾特全 ignore / 群聊不回"（2026-08-17 根因+修复）
- 现象：群里怎么艾特都不回；插件显示处理了一条但没回复；绑定对话里消息进来了、AI 却全回 `[[QQ_BRIDGE_IGNORE]]`。
- 实锤（读绑定对话 2f928270 + 队列）：
  1. `owner_always_reply=true` → 主人**每句群聊**都被强制送进 AI（队列全 `trig=owner`），不是只有艾特/关键词才触发；
  2. AI 从历史里学会主动输出忽略哨兵（一条思考原文："不涉及渡渡，不需要插话。忽略"）——历史里塞满了旧的 `[[QQ_BRIDGE_IGNORE]]` 示例；
  3. 每条触发都带 10 行群聊上下文，AI 见整墙别人聊天更倾向判断"不关我事"而忽略。
- 修复（v0.9，04:55 定稿）：
  1. `owner_always_reply` 只保证**私聊**必回；群聊跟群模式走（仅艾特/关键词触发）；
  2. 群**触发**（@/关键词）**带上下文**（`NAPCAT_GROUP_IMMEDIATE_CONTEXT=0`=标准10条，`<0`才关上下文）；
  3. **ignore 正常忽略**：AI 输出哨兵/空内容即忽略（**不再补"我在。"**）——触发也尊重 AI 决定，不硬凑回复；prompt 保持简洁；
  4. stale 保留的最近一条领取时仍补拉 10 条上下文（恢复场景需要语境）。
  5. **引用回复只在 Gateway 刚开启、回历史消息时用**（`quote_catch_up_only`，2026-08-22）；平时不再引用。
- 主人映射：`owner_qq=<主人QQ号>` + `known_users={"<主人QQ号>":"苜蓿"}`（已补写进服务器 env：NAPCAT_OWNER_QQ/NAPCAT_OWNER_ALWAYS_REPLY/NAPCAT_KNOWN_USERS）。
- 按群绑定：新增 `groupChatBindings {群ID: chatId}`（>fixedChatId）；群 <群ID> → b547763e「渡渡&初尘」（旧 2f928270 已删，fixedChatId 已更新；主人私聊走 f128b2c7）。
- 验证：服务器已部署生效（health: imm_ctx=0、scope=trigger、mode=keyword_or_at）；新 QQ 艾特/关键词消息应直接回复到 b547763e。

## T017 关了但没真关（enabled=false 不生效，2026-08-18 修复）
- 现象：用户在 Operit 插件管理关了桥接（config.json enabled=false），但 QQ 私聊仍在自动回复。state.json running=true 残留，failedCount=85。
- 根因（4 处叠加）：
  1. `loop()` 的 while 条件用 `getConfig().enabled` 只读内存缓存，外部改 config.json 不生效 → 循环不知道 enabled 变了
  2. `loadState()` 用 `Object.assign(state, saved)` 盲目恢复 `running=true`，进程重启后循环实际不在跑但状态显示在跑
  3. `handleConfigure()` 设 enabled=false 时没调 `stopLoop()` → UI/工具关闭只改文件不停循环
  4. `handleStop()` 不清服务器队列 → 关闭后积压消息在重开时涌入
- 修复（v0.9.3）：
  1. loop 每轮迭代前 `loadConfig()` 重读文件，外部改 enabled 在 3 秒内生效
  2. loadState 只恢复计数器/时间戳/binding，强制 `running=false, processing=false`
  3. handleConfigure 检测 `prev.enabled && !next.enabled` 主动 `stopLoop()`
  4. handleStop 新增 `POST /api/queue/clear` 清队列
- 教训：**轮询循环的退出条件不能只依赖内存缓存**，必须每轮重读持久化配置；**进程重启后 running 状态不可信**，必须强制重置。