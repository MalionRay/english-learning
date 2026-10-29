import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudUsage, billedChars, chirpVoiceId, cloudMonth, readCloudUsage, synthCloud } from "../src/cloudtts";
import { Pronouncer } from "../src/pronounce";
import { makeApp } from "./helpers/app";
const ob = require("obsidian");

// 假的 Audio：play 之後馬上播完
class FakeAudio {
	src = "";
	defaultPlaybackRate = 1;
	playbackRate = 1;
	private l: Record<string, (() => void)[]> = {};
	async play() {
		setTimeout(() => (this.l.ended ?? []).slice().forEach((f) => f()), 1);
	}
	pause() {}
	addEventListener(t: string, f: () => void) {
		(this.l[t] ??= []).push(f);
	}
	removeEventListener(t: string, f: () => void) {
		this.l[t] = (this.l[t] ?? []).filter((x) => x !== f);
	}
}
(globalThis as any).Audio = FakeAudio;

const MP3 = Buffer.from("ID3fake-mp3").toString("base64");

test("Google Cloud 語音：請求格式與回傳", async () => {
	let sent: any;
	ob.__setRequestHandler(async (r: any) => ((sent = r), { status: 200, text: "", json: { audioContent: MP3 } }));
	const buf = await synthCloud("ck", "Hello there.", "Kore");
	assert.equal(Buffer.from(buf).toString(), "ID3fake-mp3");
	assert.equal(sent.headers["x-goog-api-key"], "ck");
	const body = JSON.parse(sent.body);
	assert.deepEqual(body.voice, { languageCode: "en-US", name: "en-US-Chirp3-HD-Kore" });
	assert.equal(body.audioConfig.audioEncoding, "MP3");
	assert.equal(chirpVoiceId("en-GB-Chirp3-HD-Puck"), "en-GB-Chirp3-HD-Puck");
	ob.__setRequestHandler(async () => ({ status: 403, text: "{}", json: { error: { message: "API not enabled" } } }));
	await assert.rejects(synthCloud("ck", "x", "Kore"), (e: any) => e.kind === "auth" && /API not enabled/.test(e.message));
});

test("每月字數：所有裝置的紀錄加總、去重、只算這個月", async () => {
	const m = cloudMonth();
	const line = (id: string, chars: number, month = m) => JSON.stringify({ id, type: "tts", source: "cloud", chars, month });
	const { app } = makeApp(
		new Map([
			["logs/ray/ipad-1.jsonl", [line("a", 100), line("b", 50), line("old", 999, "2000-01")].join("\n") + "\n"],
			["logs/kid/win-1.jsonl", [line("c", 20), line("a", 100), '{"type":"tts","source":"gemini"}'].join("\n") + "\n"],
		]),
	);
	assert.equal(await readCloudUsage(app), 170);
	const u = new CloudUsage(app);
	assert.equal(await u.used(), 170);
	u.add(30);
	assert.equal(await u.used(), 200);
	assert.equal(billedChars("Hi 你好"), 5);
});

function pron(files: Map<string, string>, settings: object) {
	const { app } = makeApp(files);
	const logs: any[] = [];
	const notices: string[] = [];
	const p = new Pronouncer({
		app,
		deviceId: "ipad-1",
		settings: () => ({ dictAudio: false, geminiTts: true, ttsModel: "tts", ttsVoice: "Kore", ttsDailyCap: 10, cloudTts: true, cloudVoice: "Kore", cloudMonthlyCap: 1000, ...settings }) as any,
		apiKey: () => "gk",
		cloudKey: () => "ck",
		systemSpeak: async () => undefined,
		log: (source, extra) => logs.push({ source, ...extra }),
		notice: (m) => notices.push(m),
		debug: () => undefined,
	});
	return { p, logs, notices };
}

test("對話朗讀：先用 Google Cloud 語音、第一句先唸、記下字數", async () => {
	const urls: string[] = [];
	ob.__setRequestHandler(async (r: any) => (urls.push(r.url), { status: 200, text: "", json: { audioContent: MP3 } }));
	const { p, logs } = pron(new Map([["logs/ray/ipad-1.jsonl", ""]]), {});
	const ok = await p.speakNatural("That sounds great! What did you and your dog do at the park yesterday?");
	assert.equal(ok, true);
	assert.equal(urls.length, 2); // 切成兩句
	assert.ok(urls.every((u) => u.includes("texttospeech")));
	assert.deepEqual(logs.map((l) => [l.source, l.chars, l.noSave]), [
		["cloud", 18, true],
		["cloud", 51, true],
	]);
});

test("到每月上限就不再呼叫 Google Cloud，改用 Gemini", async () => {
	const urls: string[] = [];
	ob.__setRequestHandler(async (r: any) => {
		urls.push(r.url);
		return r.url.includes("texttospeech") ? { status: 200, text: "", json: { audioContent: MP3 } } : { status: 500, text: "busy", json: {} };
	});
	const m = cloudMonth();
	const used = JSON.stringify({ id: "x", type: "tts", source: "cloud", chars: 990, month: m });
	const { p, notices } = pron(new Map([["logs/ray/ipad-1.jsonl", used + "\n"]]), {});
	await p.speakNatural("This sentence is definitely longer than ten characters.");
	assert.ok(!urls.some((u) => u.includes("texttospeech")));
	assert.ok(urls.some((u) => u.includes("interactions"))); // 改試 Gemini
	assert.match(notices.join(), /上限/);
});
