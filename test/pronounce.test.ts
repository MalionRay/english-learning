// v0.22.1：語音播放的順序問題（最後點的才播）、字典錄音播不出來不算字典掛掉
import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pronouncer, stopAudio } from "../src/pronounce";
import { makeApp } from "./helpers/app";
const ob = require("obsidian");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 記下每次播放的是哪一段聲音（用內容辨認）
const blobs = new Map<string, Blob>();
let blobSeq = 0;
(URL as any).createObjectURL = (b: Blob) => {
	const id = `blob:test-${blobSeq++}`;
	blobs.set(id, b);
	return id;
};
(URL as any).revokeObjectURL = () => undefined;

let plays: string[] = [];
let failNextPlay: Error | null = null;
class FakeAudio {
	src = "";
	defaultPlaybackRate = 1;
	playbackRate = 1;
	private l: Record<string, (() => void)[]> = {};
	async play() {
		if (failNextPlay) {
			const e = failNextPlay;
			failNextPlay = null;
			throw e;
		}
		plays.push(this.src);
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

/** 播過的聲音內容（依播放順序）。 */
async function played(): Promise<string[]> {
	const out: string[] = [];
	for (const src of plays) out.push(blobs.has(src) ? await blobs.get(src)!.text() : src);
	return out;
}

function pron(settings: object = {}) {
	const { app, files } = makeApp();
	const spoken: string[] = [];
	const debug: string[] = [];
	const logs: any[] = [];
	const p = new Pronouncer({
		app,
		deviceId: "ipad-1",
		settings: () => ({ dictAudio: false, geminiTts: false, ttsModel: "tts", ttsVoice: "Kore", ttsDailyCap: 10, cloudTts: true, cloudVoice: "Kore", cloudMonthlyCap: 100000, ...settings }) as any,
		apiKey: () => "gk",
		cloudKey: () => "ck",
		systemSpeak: async (t: string) => void spoken.push(t),
		log: (source, extra) => logs.push({ source, ...extra }),
		notice: () => undefined,
		debug: (m: string) => debug.push(m),
	});
	return { p, files, spoken, debug, logs };
}

/** Google Cloud 語音的假伺服器：回傳「audio:<文字>」；文字裡有 slow 的慢 60 毫秒。 */
function cloudServer() {
	const calls: string[] = [];
	ob.__setRequestHandler(async (r: any) => {
		const text = JSON.parse(r.body).input.text as string;
		calls.push(text);
		if (/slow/.test(text)) await sleep(60);
		return { status: 200, text: "", json: { audioContent: Buffer.from(`audio:${text}`).toString("base64") } };
	});
	return calls;
}

test("最後點的才播：先點的那段比較慢回來時，不會蓋掉後來正在聽的", async () => {
	plays = [];
	const { p, spoken } = pron();
	const calls = cloudServer();
	const a = p.pronounce("a slow sentence"); // 先點，60 毫秒後才拿到聲音
	await sleep(5);
	const b = await p.pronounce("a quick one"); // 後點，馬上有
	assert.equal(b, "cloud");
	assert.equal(await a, "cloud");
	assert.deepEqual(await played(), ["audio:a quick one"], "慢的那段回來後不播");
	assert.deepEqual(spoken, [], "也不會改用系統語音補唸舊的");
	assert.deepEqual(calls, ["a slow sentence", "a quick one"]);
	// 慢的那段錄音有存起來：再點一次馬上從快取播
	assert.equal(p.has("a slow sentence"), true);
	plays = [];
	assert.equal(await p.pronounce("a slow sentence"), "cache");
	assert.deepEqual(await played(), ["audio:a slow sentence"]);
	assert.equal(calls.length, 2, "沒有再呼叫一次");
});

test("同一段點兩次：第二次不重新產生，回來之後照樣播", async () => {
	plays = [];
	const { p } = pron();
	const calls = cloudServer();
	const a = p.pronounce("slow again");
	const b = p.pronounce("slow again");
	await Promise.all([a, b]);
	assert.equal(calls.length, 1);
	assert.deepEqual(await played(), ["audio:slow again"]);
});

test("按了停止之後，還在路上的聲音回來也不播", async () => {
	plays = [];
	const { p, spoken } = pron();
	cloudServer();
	const a = p.pronounce("slow to stop");
	await sleep(5);
	stopAudio();
	await a;
	assert.deepEqual(await played(), []);
	assert.deepEqual(spoken, []);
});

test("AI 回覆的自然語音正要唸時，使用者點了別的字：回覆不再唸（也不改用系統語音唸）", async () => {
	plays = [];
	const { p } = pron();
	cloudServer();
	const natural = p.speakNatural("This slow reply has two parts. Here is the second part of it.");
	await sleep(5);
	await p.pronounce("harbor"); // 回覆還在產生時點了一個字
	assert.equal(await natural, true, "回傳 true＝已處理，對話畫面不會再用系統語音唸一次");
	assert.deepEqual(await played(), ["audio:harbor"]);
});

test("自然語音沒被打斷時照常依序唸完", async () => {
	plays = [];
	const { p } = pron();
	cloudServer();
	assert.equal(await p.speakNatural("First part here. Second part there."), true);
	const got = await played();
	assert.ok(got.length >= 1);
	assert.equal(got.join(" ").replace(/audio:/g, ""), "First part here. Second part there.");
});

test("字典的真人錄音拿到了但播不出來：不算字典掛掉，下一個字照樣查字典", async () => {
	plays = [];
	const { p, spoken, debug } = pron({ dictAudio: true, cloudTts: false });
	const asked: string[] = [];
	ob.__setRequestHandler(async (r: any) => {
		const url: string = typeof r === "string" ? r : r.url;
		if (url.includes("dictionaryapi.dev")) {
			const w = decodeURIComponent(url.split("/").pop()!);
			asked.push(w);
			return { status: 200, text: "", json: [{ phonetics: [{ audio: `https://audio.example/${w}-us.mp3` }] }] };
		}
		const w = url.split("/").pop()!.replace("-us.mp3", "");
		return { status: 200, arrayBuffer: new TextEncoder().encode(`dict:${w}`).buffer };
	});
	failNextPlay = Object.assign(new Error("The element has no supported sources."), { name: "NotSupportedError" });
	assert.equal(await p.pronounce("harbor"), "system", "播不出來就往下試，最後用系統語音");
	assert.deepEqual(spoken, ["harbor"]);
	assert.ok(debug.some((d) => /play dict failed harbor/.test(d)));
	assert.ok(!debug.some((d) => /一小時內不再嘗試字典/.test(d)), "之前會把字典停用一小時");
	// 下一個字：照樣查字典、播真人錄音
	assert.equal(await p.pronounce("gentle"), "dict");
	assert.deepEqual(asked, ["harbor", "gentle"]);
	assert.deepEqual(await played(), ["dict:gentle"]);
});

test("字典伺服器真的出錯時，才一小時內不再嘗試", async () => {
	plays = [];
	const { p, debug } = pron({ dictAudio: true, cloudTts: false });
	let asked = 0;
	ob.__setRequestHandler(async () => (asked++, { status: 502, text: "", json: {} }));
	assert.equal(await p.pronounce("priority"), "system");
	assert.equal(await p.pronounce("uproar"), "system");
	assert.equal(asked, 1, "第二個字不再問字典");
	assert.ok(debug.some((d) => /一小時內不再嘗試字典/.test(d)));
});
