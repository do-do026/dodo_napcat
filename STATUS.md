# dodo_napcat 项目状态（STATUS）

> 更新：2026-08-17 19:00 ｜ 状态口径：🟢已验证 / 🟡已实现待验证 / 🔴未实现 / ⚪平台或设计限制

## 1. 能力验收矩阵
| 能力 | 代码 | 部署 | 真机 | 备注 |
|---|---|---|---|---|
| 服务器桥 dodo_bridge_server.py | ✅ | ✅ | ✅ | <你的服务器地址>:8080，ws_connected |
| 传输层：收→队列→pull→发→**原生引用** | ✅ | ✅ | ✅ | 08-16 群内初尘亲测引用回复成功 |
| at_only / keyword_or_at 群模式 | ✅ | ✅ | ✅ | 默认 keyword_or_at（回艾特+关键词，UI可调） |
| 丢 N 分钟前内容（stale） | ✅ | ✅ | ✅ | STALE_MSG_TTL_SECONDS=300 + **每会话保留最近一条**（NAPCAT_KEEP_NEWEST_STALE） |
| 批量领取（BUG-02） | ✅ | ✅ | — | /api/pull?count=N |
| 队列管理（BUG-03） | ✅ | ✅ | — | /api/queue/clear+stats |
| 会话限流+队列上限（BUG-04） | ✅ | ✅ | — | |
| P2 Operit 消费端（com.operit.napcat_pro） | ✅ | ✅烧录 | ✅ | 真机验证通过（@必回/ignore代码划界/按群绑定/每轮日志） |
| 对话绑定 fixed/auto/按群 | ✅ | ✅ | ✅ | groupChatBindings {群ID:chatId} > fixedChatId；主人私聊走 privateOwnerChatId |
| 选择性忽略哨兵 | ✅ | — | — | [[QQ_BRIDGE_IGNORE]] |
| **G1 群聚合桶**（P3） | ✅ | ✅ | ✅ | 当前开（group_aggregate_window_ms=5000，触发聚合） |
| **G2 上下文双模式** time/count（P3） | ✅ | ✅ | — | 默认 count（需求16/17） |
| **G3 replyTo 协议头**（P3） | ✅ | ✅ | — | `[replyTo:N]`/JSON→原生引用编号消息（聚合轮） |
| **G7 成员别名映射**（P3） | ✅ | ✅ | — | known_users，需求18：<主人QQ号>→苜蓿 已配 |
| **需求19 批量观察轮**（P3） | ✅ | ✅ | — | keyword_or_at+5秒防抖聚合+复读检测+AI选择性回复；scope=all 可切20秒批量 |
| G4 chunker（按句号分条） | ✅ | ✅ | ✅ | 服务器 split_reply_parts |
| 语音 / 表情包 / QQ空间 / 撤回 / @ / 输入态 / 图片 | 🔴 | — | — | P4 |
| UI 两套（compose_dsl+WebView） | 🔴 | — | — | P5 |

## 2. 当前运行状态（2026-08-17 19:00）
- 服务器桥：running（ws_connected=true），0.0.0.0:8080
- 自动回复：**开**（Operit config enabled=true）
- 群模式：keyword_or_at（回艾特+关键词，关键词可在 UI 调）｜ 上下文：count 模式 ｜ 聚合：开（group_aggregate_window_ms=5000）
- **ignore 范围代码划界**：selection_required 只在批量观察(scope=all)非触发候选为 True；@/关键词/主人触发必回（Operit 拦下哨兵兜底回复）
- 绑定：fixedChatId=b547763e「渡渡&初尘」；groupChatBindings{<群ID>: b547763e}；主人私聊 f128b2c7；角色卡渡渡
- 服务器守护：dodo_bridge_watchdog.sh（cron 每10分钟保活 + 每周一04:30周期重登）
- 队列：空（正常）

## 3. 需求清单（详见 DESIGN.md §2.2，13~17）
13 默认不自动开 ✅ ｜ 14 群默认 keyword_or_at（回艾特+关键词，UI可调）✅ ｜ 15 丢 N 分钟前内容 ✅ ｜ 16 at_only 读艾特前后 N 秒（time 模式 ✅）｜ 17 上下文双模式 time/count ✅（G2）

## 4. 下一步
1. **受控测试**（先问初尘：对话/群/开关）→ 验证 P2 消费端 + 群 at_only 闭环
2. 推 GitHub 仓库（工作流：测完推）
3. **P3 续**：G3 replyTo（AI 返回 `[#N]` 编号→原生引用）+ G7 成员映射（群昵称）
4. **P4**：语音（record 段）/ 表情包 / QQ空间 / 撤回 / @ / 输入态 / 图片
5. **P5**：UI 两套 + 留档 + 安全（TLS/安全组）

## 5. 技术债
- 服务器 HTTP 公网明文暴露（BUG-05）：token 鉴权在；建议安全组收紧（出口 IP 111.60.84.160）+ 后续 TLS/CF Tunnel
- Operit 侧 config 有缓存，改 config.json 需重载包
- 聚合桶为内存态，重启丢失未 flush 桶
- P2 消费端串行（concurrency=1）；批量已支持，并发可后续开
- `qqbot_pro_v030.toolpkg` 是 08-07 旧快照（缺 G3-G6），勿误烧