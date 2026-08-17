"use strict";
/* METADATA
{
  "name": "napcat_pro_server",
  "display_name": {"zh": "渡渡 NapCat 服务器守护", "en": "Dodo NapCat Server Guard"},
  "description": {
    "zh": "管理云端 dodo_bridge_server / QQ-NapCat 的 nohup 守护：部署看门狗、保活、登录守卫、周期重登、扫码二维码拉取到本机。SSH 配置读 /sdcard/Download/Operit/plugins/com.operit.napcat_pro/server.json。",
    "en": "Manage remote dodo_bridge_server / QQ-NapCat watchdog daemon."
  },
  "enabledByDefault": false,
  "category": "Communication",
  "tools": [
    {"name":"install","description":{"zh":"把守护脚本部署到服务器并安装 cron（每10分钟保活 + 每周一 04:30 周期重登）。幂等可重复执行。","en":"Deploy watchdog script and install cron."},"parameters":[]},
    {"name":"run_watchdog","description":{"zh":"在服务器上立即跑一次守护（保活 + 登录守卫）。","en":"Run watchdog once on server."},"parameters":[]},
    {"name":"watchdog_status","description":{"zh":"查看守护日志尾部 + 服务器桥健康 + QQ 登录态（6098监听）。","en":"View watchdog log and server health."},"parameters":[]},
    {"name":"relogin_qq","description":{"zh":"重启 QQ/NapCat 重新登录；若需扫码，自动把新二维码下载到 /sdcard/Download/qq_qrcode.png 并提示扫描。","en":"Restart QQ/NapCat to re-login; download QR if scan needed."},"parameters":[]},
    {"name":"fetch_qrcode","description":{"zh":"把服务器当前二维码拉到 /sdcard/Download/qq_qrcode.png（无新码时报错）。","en":"Fetch current login QR to Download."},"parameters":[]},
    {"name":"server_status","description":{"zh":"服务器桥健康 + 队列统计（等价 bridge 的 status 服务器段）。","en":"Bridge server health and queue stats."},"parameters":[]}
  ]
}
*/
const CONFIG_PATH = "/sdcard/Download/Operit/plugins/com.operit.napcat_pro/server.json";
const WATCHDOG_PATH = "/home/lighthouse/dodo_napcat/server/dodo_bridge_watchdog.sh";
const QR_LOCAL = "/sdcard/Download/qq_qrcode.png";
const QR_REMOTE = "/opt/QQ/resources/app/napcat/cache/qrcode.png";
const BRIDGE_TOKEN_ENV = ""; // 从 config.json 读（真实值勿入库）

function asText(v) { return v == null ? "" : String(v); }

function readBridgeConfig() {
  try {
    const r = Tools.Files.read({ path: "/sdcard/Download/Operit/plugins/com.operit.napcat_pro/config.json", environment: "android" });
    const t = asText(r.content || r.text || "").trim();
    return t ? JSON.parse(t) : {};
  } catch (e) { return {}; }
}

function readSshConfig() {
  try {
    const r = Tools.Files.read({ path: CONFIG_PATH, environment: "android" });
    const t = asText(r.content || r.text || "").trim();
    return t ? JSON.parse(t) : {};
  } catch (e) { return {}; }
}

