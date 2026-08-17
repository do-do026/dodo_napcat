"use strict";
/* METADATA
{
  "name": "napcat_pro_bridge",
  "display_name": {"zh": "渡渡 NapCat 桥", "en": "Dodo NapCat Bridge"},
  "description": {
    "zh": "NapCat → Operit → QQ 桥（P2 消费端）：配置服务器连接、绑定 Operit 对话（fixed/auto）、开启轮询消费、AI 自动回复、选择性忽略。默认不自动开；群模式默认回艾特+关键词（keyword_or_at，可在 UI 调）。",
    "en": "Configure, bind and control the NapCat to Operit to QQ bridge consumer."
  },
  "enabledByDefault": false,
  "category": "Communication",
  "tools": [
    {
      "name": "configure",
      "description": {
        "zh": "配置桥接：服务器地址、Bridge Token、轮询间隔、批量领取数、对话绑定模式（fixed/auto）、固定对话、角色卡、AI超时。Token留空不覆盖。",
        "en": "Configure bridge connection and behavior."
      },
      "parameters": [
        {"name":"bridge_url","type":"string","required":false,"description":"远端桥服务器地址，如 http://&lt;你的服务器地址&gt;:8080"},
        {"name":"token","type":"string","required":false,"description":"Bridge Token；留空保留旧值"},
        {"name":"poll_interval_ms","type":"number","required":false,"description":"轮询间隔 3000~60000"},
        {"name":"pull_count","type":"number","required":false,"description":"批量领取条数 1~10"},
        {"name":"chat_binding_mode","type":"string","required":false,"description":"fixed=绑定固定对话 / auto=按群ID·私聊QQ自动开对话"},
        {"name":"fixed_chat_id","type":"string","required":false,"description":"fixed 模式绑定的 Operit 对话ID"},
        {"name":"character_card_name","type":"string","required":false,"description":"角色卡名称"},
        {"name":"ai_timeout_ms","type":"number","required":false,"description":"AI生成超时毫秒 10000~600000"},
        {"name":"enabled","type":"boolean","required":false,"description":"是否启用自动回复（默认 false）"}
      ]
    },
    {"name":"bind_current_chat","description":{"zh":"绑定当前 Operit 对话（fixed 模式），并沿用该对话已绑定的角色卡。","en":"Bind the current Operit chat."},"parameters":[
      {"name":"character_card_name","type":"string","required":false,"description":"可选覆盖角色卡名称"}
    ]},
    {"name":"bind_chat","description":{"zh":"按对话ID绑定用于生成QQ回复的 Operit 对话。","en":"Bind a chat by id."},"parameters":[
      {"name":"chat_id","type":"string","required":true,"description":"Operit 对话ID"},
      {"name":"chat_title","type":"string","required":false,"description":"可选标题"},
      {"name":"character_card_name","type":"string","required":false,"description":"可选角色卡名称"}
    ]},
    {"name":"start","description":{"zh":"开启桥接轮询。开启前验证服务器连通与对话绑定（fixed 模式须已绑定）；仅在服务器群模式未设置时同步默认 keyword_or_at（不覆盖 UI 已设模式）。","en":"Start the bridge polling loop."},"parameters":[]},
    {"name":"stop","description":{"zh":"关闭桥接轮询。","en":"Stop the bridge."},"parameters":[]},
    {"name":"status","description":{"zh":"查看桥接状态：配置（Token不返回原文）、处理计数、最近错误、服务器健康与队列。","en":"View bridge status."},"parameters":[]},
    {"name":"run_once","description":{"zh":"立即处理一批待回复消息（调试用）。","en":"Process messages once."},"parameters":[]},
    {"name":"set_reply_rules","description":{"zh":"透传回复规则到服务器：主人QQ、群/私聊模式、关键词、白名单、上下文条数、防抖、分条、引用。","en":"Set reply rules on the server."},"parameters":[
      {"name":"owner_qq","type":"string","required":false,"description":"主人QQ号"},
      {"name":"owner_always_reply","type":"boolean","required":false,"description":"主人消息是否始终回复"},
      {"name":"group_reply_mode","type":"string","required":false,"description":"群模式 off/at_only/keyword_or_at/selective/all"},
      {"name":"private_reply_mode","type":"string","required":false,"description":"私聊模式 off/owner_only/whitelist/keyword/all"},
      {"name":"keywords","type":"array","required":false,"items":{"type":"string"},"description":"群关键词"},
      {"name":"private_whitelist","type":"array","required":false,"items":{"type":"string"},"description":"私聊白名单QQ"},
      {"name":"group_context_limit","type":"number","required":false,"description":"群短上下文条数 1~50"},
      {"name":"private_context_limit","type":"number","required":false,"description":"私聊短上下文条数 1~30"},
      {"name":"debounce_seconds","type":"number","required":false,"description":"防抖秒数 0~30"},
      {"name":"split_reply_enabled","type":"boolean","required":false,"description":"按句号分条"},
      {"name":"reply_part_delay_ms","type":"number","required":false,"description":"分条间隔毫秒"},
      {"name":"quote_reply_enabled","type":"boolean","required":false,"description":"回复原生引用原消息"},
      {"name":"bot_name","type":"string","required":false,"description":"AI被称呼的名字/QQ昵称（如 渡渡），艾特渲染成 @渡渡"},
      {"name":"bridge_prompt","type":"string","required":false,"description":"桥接提示词（留空用默认兜底）"}
    ]},
    {"name":"test_server","description":{"zh":"测试服务器连通与鉴权。","en":"Test server connectivity."},"parameters":[]}
  ]
}
*/
const CHANNEL = "napcat_pro.bridge.";
async function run(name, params) {
  try {
    const data = await ToolPkg.ipc.call(CHANNEL + name, params || {});
    complete({ success: true, message: "渡渡 NapCat 桥操作完成", data });
  } catch (error) {
    complete({ success: false, message: "渡渡 NapCat 桥操作失败：" + String(error && error.message ? error.message : error) });
  }
}
function configure(params) { return run("configure", params); }
function bind_current_chat(params) { return run("bind_current_chat", params); }
function bind_chat(params) { return run("bind_chat", params); }
function start() { return run("start", {}); }
function stop() { return run("stop", {}); }
function status() { return run("status", {}); }
function run_once() { return run("run_once", {}); }
function set_reply_rules(params) { return run("set_reply_rules", params); }
function test_server() { return run("test_server", {}); }
async function main() { complete({ success: true, message: "渡渡 NapCat 桥已加载。默认关闭且不含私人配置；请先 configure 连接 → bind_current_chat 绑定 → start 开启。" }); }

exports.configure = configure;
exports.bind_current_chat = bind_current_chat;
exports.bind_chat = bind_chat;
exports.start = start;
exports.stop = stop;
exports.status = status;
exports.run_once = run_once;
exports.set_reply_rules = set_reply_rules;
exports.test_server = test_server;
exports.main = main;