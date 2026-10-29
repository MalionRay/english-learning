import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hedged, AIError } from "../src/ai";
import { ChatView, LS_CHAT_VOICE } from "../src/chatview";
import { VOICE_TURN, parseHeard } from "../src/chat";
import { downsample, encodeWav, trimSilence } from "../src/recorder";
import { makeApp } from "./helpers/app";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("慢的請求會再送一次、取先回來的；逾時與網路錯誤", async () => {
	let calls = 0;
	const fn = () => {
		const n = ++calls;
		return new Promise<string>((ok) => setTimeout(() => ok("r" + n), n === 1 ? 200 : 20));
	};
	assert.equal(await hedged(fn, 50, 1000), "r2");
	assert.equal(calls, 2);

	calls = 0;
	assert.equal(await hedged(() => (++calls, Promise.resolve("fast")), 50, 1000), "fast");
	await sleep(80);
	assert.equal(calls, 1); // 很快回來就不會再送

	await assert.rejects(hedged(() => new Promise(() => undefined), undefined, 50), (e: AIError) => e.kind === "network");

	calls = 0;
	const flaky = () => (++calls === 1 ? Promise.reject(new Error("net")) : Promise.resolve("ok"));
	assert.equal(await hedged(flaky, 1000, 2000), "ok"); // 第一次網路錯誤就立刻重試一次
	await assert.rejects(hedged(() => Promise.reject(new Error("down")), 1000, 2000), /down/);
});

test("錄音編成 16 kHz WAV、去掉頭尾靜音", () => {
	const x = new Float32Array(48000);
	for (let i = 10000; i < 20000; i++) x[i] = 0.5;
	const t = trimSilence(x, 48000);
	assert.ok(t.length < x.length && t.length >= 10000);
	const d = downsample(t, 48000, 16000);
	assert.equal(d.length, Math.floor(t.length / 3));
	const wav = encodeWav(d, 16000);
	const v = new DataView(wav);
	assert.equal(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)), "RIFF");
	assert.equal(v.getUint32(24, true), 16000);
	assert.equal(wav.byteLength, 44 + d.length * 2);
});

function setup(replies: object[]) {
	const { app, files } = makeApp(new Map([["logs/ray/ipad-1.jsonl", ""]]));
	const calls: any[] = [];
	const said: any[] = [];
	let n = 0;
	const plugin: any = {
		app,
		user: "ray",
		deviceId: "ipad-1",
		settings: { users: ["ray"] },
		getApiKey: () => "k",
		backend: () => ({ chat: async (turns: any, o: any) => (calls.push({ turns, o }), { text: JSON.stringify(replies[n++]), usage: { inputTokens: 1, outputTokens: 1 }, model: "m" }) }),
		appendText: async (f: any, s: string) => void files.set(f.path, String(files.get(f.path) ?? "") + s),
		makeEntry: (type: string, extra: Record<string, unknown>) => ({ id: "e" + Math.random(), ts: new Date().toISOString(), device: "ipad-1", user: "ray", type, ...extra }),
		appendLog: async (e: any) => void files.set("logs/ray/ipad-1.jsonl", String(files.get("logs/ray/ipad-1.jsonl")) + JSON.stringify(e) + "\n"),
		addPhrase: async () => undefined,
		debug: () => undefined,
		triggerSync: () => undefined,
		say: (text: string, rate: unknown, opts: unknown) => said.push({ text, opts }),
	};
	const view: any = new ChatView({ app } as any, plugin);
	return { app, files, view, calls, said };
}

test("語音訊息：錄音直接送 AI，顯示聽到的內容並存進對話", async () => {
	const { app, files, view, calls, said } = setup([
		{ correction: null, howto: [], reply: "Hello! How are you?", replyZh: "你好" },
		{ heard: "I go to 公司 yesterday", correction: { original: "I go to 公司 yesterday", corrected: "I went to the office yesterday.", explanation: "過去式", zh: "我昨天去公司" }, howto: [{ zh: "公司", en: "the office" }], reply: "What did you do there?", replyZh: "你在那裡做什麼？" },
		{ heard: "", correction: null, howto: [], reply: "Sorry?", replyZh: "" },
	]);
	app.saveLocalStorage(LS_CHAT_VOICE, "natural");
	await view.onOpen();
	await view.startNew({ id: "free", label: "自由聊天", prompt: "x" }, undefined, false);
	assert.deepEqual(said.map((x) => x.text), ["Hello! How are you?"]); // 自動朗讀
	assert.deepEqual(said[0].opts, { noSave: true });

	await view.sendVoice(encodeWav(new Float32Array(16000), 16000));
	const last = calls[1].turns[calls[1].turns.length - 1];
	assert.equal(last.role, "user");
	assert.equal(last.text, VOICE_TURN);
	assert.equal(last.media[0].mimeType, "audio/wav");
	assert.ok(calls[1].o.hedgeAfterMs > 0 && calls[1].o.timeoutMs > 0);
	const bubbles = [...view.contentEl.querySelectorAll(".el-bubble-user")].map((b: any) => b.textContent);
	assert.deepEqual(bubbles, ["🎤 I go to 公司 yesterday"]);
	const conv = [...files.entries()].find(([k]) => k.startsWith("conversations/"))![1] as string;
	assert.match(conv, /\*\*You 🎤:\*\* I go to 公司 yesterday/);
	assert.equal(view.messages.filter((m: any) => m.voice).length, 1);
	assert.equal(said.length, 2);
	const api = String(files.get("logs/ray/ipad-1.jsonl")).trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "api");
	assert.equal(api[1].voice, true);
	assert.equal(typeof api[1].ms, "number");

	// 沒聽到聲音：不存訊息
	await view.sendVoice(encodeWav(new Float32Array(16000), 16000));
	assert.equal(view.messages.length, 3);
	assert.match(view.contentEl.querySelector(".el-bubble-user.is-failed").textContent, /沒聽清楚/);
	assert.equal(parseHeard('{"heard":" hi "}'), "hi");
	assert.equal(parseHeard("x"), null);
});

test("關掉自動朗讀就不唸；手動 🔊 仍可唸", async () => {
	const { app, view, said } = setup([{ correction: null, howto: [], reply: "Hi!", replyZh: "嗨" }]);
	app.saveLocalStorage(LS_CHAT_VOICE, "off");
	await view.onOpen();
	await view.startNew({ id: "free", label: "自由聊天", prompt: "x" }, undefined, false);
	assert.equal(said.length, 0);
	assert.equal(view.contentEl.querySelector(".el-top button").textContent, "🔇");
	view.contentEl.querySelector(".el-top button").click(); // 打開
	assert.equal(app.loadLocalStorage(LS_CHAT_VOICE), "system");
});
