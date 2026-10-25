import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPhraseBook, convBlock, convHeader, historyTurns, parseConvMessages, parseReply, phraseKey } from "../src/chat";

test("解析對話回覆", () => {
	const r = parseReply(JSON.stringify({ correction: { original: "I go yesterday", corrected: "I went yesterday.", explanation: "過去式", zh: "我昨天去" }, howto: [{ zh: "請假", en: "take a day off" }, { zh: "", en: "x" }], reply: "Nice!", replyZh: "很好" }));
	assert.equal(r.correction?.corrected, "I went yesterday.");
	assert.equal(r.howto.length, 1);
	assert.equal(parseReply("plain text").reply, "plain text");
	assert.equal(parseReply(JSON.stringify({ correction: { original: "Hi", corrected: "hi" }, reply: "x" })).correction, null);
});

test("對話檔可重建歷史（含 -- 字元）", () => {
	const md =
		convHeader({ user: "u", level: "adult", topic: "free", topicLabel: "自由聊天", device: "d", started: "s" }) +
		convBlock({ role: "model", text: '{"reply":"Hi -- there"}', ts: "1" }) +
		convBlock({ role: "user", text: "a -- b", ts: "2" }) +
		convBlock({ role: "model", text: '{"reply":"ok"}', ts: "3" });
	const msgs = parseConvMessages(md);
	assert.equal(msgs.length, 3);
	assert.equal(msgs[1].text, "a -- b");
	const turns = historyTurns(msgs);
	assert.deepEqual(turns.map((t) => t.role), ["user", "model", "user", "model"]);
});

test("句子本：去重與移除", () => {
	const k = phraseKey("Take a day off!");
	assert.equal(k, phraseKey("take a day off"));
	const book = buildPhraseBook([
		{ id: "1", ts: "1", type: "phrase-add", key: k, zh: "請假", en: "take a day off" },
		{ id: "2", ts: "2", type: "phrase-add", key: "x", zh: "x", en: "x" },
		{ id: "3", ts: "3", type: "phrase-remove", key: "x" },
	] as any);
	assert.deepEqual(book.map((b) => b.en), ["take a day off"]);
});
