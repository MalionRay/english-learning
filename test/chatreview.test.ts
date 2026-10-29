import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPhraseBook, failedSentenceMap, phraseKey } from "../src/chat";
import { mentionsWord, parseLearnerUsed, pickTargets, targetsPrompt, usedTargets } from "../src/chattargets";
import { ChatView } from "../src/chatview";
import { renderBank } from "../src/generate";
import { computeStates } from "../src/srs";
import { makeApp } from "./helpers/app";
import { sampleBank } from "./helpers/fixtures";

const t = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
const bank = sampleBank();
const failed = failedSentenceMap(bank.questions.map((q) => ({ q, bank })), [{ id: "listen:x", text: "The puppy sleeps by the door.", zh: "小狗睡在門邊。", bank: "b1" }]);

test("答錯的克漏字、翻譯、聽力句子自動進句子本", () => {
	const logs = [
		{ id: "1", ts: t(5), type: "answer", qid: "c1", qtype: "cloze", correct: false, dontKnow: true },
		{ id: "2", ts: t(4), type: "answer", qid: "c1", qtype: "cloze", correct: false, relearn: true },
		{ id: "3", ts: t(4), type: "answer", qid: "t1", qtype: "translate", pending: true, text: "boat harbor" },
		{ id: "4", ts: t(3), type: "grade", answerId: "3", qid: "t1", score: 40, correct: false },
		{ id: "5", ts: t(3), type: "answer", qid: "listen:x", qtype: "listening", correct: true },
		{ id: "6", ts: t(2), type: "answer", qid: "v2", qtype: "vocab", correct: false },
	] as any;
	let book = buildPhraseBook(logs, failed);
	assert.deepEqual(
		book.map((p) => [p.source, p.en, p.zh]).sort(),
		[
			["cloze", "Tom opened the window because the room was hot.", "湯姆打開窗戶，因為房間很熱。"],
			["translate", "The boat is in the harbor.", "船停在港口。"],
		],
	);
	// 移除後又答錯：再出現；同一句已經在句子本裡（對話中加入）就不重複
	const key = phraseKey("Tom opened the window because the room was hot.");
	book = buildPhraseBook([...logs, { id: "7", ts: t(1), type: "phrase-remove", key }] as any, failed);
	assert.ok(!book.some((p) => p.key === key));
	book = buildPhraseBook([...logs, { id: "7", ts: t(1), type: "phrase-remove", key }, { id: "8", ts: t(0.5), type: "answer", qid: "c1", qtype: "cloze", correct: false }] as any, failed);
	assert.ok(book.some((p) => p.key === key));
	const both = buildPhraseBook([{ id: "9", ts: t(9), type: "phrase-add", key, zh: "開窗", en: "Tom opened the window because the room was hot.", source: "howto" }, ...logs] as any, failed);
	assert.equal(both.filter((p) => p.key === key).length, 1);
	assert.equal(both.find((p) => p.key === key)!.source, "howto");
});

test("對話複習目標：上次答錯優先、到期才出、補少量新字", () => {
	const now = Date.now();
	const w = (key: string) => ({ key, word: key, banks: new Set<string>(), reasons: new Set<any>(), wrong: 0, addedAt: t(1), forms: new Set<string>() });
	const words = [w("fresh1"), w("fresh2"), w("fresh3"), w("notdue"), w("due-old"), w("due-wrong")];
	const logs = [
		{ id: "a", ts: t(10), type: "answer", qid: "word:due-old", qtype: "word", correct: true },
		{ id: "b", ts: t(2), type: "answer", qid: "word:due-wrong", qtype: "word", correct: false },
		{ id: "c", ts: t(0.1), type: "answer", qid: "word:notdue", qtype: "word", correct: true },
	] as any;
	const targets = pickTargets(words as any, [], computeStates(logs), now, 5, 2);
	assert.deepEqual(targets.map((x) => x.en), ["due-wrong", "due-old", "fresh1", "fresh2"]);
	assert.equal(targets[0].wasWrong, true);
	assert.match(targetsPrompt(targets, "adult"), /1\. word: due-wrong[\s\S]*learnerUsed/);
	assert.equal(targetsPrompt([], "adult"), "");
});

