# dodo_napcat · P1 服务器侧桥部署指南

> 目标：把干净版 `dodo_bridge_server.py` 部署到远端服务器 101.43.38.124，验证 `/health`。
> 前置：NapCat 已在服务器本地运行（ws://127.0.0.1:6098，token `<ws-token>`），QQ=810429614。

## 1. 本地自测（已完成 ✅）

```bash
cd /sdcard/Download/dodo_napcat/server
python3 -m py_compile dodo_bridge_server.py   # 语法
python3 test_server.py                        # 冒烟 18/18
```

## 2. 上传到服务器

```bash
# 在服务器上建目录
ssh lighthouse@101.43.38.124 'mkdir -p ~/dodo_napcat/server'

# 从本机上传（3 个文件 + env）
scp dodo_bridge_server.py lighthouse@101.43.38.124:~/dodo_napcat/server/
scp run_dodo_bridge.sh  lighthouse@101.43.38.124:~/dodo_napcat/server/
scp .env.example        lighthouse@101.43.38.124:~/dodo_napcat/server/
```

## 3. 服务器侧配置

```bash
cd ~/dodo_napcat/server
cp .env.example run_dodo_bridge.env
# 编辑 run_dodo_bridge.env 确认：
#   NAPCAT_WS_URL=ws://127.0.0.1:6098
#   NAPCAT_WS_TOKEN=<your-ws-token>
#   BOT_QQ=810429614
#   BRIDGE_TOKEN=<your-bridge-token>（沿用现值，勿提交真实值）
#   LISTEN_HOST=127.0.0.1  LISTEN_PORT=8080
```

## 4. 启动（方式 A：脚本）

```bash
chmod +x run_dodo_bridge.sh
bash run_dodo_bridge.sh start
bash run_dodo_bridge.sh status   # 应返回 /health JSON
```

## 5. 启动（方式 B：systemd，推荐长期跑）

```bash
# 先停脚本方式，再装 systemd
sudo cp dodo-bridge.service /etc/systemd/system/dodo-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now dodo-bridge
sudo systemctl status dodo-bridge
```

> 若与旧 `qq-bridge-universal.service` 冲突（同端口 8080），需先停旧服务：
> `sudo systemctl stop qq-bridge-universal && sudo systemctl disable qq-bridge-universal`

## 6. 验证清单

- [ ] `curl http://127.0.0.1:8080/health` → `ok:true, ws_connected:true, bot_qq:810429614`
- [ ] 群里 @渡渡 → 队列 pending+1（`/api/queue/stats`）
- [ ] selective 模式下普通群消息**不**排队（BUG-01 验证）
- [ ] 带 token 调 `/api/pull?count=5` → `has_message:true, items:[...]`
- [ ] 回传 `/api/reply{id, reply}` → 群内收到带**原生引用**的回复（quote_reply_enabled）

## 7. 安全（BUG-05）

- 当前 HTTP 无 TLS（BRIDGE_TOKEN 明文风险）→ 建议后续上 CF Tunnel 或 Nginx TLS。
- `run_dodo_bridge.env` 权限收紧：`chmod 600 run_dodo_bridge.env`，勿入库。

## 8. 回滚

旧服务备份：`qq-bridge-universal` systemd 仍保留（只需 `systemctl enable --now` 恢复），
旧数据在 `~/.qq_bridge_universal/`。新服务数据在 `~/.dodo_napcat/`，互不污染。