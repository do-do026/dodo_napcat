# dodo_napcat 冷启动接续文档（HANDOFF）

> 新窗口接续本工程的**唯一入口**。读完本文件 + 三个链接即可独立工作，无需初尘转述。
> 更新时间：2026-08-16 23:30 ｜ 维护：渡渡 & 初尘

## 0. 三十秒速览
- **做什么**：干净的 NapCat→Operit→QQ 桥（统一增强版），包 `com.operit.napcat_pro`（显示名「渡渡 NapCat」）。
- **进度**：P0 ✅ P1 ✅ P2 ✅（真机验证通过）P3 ✅（G1聚合/G2上下文/G3 replyTo/G7成员映射/ignore代码划界）→ **v0.9.1/v0.9.2 已发 Release（GitHub）** → P4 附加层 → P5 UI+安全。
- **必须读**：`STATUS.md`（当前状态）→ `ARCHITECTURE.md`（架构）→ `DESIGN.md`（需求/决策）→ `TROUBLESHOOTING.md`（坑）→ `IDEAS.md`（待办/灵感/URL）。
- **铁律**：自动回复代码默认关（当前已开）；新功能测试前**必须问初尘**：绑哪个对话 / 哪个群 / 开不开；新工具当前会话不可见需新开会话。

## 1. 当前部署拓扑
```
远端服务器 <你的服务器地址>（腾讯云轻量，lighthouse，密码记忆库有）
├─ systemd: qq-napcat        → QQ 渡渡 <机器人QQ号> + NapCat（ws6098 / webui6099）
├─ 脚本/进程: dodo_bridge_server.py（~/dodo_napcat/server/，run_dodo_bridge.sh 启停）
│   └─ 监听 0.0.0.0:8080（HTTP，BRIDGE_TOKEN 鉴权；旧 qq-bridge-universal 已停并 disable）
└─ 数据：~/.dodo_napcat/{queue,context,reply_config}.json

Operit（一加手机）
└─ ToolPkg com.operit.napcat_pro（dev_package/ 开发，已烧录）
   └─ 配置 /sdcard/Download/Operit/plugins/com.operit.napcat_pro/config.json
      （当前绑定：fixedChatId=b547763e「渡渡&初尘」，groupChatBindings{<群ID>: b547763e}，主人私聊 f128b2c7，角色卡渡渡，enabled=true）
```

## 2. 关键命令/路径
| 项 | 值 |
|---|---|
| SSH | `sshpass -e ssh lighthouse@<你的服务器地址>`（密码在记忆库「凭证」） |
| 服务器桥启停 | `cd ~/dodo_napcat/server && bash run_dodo_bridge.sh start\|stop\|restart\|status` |
| 服务器健康 | `curl http://127.0.0.1:8080/health` |
| 队列 | `/api/queue/stats` `/api/queue/clear`（带 `X-Bridge-Token`） |
| 拉/回 | `/api/pull?count=N` `/api/reply{id,reply}` `/api/ignore{id}` |
| 本地代码 | `server/dodo_bridge_server.py` + `server/test_server.py`（28 测试） |
| Operit 包开发 | `/sdcard/Download/Operit/dev_package/com.operit.napcat_pro/`（改 dist/ 后 `operit_editor:debug_install_toolpkg` 烧录） |
| Operit 包配置 | `/sdcard/Download/Operit/plugins/com.operit.napcat_pro/config.json` |

## 3. 环境变量/密钥（勿外泄）
- `BRIDGE_TOKEN`（Operit↔服务器桥鉴权，沿用旧值）/ `NAPCAT_WS_TOKEN`（NapCat ws）：**实际值仅存于记忆库 + 服务器 `.env`，勿提交仓库**
- 服务器 run_dodo_bridge.env：`LISTEN_HOST=0.0.0.0`（必须，否则手机连不上）、`STALE_MSG_TTL_SECONDS=300`
- Operit 侧 `NAPCAT_*` env 为**可选覆盖**，默认走 config.json，不用填

## 4. 工作流（每阶段）
改代码 → 本地测试（py/node check）→ 服务器侧 scp+restart / Operit 侧 debug_install_toolpkg → **先问初尘再开** → 测试 → 推 GitHub（工作流约定：测完每阶段推一次）。

## 5. 已知坑（详见 TROUBLESHOOTING）
- 新 ToolPkg 工具当前会话不可见 → 新开会话
- ToolPkg IPC 必须在 main.js **模块顶层**注册（不能只放 registerToolPkg/onApplicationCreate）
- 改 config.json 后 Operit 侧有缓存，需重载包/重启才生效
- 服务器 HTTP 公网暴露：token 鉴权在，但建议安全组收紧 + 后续 TLS（BUG-05）
- Tailscale 模块被 KernelSU 禁用 → 软件打不开（当前无害，见记忆库）