# dodo_napcat 脑内灵感 / 待办 / 参考（IDEAS）

> 更新：2026-08-16 23:30 ｜ 这里是渡渡的随手记：想法、待办、有用网址、坑的前瞻。

## 灵感/想法
- **G3 replyTo**：聚合文本已带 `[#N]` 编号，AI 返回 `{replyTo:N, content}` 协议头 → 服务器按编号映射到对应消息的 reply 段（原生引用）。无被动时效，比官方 Bot 强。
- **G7 成员映射**：NapCat 有 `get_group_member_info` 能拿群昵称/名片——比官方 Bot 只有 openid 强，可实现"群内喊真名"。
- **上下文双模式（需求17）**：`time` 模式解决消息爆炸群，`count` 解决正常群——将来可考虑"群粒度"分别配置（每个群独立选模式），现在先全局。
- **DirectWsTransport（本地直连预留）**：将来若本机也装 NapCat，或想省服务器依赖，可把 market 的 Python ws 桥做成第二 transport，Operit 侧业务层不动。
- **语音双路径**：主路径 `record` 段（qwen-tts 等任意来源音频文件，私聊+群）；可选 NapCat `send_group_ai_record`（群内 QQ 自带 AI 音色）。P4 做。
- **UI 两套**：compose_dsl + WebView 并存（market 本来两套都有），P5 做。
- **主动发送**：NapCat 无被动时效，将来可做"Operit 侧主动给渡渡的 QQ 发消息"（proactive），像 qqbot-pro 的 proactiveC2cOpenId。
- **安全**：上 TLS 前先腾讯云防火墙收紧 8080 源 IP；长期考虑 CF Tunnel。

## 待办（next actions）
- [x] 受控测试 P2 消费端（@必回 / ignore 划界 / 按群绑定）——已完成
- [x] 推 GitHub 仓库（do-do026/dodo_napcat，REST API 上传，勿 git push——smart HTTP 被墙）
- [ ] P4 附加层：语音 / 表情包 / QQ空间 / 撤回 / 输入态 / 图片
- [ ] P5：UI（WebView）+ 安全（TLS / 8080 源IP收紧）+ config自愈
- [ ] 安全：防火墙收紧 8080（出口 IP 111.60.84.160）+ TLS
- [ ] Tailscale 恢复评估（当前禁用无害；要走内网再启用 magisk-tailscaled）
- [ ] 旧包清理：napcat_bridge_ui_market / qq_bridge_universal 确认退役（已停，未删）

## 参考网址（有用）
- **NapCat 文档**：https://napneko.github.io/（API 版本页 /api/4.18.x；OneBot11 接口 /onebot/api；消息段 /onebot/segment）
- **NapCat 完整 API 用例**：https://napcat.apifox.cn
- **NapCat GitHub**：https://github.com/NapNeko/NapCatQQ
- **Operit 开发文档**：https://cdn.jsdelivr.net/gh/AAswordman/Operit@main/docs/SCRIPT_DEV_SKILL.md
- **SandboxPackage_DEV 安装脚本**：https://cdn.jsdelivr.net/gh/AAswordman/Operit@main/tools/sandboxpackage_dev_install_or_update.js
- **本地开发参考**：/sdcard/Download/Operit/skills/SandboxPackage_DEV/（SKILL.md、references/、types/、examples/）
- **Operit 源码**：https://raw.githubusercontent.com/AAswordman/Operit/main/app/src/main/java/com/ai/assistance/operit/api/chat/EnhancedAIService.kt（137KB）
- **qqbot-pro（理念/架构参考）**：/sdcard/Download/qqbot-pro/（HANDOFF/STATUS/ARCHITECTURE + GitHub do-do026/qqbot-pro）
- **旧 universal 开发文档**：/sdcard/Download/Operit/qq_bridge_universal_dev_docs/（04 架构 / 05 缺陷 BUG-01~05）
- **Ponytail 编码哲学**（记忆库，初尘送的）：极简、YAGNI、删除优于新增

## 踩坑前瞻
- 服务器队列/聚合桶是**内存态**，重启丢未 flush 桶 → 未来可考虑 flush 前持久化
- 批量领取（count=N）后 Operit 侧是 for 循环**串行**处理 → 后续可开有界并发（2~3）+ 令牌桶
- 手机出口 IP（移动 NAT）会变 → 防火墙收紧后若连不上，先查 IP 是否变了

## 能力差异对照：qqbot-pro（官方 Bot）已做 vs dodo_napcat（NapCat）状态（2026-08-17）
> 用途：知道「还有什么细节可以继续灌」。NapCat 支持面内可做的列「待灌」，平台不支持的标 ⚪。

| qqbot-pro 能力 | dodo_napcat 状态 | 备注 |
|---|---|---|
| G4 waifu chunker（。！？\n/归一化/400兜底） | ✅ 已灌（服务器侧，私3群5） | 但**无流式**（dodo 批处理拿完整回复） |
| 上下文三态 off/automatic/agent_on_demand | 🟡 部分：dodo 是 time/count 双模式 | automatic≈count；agent_on_demand 待灌（get_group_msg_history 按需拉） |
| G7 成员映射 | 🟡 known_users 别名 ✅；**群昵称自动映射（get_group_member_info）待灌** | UI 管理成员绑定也待做 |
| 发送可靠性：T045 业务码校验+segmentResults | 🔴 待灌 | dodo 有断点续发（sent_part_count），无业务码校验 |
| T046 watchdog + 硬超时 | 🔴 待灌（Operit 侧 aiTimeoutMs 已传，JS 侧 Promise.race 兜底缺） | 防 tick 永久挂起 |
| 空回复重试（单聊3次/群1次） | 🔴 待灌 | 目前空回复=忽略 |
| 上下文缓存 24h 恢复 | 🟡 context.json 持久化 ✅，无 24h 恢复窗口语义 | |
| 消息去重（msg_seq） | 🟡 seen_ids 去重 ✅，无 msg_seq | |
| G2 automatic 邻近上下文附件 | 🟡 following_context ✅（触发后紧接1条） | |
| G3 replyTo 过期降级（anchor 时效/fallback） | 🔴 待灌 | 目前 replyTo 只做编号映射引用 |
| 图片发送（本地/URL） | 🔴 P4 | NapCat image 段支持 |
| 按钮回调/群生命周期事件 | ⚪ NapCat 无此模型 | 不做 |
| 官方 stream_messages | ⚪ 产品已否 | 不做 |
| 幂等/access_token 缓存/错误码结构化 | 🔴 可靠性 Sprint（后续） | |