async function sshRun(command, timeoutMs) {
  const cfg = readSshConfig();
  const host = cfg.host || "<你的服务器地址>";
  const port = cfg.port || 22;
  const user = cfg.user || "lighthouse";
  const pass = cfg.password || "";
  const safePass = String(pass).replace(/'/g, "'\\''");
  const cmd = "SSHPASS='" + safePass + "' sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -p " + port + " " + user + "@" + host + " " + JSON.stringify(command);
  const res = await toolCall("super_admin:terminal", { command: cmd, timeoutMs: timeoutMs || 30000 });
  return asText(res && (res.output || res.stdout || res.content || res.result || JSON.stringify(res)));
}

// 把远程文件拉回本机（base64 中转，二维码很小）
async function fetchRemoteFile(remotePath, localPath) {
  const b64 = await sshRun("base64 -w0 '" + remotePath + "' 2>/dev/null || echo __MISSING__", 20000);
  if (!b64 || String(b64).trim() === "__MISSING__" || String(b64).trim().indexOf("__MISSING__") >= 0) {
    throw new Error("远程文件不存在或为空: " + remotePath);
  }
  const data = String(b64).trim().replace(/\s+/g, "");
  await toolCall("super_admin:terminal", { command: "echo '" + data + "' | base64 -d > '" + localPath + "' && echo SAVED && ls -la '" + localPath + "'", timeoutMs: 15000 });
  return localPath;
}

async function handleInstall() {
  const out1 = await sshRun("chmod +x " + WATCHDOG_PATH + " && bash -n " + WATCHDOG_PATH + " && echo SCRIPT_OK", 15000);
  const cron = [
    "*/10 * * * * " + WATCHDOG_PATH + " >/dev/null 2>&1",
    "30 4 * * 1 sudo systemctl restart qq-napcat >/dev/null 2>&1"
  ].join("\n");
  const out2 = await sshRun("(crontab -l 2>/dev/null | grep -v 'dodo_bridge_watchdog'; echo '" + cron.replace(/'/g, "'\\''") + "') | crontab - && echo CRON_OK && crontab -l | grep -v '^#'", 15000);
  return { success: true, script: out1, cron: out2 };
}

async function handleRunWatchdog() {
  const out = await sshRun("bash " + WATCHDOG_PATH + "; echo EXIT=$?; tail -6 /home/lighthouse/.dodo_napcat/watchdog.log 2>/dev/null", 25000);
  return { success: true, output: out };
}

async function handleWatchdogStatus() {
  const out = await sshRun(
    "echo '===watchdog log==='; tail -12 /home/lighthouse/.dodo_napcat/watchdog.log 2>/dev/null || echo NO_LOG; "
    + "echo '===bridge==='; curl -s -m5 http://127.0.0.1:8080/health | head -c 400; echo; "
    + "echo '===qq login==='; ss -tln 2>/dev/null | grep -q ':6098 ' && echo '6098 LISTENING (logged in)' || echo '6098 DOWN (need login)'; "
    + "pgrep -f '/opt/QQ/qq --no-sandbox' >/dev/null && echo 'QQ process alive' || echo 'QQ process DEAD'; "
    + "pgrep -f dodo_bridge_server.py >/dev/null && echo 'bridge process alive' || echo 'bridge process DEAD'", 20000);
  return { success: true, output: out };
}

async function handleReloginQq() {
  const out1 = await sshRun("sudo systemctl restart qq-napcat && echo RESTART_OK", 30000);
  await new Promise((resolve) => { try { toolCall("super_admin:terminal", { command: "sleep 25", timeoutMs: 30000 }).then(resolve).catch(resolve); } catch (e) { resolve(); } });
  const check = await sshRun(
    "if ss -tln 2>/dev/null | grep -q ':6098 '; then echo 'QUICK_LOGIN_OK'; else echo 'NEED_SCAN'; "
    + "base64 -w0 " + QR_REMOTE + " 2>/dev/null || echo __MISSING__; fi", 20000);
  if (String(check).indexOf("QUICK_LOGIN_OK") >= 0) {
    return { success: true, restart: out1, login: "quick-login OK（无需扫码）" };
  }
  // 需要扫码 → 拉二维码
  let qrPath = "";
  try {
    qrPath = await fetchRemoteFile(QR_REMOTE, QR_LOCAL);
  } catch (e) {
    return { success: false, restart: out1, login: "NEED_SCAN 但二维码读取失败: " + String(e && e.message || e), hint: "请到服务器 NapCat WebUI 查看登录二维码" };
  }
  return { success: true, restart: out1, login: "NEED_SCAN", qrcode: qrPath, hint: "请打开 " + qrPath + " 扫码（机器人QQ）" };
}

async function handleFetchQrcode() {
  const qrPath = await fetchRemoteFile(QR_REMOTE, QR_LOCAL);
  return { success: true, qrcode: qrPath, hint: "请打开 " + qrPath + " 扫码（机器人QQ）" };
}

async function handleServerStatus() {
  const bridgeCfg = readBridgeConfig();
  const token = bridgeCfg.bridgeToken || BRIDGE_TOKEN_ENV;
  const out = await sshRun(
    "echo '===health==='; curl -s -m5 http://127.0.0.1:8080/health -H 'X-Bridge-Token: " + token + "' | python3 -m json.tool 2>/dev/null | head -40; "
    + "echo '===queue==='; curl -s -m5 http://127.0.0.1:8080/api/queue/stats -H 'X-Bridge-Token: " + token + "' 2>/dev/null", 20000);
  return { success: true, output: out };
}

async function main() {
  complete({ success: true, message: "渡渡 NapCat 服务器守护已加载。先确认 server.json 有 SSH 配置，再 install → run_watchdog / watchdog_status。" });
}

exports.install = handleInstall;
exports.run_watchdog = handleRunWatchdog;
exports.watchdog_status = handleWatchdogStatus;
exports.relogin_qq = handleReloginQq;
exports.fetch_qrcode = handleFetchQrcode;
exports.server_status = handleServerStatus;
exports.main = main;