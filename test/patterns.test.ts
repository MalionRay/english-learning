import { test } from "node:test";
import assert from "node:assert/strict";
import {
	analyzePatterns,
	collectAnswerErrors,
	loadConversationErrors,
	parsePatterns,
	patternPrompt,
	pickErrors,
	reportMarkdown,
	saveReport,
} from "../src/patterns";
import { convBlock, convHeader } from "../src/chat";
import { sampleBank } from "./helpers/fixtures";
import { makeApp } from "./helpers/app";

const t = (d: number) => new Date(Date.now() - d * 864e5).toISOString();

test("收集錯誤：翻譯低分、克漏字打錯；略過我不知道與已改對的", () => {
	const logs = [
		{ id: "a1", ts: t(3), type: "answer", qid: "t1", qtype: "translate", text: "The boat in harbor.", score: 60, corrected: "The boat is in the harbor.", feedback: "少了 is" },
		{ id: "a2", ts: t(2), type: "answer", qid: "t1", qtype: "translate", text: "The boat is in the harbor.", score: 100, corrected: "The boat is in the harbor." },
		{ id: "a3", ts: t(2), type: "answer", qid: "c1", qtype: "cloze", correct: false, text: "opend" },
		{ id: "a4", ts: t(1), type: "answer", qid: "c1", qtype: "cloze", correct: false, dontKnow: true, text: "" },
		{ id: "a5", ts: t(1), type: "answer", qid: "t1", qtype: "translate", text: "Boat stay harbor", pending: true },
		{ id: "g5", ts: t(0.5), type: "grade", answerId: "a5", qid: "t1", score: 40, correct: false, corrected: "The boat stays in the harbor." },
		{ id: "a6", ts: t(100), type: "answer", qid: "t1", qtype: "translate", text: "old", score: 10, corrected: "very old" },
	] as any;
	const items = collectAnswerErrors(logs, [sampleBank()], Date.now() - 60 * 864e5);
	assert.deepEqual(
		items.map((e) => [e.kind, e.wrong, e.right]),
		[
			["translate", "The boat in harbor.", "The boat is in the harbor."],
			["cloze", "opend", "opened"],
			["translate", "Boat stay harbor", "The boat stays in the harbor."],
		],
	);
	assert.equal(items[0].prompt, "船停在港口。");
	assert.match(patternPrompt(items), /^1\. \[translation\] \(船停在港口。\) The boat in harbor\. → The boat is in the harbor\.  \/\/ 少了 is/);
});

test("對話裡的修正只算這位使用者", async () => {
	const msg = (text: string, ts: string) => convBlock({ role: "model", text, ts });
	const reply = JSON.stringify({ correction: { original: "I go to school yesterday.", corrected: "I went to school yesterday.", explanation: "過去式", zh: "我昨天去學校" }, howto: [], reply: "Nice!", replyZh: "很好" });
	const head = (user: string) => convHeader({ user, level: "adult", topic: "free", topicLabel: "自由聊天", device: "ipad-1", started: t(1) });
	const { app } = makeApp(
		new Map([
			["conversations/a.md", head("ray") + msg(reply, t(1))],
			["conversations/b.md", head("kid") + msg(reply, t(1))],
		]),
	);
	const items = await loadConversationErrors(app, "ray", Date.now() - 864e5 * 60);
	assert.equal(items.length, 1);
	assert.equal(items[0].right, "I went to school yesterday.");
});

test("同一句錯誤只留一次、最新的優先", () => {
	const e = (ts: string, wrong: string) => ({ kind: "chat" as const, ts, wrong, right: "x" });
	const out = pickErrors([e(t(3), "A b."), e(t(1), "a B"), e(t(2), "c")], 10);
	assert.deepEqual(out.map((x) => x.wrong), ["a B", "c"]);
});

test("解析 AI 分析結果並產生報告", async () => {
	const json = JSON.stringify({
		summary: "過去式常常忘記。",
		patterns: [
			{ title: "過去式", explanation: "說昨天的事要用過去式。", examples: [{ wrong: "I go", right: "I went" }, { wrong: "", right: "x" }], tip: "看到 yesterday 就檢查動詞", drills: [{ zh: "我昨天吃了早餐。", en: "I ate breakfast yesterday.", note: "eat → ate" }, { zh: "沒英文" }] },
			{ title: "" },
		],
	});
	const p = parsePatterns("```json\n" + json + "\n```");
	assert.equal(p.patterns.length, 1);
	assert.equal(p.patterns[0].examples.length, 1);
	assert.equal(p.patterns[0].drills.length, 1);
	assert.throws(() => parsePatterns("not json"));

	const ai = { id: "f", model: "f", complete: async () => ({ text: json, usage: {}, model: "f" }), chat: async () => ({ text: "", usage: {}, model: "f" }) };
	const items = [{ kind: "chat" as const, ts: "2026-01-02T00:00:00Z", wrong: "I go", right: "I went" }, { kind: "chat" as const, ts: "2026-01-01T00:00:00Z", wrong: "b", right: "c" }];
	const r = await analyzePatterns(ai, items, "adult");
	assert.equal(r.count, 2);
	assert.equal(r.from, "2026-01-01T00:00:00Z");
	const md = reportMarkdown(r, "ray", "2026-01-03T00:00:00Z");
	assert.match(md, /# 常見錯誤分析（2026-01-03）/);
	assert.match(md, /- ~~I go~~ → \*\*I went\*\*/);
	assert.match(md, /我昨天吃了早餐。 → I ate breakfast yesterday\./);

	const { app, files } = makeApp();
	const now = new Date(2026, 0, 3, 9, 5);
	const f1 = await saveReport(app, "Ray", "ipad-1", md, now);
	const f2 = await saveReport(app, "Ray", "ipad-1", md, now);
	assert.equal(f1.path, "english/reports/ray/2026-01-03-0905-ipad-1.md");
	assert.equal(f2.path, "english/reports/ray/2026-01-03-0905-ipad-1-2.md");
	assert.equal(files.get(f1.path), md);
});
