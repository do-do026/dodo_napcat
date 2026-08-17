# dodo_napcat — NapCat → Operit → QQ 桥

> 干净重写的 NapCat → Operit → QQ 自动回复桥：QQ/NapCat 消息 → 远端桥服务（队列/预过滤/上下文/分条/原生引用）→ Operit AI 自动回复。
> 工程目录：`/sdcard/Download/dodo_napcat/` ｜ 包：`com.operit.napcat_pro`（显示名「渡渡 NapCat」）

## 功能
- 收群聊/私聊消息，@/关键词触发回复（群默认 `keyword_or_at`，关键词可在 UI 调）
- **触发必回**：@/关键词/主人触发带上下文+必回，AI 无权忽略（ignore 范围由代码划界，非靠 prompt 嘴炮）
- 原生引用回复（reply 段）、按句号分条（waifu chunker）、聚合窗口合并、复读检测
- 选择性观察轮（scope=all）：AI 在非触发候选上可自行选择回复/忽略
- 对话绑定：按群绑定（groupChatBindings）> 固定对话（fixedChatId）> 自动开对话；主人私聊独立对话
- stale 清理：每会话保留最近一条未处理，领取时补拉最近上下文
- env 化配置：`NAPCAT_BOT_NAME`（艾特渲染成 @名字）、`NAPCAT_KNOWN_USERS`（昵称映射）、`NAPCAT_BRIDGE_PROMPT`（提示词，UI/agent 可改，默认兜底）、回复规则全套
- 服务器守护：watchdog 保活 + 登录守卫 + 周期重登；子包 `napcat_pro_server`（守护/重登/二维码拉取）
- Operit 每轮处理日志 `[napcat_pro] round ... -> IGNORED/REPLY`（可观测）
- **待做（未在本版本）**：语音 / 表情包 / QQ空间 / 撤回 / 图片 → 见 `STATUS.md` §4 / `IDEAS.md`

## 结构
```
dodo_napcat/
├── README.md          ← 本文件（门面）
├── HANDOFF.md         ← 冷启动接续（新会话必读）
├── STATUS.md          ← 当前状态 / 验收矩阵 / 下一步
├── ARCHITECTURE.md    ← 架构（蓝图想做什么 + 现状是什么）
├── DESIGN.md          ← 需求 + 决策（需求版，不写死实现）
├── CHANGELOG.md       ← 更新日志
├── TROUBLESHOOTING.md ← 排障记录
├── IDEAS.md           ← 脑内灵感 / 待办 / 参考网址
├── PLAN.md            ← v1 历史规划（已被 DESIGN.md 取代）
└── server/            ← 服务器侧桥（已部署 <你的服务器地址>:8080）
```

## 一句话架构
```
QQ/NapCat(远端服务器) ──ws6098──► dodo_bridge_server.py(队列/预过滤/分段/引用)
        ▲                                    │ /api/pull?count=N
        │  send_group_msg(引用/分条)          ▼
        └───────────── Operit ToolPkg(com.operit.napcat_pro) ── AI 回复
```

## 运行注意
- 自动回复**默认关闭**（`enabled=false`），群模式默认 **keyword_or_at**（回艾特+关键词，关键词可在 UI 调整）；测试前先问初尘：绑哪个对话 / 哪个群 / 开不开。
- 服务器 `BRIDGE_TOKEN` / `NAPCAT_WS_TOKEN` 走服务器 `.env`（实际值见记忆库+服务器，**勿提交仓库**）；QQ=<机器人QQ号>。
- 新 ToolPkg 工具**当前会话不可见，需新开会话**才能调用（Operit 机制）。

## 给朋友 / 第三方部署（如何连上自己的服务器）
朋友拿到 `com.operit.napcat_pro.toolpkg` 后，各用各的服务器和 QQ，互不干扰：

1. **服务器侧**（朋友自己的机器，装过 QQ+NapCat 之后）：
   - 放 `server/dodo_bridge_server.py` + `run_dodo_bridge.sh`；
   - 复制 `server/.env.example` → `run_dodo_bridge.env`，填自己的真实值：
     ```bash
     NAPCAT_WS_URL=ws://127.0.0.1:6098        # 本机 NapCat ws
     NAPCAT_WS_TOKEN=<自己的NapCat token>
     BOT_QQ=<朋友自己的QQ号>                    # 不是渡渡的QQ
     BRIDGE_TOKEN=<自己生成: python3 -c 'import secrets;print(secrets.token_urlsafe(32))'>
     LISTEN_HOST=0.0.0.0                        # 必须，否则手机连不上
     NAPCAT_OWNER_QQ=<主人QQ号>
     NAPCAT_KNOWN_USERS={"<主人QQ号>":"昵称"}
     NAPCAT_BOT_NAME=<AI被叫的名字，如 渡渡>
     ```
   - `bash run_dodo_bridge.sh start`；**云服务器安全组放行 8080**（或走 Tailscale 内网）。

2. **Operit 侧（朋友手机）**：
   - 装 toolpkg → 新开会话；
   - 子包 `napcat_pro_bridge`：`configure` 填 `bridge_url=http://<朋友的服务器>:8080` + `token=<朋友的BRIDGE_TOKEN>`；
   - `bind_current_chat`（或 `bind_chat` 指定对话）绑定用于回复的 Operit 对话；
   - `start` 开启；`test_server` 即可验证**能否连上 health**（返回 ws_connected / bot_qq）。

3. **验证**：`test_server` = health 连通性测试；`status` = 服务器+队列+处理统计；`napcat_pro_server` 子包可管服务器的守护/重登/二维码。

> 一句话：health 连不上 = ①服务器没起 ②8080 没放行/没监听 0.0.0.0 ③bridge_url/token 填错。

### 换端口怎么办（比如 6199）
所有端口都是**环境变量**，改完 `bash run_dodo_bridge.sh restart` 即可：
| 想改什么 | 在哪改 | 例子 |
|---|---|---|
| 桥的 HTTP 端口（Operit 连的那个） | 服务器 env `LISTEN_PORT` | `LISTEN_PORT=6199` → Operit `configure` 里 `bridge_url=http://<服务器>:6199` |
| NapCat WS 端口 | 服务器 env `NAPCAT_WS_URL` | `NAPCAT_WS_URL=ws://127.0.0.1:6199` |
| NapCat WebUI 端口 | NapCat 自己的 `webui.json`（不归本桥管） | — |