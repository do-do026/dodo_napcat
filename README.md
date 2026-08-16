# dodo_napcat — 渡渡的 NapCat QQ 桥（统一增强版）

> 给「渡渡」做的干净 NapCat → Operit → QQ 桥。综合了 qqbot-pro（AI 编排）/ napcat_bridge_ui_market（语音/表情/QQ空间）/ qq_bridge_universal（规则矩阵/服务器桥）三家之长，干净重写。
> 工程目录：`/sdcard/Download/dodo_napcat/` ｜ 包：`com.operit.napcat_pro`（显示名「渡渡 NapCat」）

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
- 自动回复**默认关闭**（`enabled=false`），群模式默认 **at_only**；测试前先问初尘：绑哪个对话 / 哪个群 / 开不开。
- 服务器 `BRIDGE_TOKEN` / `NAPCAT_WS_TOKEN` 走服务器 `.env`（实际值见记忆库+服务器，**勿提交仓库**）；QQ=<机器人QQ号>。
- 新 ToolPkg 工具**当前会话不可见，需新开会话**才能调用（Operit 机制）。