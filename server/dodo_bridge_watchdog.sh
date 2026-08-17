#!/bin/bash
# dodo_napcat 服务器守护脚本 v2（nohup 保活 + 登录守卫 + 周期刷新登录 + 心跳日志）
# 由 napcat_pro_server 子包 / crontab 调度；幂等，可每 10 分钟跑一次。
LOG=/home/lighthouse/.dodo_napcat/watchdog.log
BRIDGE_DIR=/home/lighthouse/dodo_napcat/server
QR_NEED=/home/lighthouse/.dodo_napcat/NEED_SCAN_qrcode.png
now(){ date '+%Y-%m-%d %H:%M:%S'; }

BRIDGE_ALIVE=no; QQ_ALIVE=no; LOGIN=down
pgrep -f 'dodo_bridge_server.py' >/dev/null && BRIDGE_ALIVE=yes
pgrep -f '/opt/QQ/qq --no-sandbox' >/dev/null && QQ_ALIVE=yes
ss -tln 2>/dev/null | grep -q ':6098 ' && LOGIN=up

echo "$(now) [heartbeat] bridge=$BRIDGE_ALIVE qq=$QQ_ALIVE login=$LOGIN" >> "$LOG"

if [ "$BRIDGE_ALIVE" = no ]; then
  echo "$(now) [watchdog] bridge process dead -> nohup start" >> "$LOG"
  cd "$BRIDGE_DIR" || exit 1
  nohup bash run_dodo_bridge.sh start >>"$LOG" 2>&1 &
  sleep 2
fi

if [ "$QQ_ALIVE" = yes ]; then
  if [ "$LOGIN" = down ]; then
    echo "$(now) [watchdog] QQ alive but 6098 down (logged out) -> restart qq-napcat" >> "$LOG"
    sudo systemctl restart qq-napcat
    sleep 20
    if ss -tln 2>/dev/null | grep -q ':6098 '; then
      echo "$(now) [watchdog] relogin ok (quick login)" >> "$LOG"
    else
      for f in /opt/QQ/resources/app/napcat/cache/qrcode.png; do
        if [ -f "$f" ] && [ "$(stat -c %Y "$f" 2>/dev/null)" -ge "$(( $(date +%s) - 300 ))" ]; then
          cp -f "$f" "$QR_NEED" 2>/dev/null
          echo "$(now) [watchdog] LOGIN NEEDED: qrcode at $QR_NEED" >> "$LOG"
        fi
      done
    fi
  fi
else
  echo "$(now) [watchdog] QQ process dead -> systemd restart" >> "$LOG"
  sudo systemctl restart qq-napcat
fi

exit 0
