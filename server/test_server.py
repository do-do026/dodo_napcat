#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dodo_bridge_server 冒烟测试（离线，不启服务不连 ws）。

用法：python3 test_server.py
覆盖：normalize_config / route_message（BUG-01 selective 预过滤）/
      split_reply_parts / claim_next 批量（BUG-02）/ format_prompt
"""
import os
import sys
import time

# 让导入走独立数据目录，避免污染
os.environ["BRIDGE_DATA_DIR"] = "/tmp/dodo_test_data"
os.environ["BRIDGE_TOKEN"] = "test-token"
os.environ["BOT_QQ"] = "888888888"

import dodo_bridge_server as srv  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}")


def reset():
    srv.queue.clear()
    srv.seen_ids.clear()
    srv.context_history.clear()
    srv.context_seen_ids.clear()
    srv._rate_windows.clear()


def test_normalize_config():
    print("[1] normalize_config")
    cfg = srv.normalize_config({"group_reply_mode": "bogus", "private_reply_mode": "whitelist",
                                "debounce_seconds": 999, "group_context_limit": 9999,
                                "quote_reply_enabled": False})
    check("非法 group mode 回退 keyword_or_at", cfg["group_reply_mode"] == "keyword_or_at")
    check("合法 private mode 保留", cfg["private_reply_mode"] == "whitelist")
    check("clamp debounce<=30", cfg["debounce_seconds"] == 30)
    check("clamp context<=50", cfg["group_context_limit"] == 50)
    check("quote 可关", cfg["quote_reply_enabled"] is False)


def test_selective_prefilter():
    print("[2] BUG-01 selective 预过滤")
    srv.reply_config = dict(srv.DEFAULT_REPLY_CONFIG)
    srv.reply_config["group_reply_mode"] = "selective"
    srv.reply_config["owner_qq"] = 666666666
    srv.reply_config["keywords"] = ["渡渡"]

    # 普通群消息（无@/关键词）→ 不排队
    en, sel, trig = srv.route_message("group", 111, "今天天气不错", False)
    check("普通群消息不排队", en is False and trig == "context_only")
    # @机器人 → 排队且需 AI 判断
    en, sel, trig = srv.route_message("group", 111, "渡渡在吗", True)
    check("@触发排队+需判断", en is True and sel is True and trig == "at")
    # 关键词 → 排队且需 AI 判断
    en, sel, trig = srv.route_message("group", 222, "渡渡说句话", False)
    check("关键词触发排队+需判断", en is True and sel is True and trig == "keyword")
    # owner → 始终回复（不需判断）
    en, sel, trig = srv.route_message("group", 666666666, "大家早", False)
    check("owner 无条件回复", en is True and sel is False and trig == "owner")


def test_split():
    print("[3] G4 waifu 分句（。！？\\n计数 / 连续换行归一化 / 400兜底）")
    srv.reply_config["split_reply_enabled"] = True
    srv.reply_config["private_chunk_size"] = 3
    srv.reply_config["group_chunk_size"] = 5
    # 群聊默认 5 句：3 句不足 → 1 段
    parts = srv.split_reply_parts("今天吃了。明天去玩。后天上班。", "group")
    check("群聊3句<5 → 1段", len(parts) == 1 and parts[0] == "今天吃了。明天去玩。后天上班。")
    # 群聊 7 句 → 2 段（5+2）
    parts = srv.split_reply_parts("一。二。三。四。五。六。七。", "group")
    check("群聊7句→2段", len(parts) == 2 and parts[0] == "一。二。三。四。五。")
    # 私聊默认 3 句：7 句 → 3 段（3+3+1）
    parts = srv.split_reply_parts("一。二。三。四。五。六。七。", "private")
    check("私聊7句→3段", len(parts) == 3 and parts[0] == "一。二。三。")
    # 连续换行归一化（只计 1 句）
    parts = srv.split_reply_parts("第一行\n\n\n第二行\n\n第三行\n", "group")
    check("连续换行归一化→1段", len(parts) == 1 and "\n\n" not in parts[0])
    # 400 字符兜底（无标点长文本）
    parts = srv.split_reply_parts("啊" * 900, "group")
    check("900字无标点→400/400/100", len(parts) == 3 and len(parts[0]) == 400 and len(parts[2]) == 100)
    # emoji 不破坏切分
    parts = srv.split_reply_parts("好耶🎉！🐾太棒了。再来一个🚀？最后一发💥。", "private")
    check("emoji混排4句limit3→2段", len(parts) == 2)
    # 无句末符短文本 → 整段
    parts = srv.split_reply_parts("没有标点的一段话", "group")
    check("短文本整段", len(parts) == 1)


def test_batch_claim():
    print("[4] BUG-02 批量领取")
    reset()
    for i in range(7):
        srv.queue.append({"id": f"item{i}", "status": "pending", "ready_at": 0, "claimed_at": 0,
                          "message_type": "group", "user_id": 1, "group_id": 2,
                          "nickname": "x", "text": f"m{i}", "messages": [f"m{i}"],
                          "selection_required": False, "context": [], "following_context": [],
                          "qq_message_id": f"q{i}", "is_owner": False, "trigger": "all"})
    items = srv.claim_next(5)
    check("批量领5条", len(items) == 5)
    check("批量被 PULL_MAX_COUNT 限制", srv.PULL_MAX_COUNT >= 5)
    pending = sum(1 for x in srv.queue if x.get("status") == "pending")
    check("剩余2条 pending", pending == 2)
    items2 = srv.claim_next(5)
    check("再领2条", len(items2) == 2)


def test_rate_limit():
    print("[5] BUG-04 速率上限")
    reset()
    srv.RATE_LIMIT_PER_MIN = 3
    key = "group:2"
    limited = [srv.rate_limited(key) for _ in range(4)]
    check("第4次触发限流", limited == [False, False, False, True])
    srv.RATE_LIMIT_PER_MIN = 30


def test_prompt():
    print("[6] format_prompt")
    reset()
    item = {"id": "abc", "message_type": "group", "user_id": 111, "group_id": 2,
            "nickname": "初尘", "text": "hello", "messages": ["hello"], "message_count": 1,
            "selection_required": False, "context": [], "following_context": []}
    prompt = srv.format_prompt(item)
    check("prompt 含会话标识", "QQ群 2" in prompt)
    check("prompt 含消息ID头(供回传映射)", prompt.startswith("[QQ_BRIDGE_MESSAGE_ID:abc]"))


def test_stale_clean():
    print("[7] 需求：丢弃5分钟前的内容")
    reset()
    srv.STALE_MSG_TTL_SECONDS = 300
    now = int(time.time())
    srv.queue.append({"id": "old1", "status": "pending", "created_at": now - 400, "ready_at": 0,
                      "message_type": "group", "user_id": 1, "group_id": 2, "nickname": "x", "text": "old",
                      "messages": ["old"], "qq_message_id": "q-old", "is_owner": False, "trigger": "all"})
    srv.queue.append({"id": "fresh", "status": "pending", "created_at": now - 30, "ready_at": 0,
                      "message_type": "group", "user_id": 1, "group_id": 2, "nickname": "x", "text": "fresh",
                      "messages": ["fresh"], "qq_message_id": "q-fresh", "is_owner": False, "trigger": "all"})
    srv.queue.append({"id": "done1", "status": "done", "created_at": now - 400, "ready_at": 0,
                      "message_type": "group", "user_id": 1, "group_id": 2, "nickname": "x", "text": "done",
                      "messages": ["done"], "qq_message_id": "q-done", "is_owner": False, "trigger": "all"})
    removed = srv.clean_stale_queue()
    check("丢弃1条过期 pending", removed == 1)
    check("保留 fresh", any(x.get("id") == "fresh" for x in srv.queue))
    check("done 审计保留", any(x.get("id") == "done1" for x in srv.queue))
    # pull 时也会触发清理
    srv.queue.append({"id": "old2", "status": "pending", "created_at": now - 400, "ready_at": 0,
                      "message_type": "group", "user_id": 1, "group_id": 2, "nickname": "x", "text": "old2",
                      "messages": ["old2"], "qq_message_id": "q-old2", "is_owner": False, "trigger": "all"})
    items = srv.claim_next(5)
    check("pull 时丢弃过期项", all(x.get("id") != "old2" for x in items))
    srv.STALE_MSG_TTL_SECONDS = 300


def test_p3_context_dual_mode():
    print("[8] P3 G2 上下文双模式（time/count）")
    reset()
    srv.reply_config = dict(srv.DEFAULT_REPLY_CONFIG)
    now = int(time.time())
    srv.context_history["group:2"] = [
        {"message_id": "m1", "created_at": now - 60, "user_id": 1, "nickname": "a", "text": "旧1", "is_bot": False},
        {"message_id": "m2", "created_at": now - 40, "user_id": 2, "nickname": "b", "text": "旧2", "is_bot": False},
        {"message_id": "m3", "created_at": now - 5, "user_id": 3, "nickname": "c", "text": "近", "is_bot": False},
    ]
    # count 模式默认：取最后 N 条
    srv.reply_config["at_context_mode"] = "count"
    srv.reply_config["at_context_count"] = 2
    ctx = srv.snapshot_context("group:2", now, "at")
    check("count 模式取最后2条", [x["message_id"] for x in ctx] == ["m2", "m3"])
    # time 模式：只读艾特前后 N 秒
    srv.reply_config["at_context_mode"] = "time"
    srv.reply_config["at_context_before_sec"] = 10
    srv.reply_config["at_context_after_sec"] = 0
    ctx = srv.snapshot_context("group:2", now, "at")
    check("time 模式只取艾特前10秒内", [x["message_id"] for x in ctx] == ["m3"])
    # 非 at 触发走 count
    ctx = srv.snapshot_context("group:2", now, "owner")
    check("非at触发回退count", len(ctx) == 3)


def test_p3_group_aggregate():
    print("[9] P3 G1 群聚合桶（窗口合成一轮）")
    reset()
    srv.reply_config = dict(srv.DEFAULT_REPLY_CONFIG)
    srv.reply_config["group_aggregate_window_ms"] = 200
    srv.reply_config["owner_qq"] = 666666666
    srv.reply_config["keywords"] = ["渡渡"]
    srv.reply_config["group_reply_mode"] = "keyword_or_at"
    now = int(time.time())
    # 3 条触发消息在窗口内
    for i, uid in enumerate([111, 222, 111]):
        data = {"message_type": "group", "user_id": uid, "group_id": 2, "message_id": f"q{i}",
                "sender": {"nickname": f"n{uid}"}, "message": [{"type": "text", "data": {"text": f"渡渡消息{i}"}}],
                "raw_message": f"渡渡消息{i}"}
        srv.enqueue_message(data)
        time.sleep(0.05)
    time.sleep(0.4)  # 等窗口 flush
    pending = [x for x in srv.queue if x.get("status") == "pending"]
    check("聚合桶合成1条", len(pending) == 1)
    check("聚合文本带编号", "[#1]" in pending[0]["text"] and "[#3]" in pending[0]["text"])
    check("聚合 message_count=3", pending[0]["message_count"] == 3)


def test_p3_replyto_protocol():
    print("[10] P3 G3 replyTo 协议头解析")
    reset()
    srv.reply_config = dict(srv.DEFAULT_REPLY_CONFIG)
    item = {"qq_message_id": "q1", "qq_message_ids": ["q1", "q2", "q3"]}
    # 前缀行 [replyTo:N]
    target, clean = srv.parse_reply_protocol("[replyTo:3]第三条的消息我来回。", item)
    check("前缀行解析编号3", target == "q3")
    check("前缀行剥掉协议头", clean == "第三条的消息我来回。")
    # JSON 整体
    target, clean = srv.parse_reply_protocol('{"replyTo":2,"content":"回应第二条。"}', item)
    check("JSON解析编号2", target == "q2" and clean == "回应第二条。")
    # 无协议头 → 默认首条
    target, clean = srv.parse_reply_protocol("正常回复。", item)
    check("无协议头默认首条", target == "q1" and clean == "正常回复。")
    # 越界编号 → 回退首条
    target, clean = srv.parse_reply_protocol("[replyTo:9]越界", item)
    check("越界回退首条", target == "q1")
    # 单条 item（非聚合）
    single = {"qq_message_id": "only1", "qq_message_ids": ["only1"]}
    target, clean = srv.parse_reply_protocol("[replyTo:1]单条", single)
    check("单条正常", target == "only1" and clean == "单条")


def test_p3_known_users():
    print("[11] P3 G7 成员别名映射（known_users）")
    reset()
    srv.reply_config = dict(srv.DEFAULT_REPLY_CONFIG)
    srv.reply_config["known_users"] = {"666666666": "苜蓿", "111": "小明"}
    check("别名优先", srv.display_name(666666666, "群名片") == "苜蓿")
    check("无别名回退群名片", srv.display_name(222, "群名片") == "群名片")
    check("都无回退QQ号", srv.display_name(333, "") == "333")
    # normalize 兼容 dict / json字符串
    n = srv.normalize_known_users('{"111":"aaa","222":"bbb"}')
    check("normalize json字符串", n == {"111": "aaa", "222": "bbb"})
    # prompt 里体现别名
    srv.reply_config["owner_qq"] = 666666666
    item = {"id": "i1", "message_type": "private", "user_id": 666666666, "group_id": 0,
            "nickname": "群名片", "text": "在吗", "messages": ["在吗"], "qq_message_id": "q1",
            "qq_message_ids": ["q1"], "context": [], "selection_required": False, "trigger": "owner"}
    p = srv.format_prompt(item)
    check("prompt 用别名", "苜蓿" in p)


def test_p3_observe_window():
    print("[12] P3 需求19 批量观察轮（复读检测/scope=all/引用抑制）")
    reset()
    srv.reply_config = dict(srv.DEFAULT_REPLY_CONFIG)
    # 复读检测
    check("复读3条→True", srv.detect_repeat_flood([{"text": "哈哈哈哈哈"}, {"text": "哈哈哈哈哈"}, {"text": "哈哈哈哈哈"}]) is True)
    check("不同3条→False", srv.detect_repeat_flood([{"text": "今天好累"}, {"text": "吃了吗"}, {"text": "下班咯"}]) is False)
    check("2条→False", srv.detect_repeat_flood([{"text": "哈"}, {"text": "哈"}]) is False)
    # scope=all：at_only 下非艾特消息也进桶 → 批量观察
    srv.reply_config["group_aggregate_window_ms"] = 200
    srv.reply_config["aggregate_scope"] = "all"
    srv.reply_config["group_reply_mode"] = "at_only"
    srv.reply_config["owner_qq"] = 666666666
    for i in range(3):
        data = {"message_type": "group", "user_id": 100 + i, "group_id": 9, "message_id": f"ob{i}",
                "sender": {"nickname": f"u{100+i}"}, "message": [{"type": "text", "data": {"text": f"闲聊{i}"}}],
                "raw_message": f"闲聊{i}"}
        srv.enqueue_message(data)
        time.sleep(0.05)
    time.sleep(0.4)
    pending = [x for x in srv.queue if x.get("status") == "pending"]
    check("scope=all 聚合出1条", len(pending) == 1)
    check("批量观察恒需选择", pending[0]["selection_required"] is True)
    p = srv.format_prompt(pending[0])
    check("prompt 含批量观察提示", "所有群消息" in p)
    # 引用抑制：复读+无replyTo → 不带 reply 段；显式 replyTo → 带
    item = {"qq_message_id": "q1", "qq_message_ids": ["q1"], "suppress_quote": True}
    segs = srv.build_outgoing_message(item, "就回一条。", 0, 1)
    check("复读无replyTo不引用", not any(s.get("type") == "reply" for s in segs))
    segs = srv.build_outgoing_message(item, "回第三条。", 0, 1, target_qid="q3")
    check("复读但显式replyTo仍引用", any(s.get("type") == "reply" and s.get("data", {}).get("id") == "q3" for s in segs))


def main():
    print("=== dodo_bridge_server smoke test ===")
    test_normalize_config()
    test_selective_prefilter()
    test_split()
    test_batch_claim()
    test_rate_limit()
    test_prompt()
    test_stale_clean()
    test_p3_context_dual_mode()
    test_p3_group_aggregate()
    test_p3_replyto_protocol()
    test_p3_known_users()
    test_p3_observe_window()
    print(f"\n=== {PASS} passed, {FAIL} failed ===")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()