test("判斷學習者有沒有用到複習的字", () => {
	const go = { n: 1, kind: "word" as const, qid: "word:go", en: "go", forms: ["went"], wasWrong: false };
	const lookUp = { n: 2, kind: "word" as const, qid: "word:look up", en: "look up", forms: [], wasWrong: false };
	const ph = { n: 3, kind: "phrase" as const, qid: "phrase:x", en: "Could I get the bill?", forms: [], wasWrong: false };
	assert.ok(mentionsWord("I went home.", go));
	assert.ok(mentionsWord("She goes to work.", go));
	assert.ok(!mentionsWord("Good morning", go));
	assert.ok(mentionsWord("Let me look up the word", lookUp));
	assert.deepEqual(parseLearnerUsed('{"reply":"x","learnerUsed":[1,"3",0,-2]}'), [1, 3]);
	assert.deepEqual(parseLearnerUsed("not json"), []);
	// AI 說用了但訊息裡沒有這個字：不算；沒被糾正且有用到：算；句子以 AI 判斷為準
	assert.deepEqual(usedTargets([go, lookUp, ph], "I want the check please", [1, 3], false).map((x) => x.n), [3]);
	assert.deepEqual(usedTargets([go], "I went there", [], false).map((x) => x.n), [1]);
	assert.deepEqual(usedTargets([go], "I goed there", [], true).map((x) => x.n), []);
});

test("對話畫面：到期的字放進提示，用對了記一筆複習", async () => {
	const { app, files } = makeApp(
		new Map([
			["english/bank/b1.md", renderBank(sampleBank(), "english/sources/Story")],
			["logs/ray/ipad-1.jsonl", JSON.stringify({ id: "w1", ts: t(3), type: "word-add", word: "gentle", meaning: "溫柔的" }) + "\n" + JSON.stringify({ id: "w2", ts: t(2), type: "answer", qid: "word:gentle", qtype: "word", correct: false }) + "\n"],
		]),
	);
	const systems: string[] = [];
	let n = 0;
	const replies = [
		{ correction: null, howto: [], reply: "Hi! How was your puppy today?", replyZh: "嗨" },
		{ correction: null, howto: [], reply: "That is so sweet.", replyZh: "好可愛", learnerUsed: [1] },
		{ correction: null, howto: [], reply: "Nice.", replyZh: "很好", learnerUsed: [] },
	];
	const plugin: any = {
		app,
		user: "ray",
		deviceId: "ipad-1",
		settings: { users: ["ray"] },
		getApiKey: () => "k",
		backend: () => ({ chat: async (_t: unknown, o: any) => (systems.push(o.system), { text: JSON.stringify(replies[n++]), usage: {}, model: "m" }) }),
		appendText: async (f: any, s: string) => void files.set(f.path, String(files.get(f.path) ?? "") + s),
		makeEntry: (type: string, extra: Record<string, unknown>) => ({ id: "e" + Math.random(), ts: new Date().toISOString(), device: "ipad-1", user: "ray", type, ...extra }),
		appendLog: async (e: any) => void files.set("logs/ray/ipad-1.jsonl", String(files.get("logs/ray/ipad-1.jsonl")) + JSON.stringify(e) + "\n"),
		addPhrase: async () => undefined,
		debug: () => undefined,
		triggerSync: () => undefined,
	};
	const view: any = new ChatView({ app } as any, plugin);
	await view.onOpen();
	await view.startNew({ id: "free", label: "自由聊天", prompt: "Free chat." }, undefined, true);
	assert.match(systems[0], /1\. word: gentle {2}\(溫柔的\)/);
	assert.ok(view.contentEl.querySelector(".el-target-chip"));
	await view.send("My puppy is very gentle.");
	const L = String(files.get("logs/ray/ipad-1.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
	const rev = L.filter((e) => e.via === "chat");
	assert.equal(rev.length, 1);
	assert.equal(rev[0].qid, "word:gentle");
	assert.equal(rev[0].correct, true);
	assert.ok(view.contentEl.querySelector(".el-target-chip.is-done"));
	assert.match(systems[1], /word: gentle/); // 送出時還在目標裡，讓 AI 判斷有沒有用對
	await view.send("Thanks!");
	assert.doesNotMatch(systems[2], /word: gentle/); // 用對之後就不再要求
	assert.equal(String(files.get("logs/ray/ipad-1.jsonl")).split("\n").filter((l) => l.includes('"via":"chat"')).length, 1);
});
