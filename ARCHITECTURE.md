# dodo_napcat 架构（ARCHITECTURE）

> 更新：2026-08-16 23:30 ｜ 本文区分**蓝图（原本想做什么）**与**现状（现在是什么）**，避免文档把"计划"当"已实现"。

## 1. 蓝图（原本想做什么）
一个干净的统一包，综合三包之长：
```
统一包 com.operit.napcat_pro
├─ 通道层（Transport 抽象）
│   ├─ RemoteServerTransport【现状】轮询远端桥服务器（universal 已验证通道）
│   └─ DirectWsTransport【预留，未做】market 的 Python ws 桥（本地直连可做空间）
├─ 事件层：OneBot11 → 标准化 {scene,userId,groupId,text,quoteId,atSelf,msgId}
├─ 编排层【灌 qqbot-pro】：G1聚合 → G2上下文(三态+双模式) → AI → G4 chunker
│   ├─ G3 replyTo 协议头（AI 返回编号 → 原生引用）
│   └─ G7 成员映射（knownUsers + NapCat 群昵称）
├─ 规则层【取 universal】：群5/私聊4模式矩阵 + 防抖 + 短上下文 + 绑定双模式
├─ 附加层【取 market】：语音/表情包/QQ空间/撤回/@/输入态/图片
├─ 配置层【对齐 qqbot-pro】：schema + NAPCAT_* env + clamp + 统一 configure
└─ UI 层【两套并存】：compose_dsl + WebView
```

## 2. 现状（2026-08-16 23:30 实际是什么）
### 2.1 运行链路（已通）
```
QQ群/私聊 → NapCat(服务器,ws6098) → dodo_bridge_server.py(服务器,0.0.0.0:8080)
  ├─ 归一化/去重/触发路由(at_only等)/selective预过滤(BUG-01)
  ├─ context_history 短上下文（G2 双模式：count默认 / time=艾特前后N秒）
  ├─ 队列（批量领取 BUG-02 / 管理 BUG-03 / 限流 BUG-04 / stale丢弃 需求15）
  └─ 发送：split_reply_parts 分条 + quote 原生引用 + reply 段
         ▲
         │ /api/pull?count=N → prompt（含上下文/编号聚合）
         └── Operit ToolPkg(com.operit.napcat_pro)：sendMessage(AI) → /api/reply
```
### 2.2 已实现
- 服务器：队列状态机、触发矩阵、selective 预过滤、批量/队列管理/限流/stale、分条+原生引用、**G1 聚合桶（默认关）**、**G2 双模式**、/health、token 鉴权
- Operit：Transport(pull/reply/ignore/requeue/config)、配置 schema+env、fixed/auto 绑定、轮询循环、AI 调用、选择性忽略哨兵、IPC 顶层注册
### 2.3 未实现（蓝图 vs 现状差异）
| 蓝图 | 现状 |
|---|---|
| G3 replyTo 协议头 | 🔴 未做（聚合文本已带 `[#N]` 编号，差 Operit 解析 + 引用映射） |
| G7 成员映射（群昵称） | 🔴 未做（nickname 已透传） |
| DirectWsTransport（本地直连） | 🔴 接口预留，未实现（当前远端） |
| P4 附加层（语音/表情/QQ空间/撤回/@/输入态/图片） | 🔴 未做（NapCat 支持已确认，见 DESIGN §5） |
| UI 两套 | 🔴 未做（P5） |
| TLS/安全组 | ⚠️ 公网明文暴露（token 鉴权在）；建议收紧 8080 源 IP + 后续 TLS |

## 3. 通道层决策
- 当前 **RemoteServerTransport**（universal 已验证通道），服务器侧干净重写。
- **DirectWsTransport**（market 的 Python ws 桥）留作本地直连预留位，当前 NapCat 在远端所以不实现。

## 4. 关键接口契约
- `GET /health`（无鉴权）｜`GET /api/config` `GET /api/pull?count=N` `GET /api/queue/stats`（鉴权）｜`POST /api/config /api/reply /api/ignore /api/requeue /api/queue/clear /api/context/clear`（鉴权，`X-Bridge-Token`）
- prompt 头：`[QQ_BRIDGE_MESSAGE_ID:{id}]`；忽略哨兵 `[[QQ_BRIDGE_IGNORE]]`
- Operit AI 调用：`Tools.Chat.sendMessage(prompt, chatId, cardId, "QQ桥接", {persist_turn:true, hide_user_message:true, timeout_ms})`

## 5. 平台边界
- NapCat 支持：text/at/reply/image/record/video/file/json/music/forward/poke 段；delete_msg/set_input_status/get_group_member_info/get_cookies 等
- 不支持：标准 markdown 段、keyboard 段 → 对应功能**不做**