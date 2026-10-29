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

test("對話提示：像朋友聊天，不要制式稱讚", () => {
	const { chatSystemPrompt, TOPICS } = require("../src/chat");
	const adult = chatSystemPrompt("adult", TOPICS[0]);
	assert.match(adult, /You are Alex/);
	assert.match(adult, /Do NOT open with generic praise/);
	assert.doesNotMatch(adult, /ask a follow-up question; 1–3 sentences/);
	assert.match(chatSystemPrompt("kid", TOPICS[0]), /You are Mia/);
});

test("系統語音：有高品質語音就優先用", () => {
	const { defaultVoice, voiceQuality } = require("../src/tts");
	const v = (name: string, voiceURI: string, lang = "en-US") => ({ name, voiceURI, lang, localService: true });
	const voices = [v("Samantha", "com.apple.voice.compact.en-US.Samantha"), v("Ava", "com.apple.voice.premium.en-US.Ava"), v("Zoe", "com.apple.voice.enhanced.en-US.Zoe"), v("Daniel", "x", "en-GB")];
	assert.equal(voiceQuality(voices[1]), 2);
	assert.equal(defaultVoice(voices).name, "Ava");
	assert.equal(defaultVoice([voices[0], voices[2]]).name, "Zoe");
	assert.equal(defaultVoice([voices[0]]).name, "Samantha");
});
