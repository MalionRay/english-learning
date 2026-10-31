import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PracticeView } from "../src/practice";
import { ChatView } from "../src/chatview";
import { renderBank } from "../src/generate";
import { makeApp } from "./helpers/app";
import { japaneseBank, sampleBank, spanishBank } from "./helpers/fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(lang: "en" | "es" | "ja") {
	const { app, files } = makeApp(
		new Map([
			["english/bank/b1.md", renderBank(sampleBank(), "english/sources/Story")],
			["english/bank/es1.md", renderBank(spanishBank(), "english/sources/Mercado")],
			["english/bank/ja1.md", renderBank(japaneseBank(), "english/sources/Tenki")],
			["logs/ray/ipad-1.jsonl", ""],
		]),
	);
	let n = 0;
	const said: { text: string; lang?: string }[] = [];
	const aiCalls: string[] = [];
	const plugin: any = {
		app,
		user: "ray",
		lang,
		deviceId: "ipad-1",
		settings: { users: ["ray"], newPerDay: 10 },
		userNames: () => ["ray"],
		levelOf: () => "adult",
		getApiKey: () => "k",
		fastBackend() {
			return this.backend();
		},
		backend: () => ({
			complete: async (p: string, o: any) => {
				aiCalls.push(o?.system ?? "");
				if (/hiragana/.test(o?.system ?? "")) return { text: JSON.stringify({ items: p.split("\n").map(() => ({ kana: "かな", romaji: "kana" })) }), usage: {}, model: "m" };
				return { text: '{"score":80,"feedback":"好","corrected":""}', usage: {}, model: "m" };
			},
		}),
		makeEntry: (type: string, extra: Record<string, unknown>) => ({ id: "e" + n++, ts: new Date().toISOString(), device: "ipad-1", user: "ray", type, ...extra }),
		appendLog: async (e: unknown) => void files.set("logs/ray/ipad-1.jsonl", String(files.get("logs/ray/ipad-1.jsonl")) + JSON.stringify(e) + "\n"),
		say: (text: string, _r?: number, o?: { lang?: string }) => said.push({ text, lang: o?.lang }),
		syncAndWait: async () => true,
		fixQuestion: async () => null,
		debug: () => undefined,
	};
	const view: any = new PracticeView({ app } as any, plugin);
	const btn = (t: string) => [...view.contentEl.querySelectorAll("button")].find((b: any) => b.textContent === t) as any;
	const card = (name: string) => [...view.contentEl.querySelectorAll(".el-type-card")].find((c: any) => c.querySelector(".el-title").textContent === name) as any;
	const logs = () => String(files.get("logs/ray/ipad-1.jsonl")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	return { view, btn, card, logs, said, aiCalls, plugin, app, files };
}

test("日文練習：有假名題型、只出日文題庫、克漏字打羅馬拼音也算對，紀錄帶 lang", async () => {
	const { view, btn, card, logs, said } = setup("ja");
	await view.onOpen();
	await sleep(30);
	assert.ok(view.contentEl.querySelector("select.el-lang-select"));
	assert.ok(card("假名"), "日文有假名題型");
	assert.match(card("克漏字").textContent, /共 1/); // 只有日文題庫的那一題
	card("克漏字").querySelector("button").click();
	await sleep(30);
	assert.match(view.contentEl.textContent, /毎朝、公園を____。/);
	view.contentEl.querySelector("input.el-cloze-input").value = "sanpo shimasu";
	btn("送出").click();
	assert.match(view.contentEl.querySelector(".el-verdict").textContent, /答對/);
	const last = logs().pop();
	assert.equal(last.lang, "ja");
	assert.equal(last.qid, "ja-c1");
	// 日文句子逐字可點，並有讀音按鈕
	const words = [...view.contentEl.querySelectorAll(".el-w")].map((w: any) => w.textContent);
	assert.ok(words.includes("公園"));
	assert.ok(view.contentEl.querySelector(".el-reading-btn"));
	view.contentEl.querySelector(".el-say-btn").click();
	assert.equal(said.pop()?.lang, "ja");
});

test("假名卡片：看答案顯示羅馬拼音與例字，記得／不記得記成 kana 紀錄", async () => {
	const { view, btn, card, logs } = setup("ja");
	await view.onOpen();
	await sleep(30);
	card("假名").querySelector("button").click();
	await sleep(30);
	assert.equal(view.contentEl.querySelector(".el-kana-big").textContent, "あ");
	btn("看答案").click();
	assert.match(view.contentEl.textContent, /a/);
	assert.match(view.contentEl.textContent, /あめ/);
	btn("記得").click();
	const e = logs().pop();
	assert.equal(e.qtype, "kana");
	assert.equal(e.qid, "kana:あ");
});

test("西班牙文練習：沒有假名題型；克漏字少了重音也算對但提醒", async () => {
	const { view, btn, card } = setup("es");
	await view.onOpen();
	await sleep(30);
	assert.equal(card("假名"), undefined);
	card("克漏字").querySelector("button").click();
	await sleep(30);
	view.contentEl.querySelector("input.el-cloze-input").value = "esta";
	btn("送出").click();
	assert.match(view.contentEl.querySelector(".el-verdict").textContent, /答對.*注意重音：está/);
});

test("英文練習不受影響：看不到西班牙文、日文的題目", async () => {
	const { view, card } = setup("en");
	await view.onOpen();
	await sleep(30);
	assert.equal(card("假名"), undefined);
	assert.match(card("克漏字").textContent, /共 1/);
	assert.match(card("單字").textContent, /共 2/);
});

test("日文對話：提示用日文角色，AI 回覆下面顯示平假名與羅馬拼音，對話檔記 lang", async () => {
	const { app, files, plugin } = setup("ja");
	const systems: string[] = [];
	plugin.backend = () => ({
		chat: async (_t: unknown, o: any) => (
			systems.push(o.system),
			{ text: JSON.stringify({ correction: null, howto: [], reply: "こんにちは！今日は何をしましたか？", replyZh: "你好！今天做了什麼？", replyReading: "こんにちは！きょうはなにをしましたか？", replyRomaji: "konnichiwa! kyou wa nani o shimashita ka?" }), usage: {}, model: "m" }
		),
		complete: async () => ({ text: '{"zh":[]}', usage: {}, model: "m" }),
	});
	plugin.settings = { ...plugin.settings, chatVoice: "off" };
	plugin.pronouncer = { speakNatural: async () => true };
	plugin.appendText = async (f: any, t: string) => void files.set(f.path, String(files.get(f.path) ?? "") + t);
	plugin.addPhrase = async () => undefined;
	plugin.triggerSync = () => undefined;
	app.saveLocalStorage("english-learning:chat-voice", "off");
	const view: any = new ChatView({ app } as any, plugin);
	await view.onOpen();
	assert.match(view.contentEl.querySelector("h3").textContent, /日文對話/);
	await view.startNew({ id: "free", label: "自由聊天", prompt: "Free chat." }, undefined, false);
	assert.match(systems[0], /Yui/);
	assert.match(systems[0], /of 5/);
	assert.match(view.contentEl.querySelector(".el-romaji").textContent, /konnichiwa/);
	const conv = [...files.keys()].find((k) => k.startsWith("conversations/"))!;
	assert.match(String(files.get(conv)), /^lang: ja$/m);
	assert.match(String(files.get(conv)), /# 日文對話/);
});
