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
- 现象：测试会话把桥绑到活跃大群（1084291415），自动回复处理群消息，flash 以"渡渡"身份回了不该回的，初尘群里受罪。
- 根因：测试没对齐场景（绑了活跃大群、没先确认开关）。
- 解法：**铁律——测试前先问初尘**：绑哪个对话 / 哪个群 / 开不开自动回复。当前自动回复已关（enabled=false），群 at_only。

## T006 Tailscale 软件打不开（magisk-tailscaled 被 KernelSU 禁用）
- 详见记忆库「排查：Tailscale软件打不开…」。当前无害（网络正常，桥接走公网），保持禁用；恢复时启用 magisk-tailscaled 模块。

## T007 server 侧引用（quote）验证
- 现象/确认：08-16 传输层测试时，群内回复带原生引用（reply 段）成功——NapCat 引用无被动时效、原生渲染，是优势。

## T008 旧包/旧快照混淆
- `qqbot_pro_v030.toolpkg` 是 08-07 旧快照（缺 G3-G6），勿误烧。
- 旧 `napcat_operit_bridge.py`（qq-bridge-universal 服务器桥）已停 + systemd disable；数据在 ~/.qq_bridge_universal/，可回滚。