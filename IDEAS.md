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
- [ ] 受控测试 P2 消费端 + 群 at_only 闭环（先问初尘：对话/群/开关）
- [ ] 推 GitHub 仓库（do-do026 下，REST API 上传，勿 git push——smart HTTP 被墙）
- [ ] P3 续：G3 replyTo + G7 成员映射 + Operit 侧配合
- [ ] P4 附加层：语音 / 表情包 / QQ空间 / 撤回 / @ / 输入态 / 图片
- [ ] P5：UI 两套 + README/ARCHITECTURE/STATUS/HANDOFF 终稿 + GitHub Release
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