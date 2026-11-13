// v0.22.1：整份程式檢查後修正的問題（不依賴畫面的部分）
import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AIError, hedged } from "../src/ai";
import { convHeader, historyTurns, parseReply, salvageField, yamlName } from "../src/chat";
import { fillBlank, parseQuestions } from "../src/generate";
import { AppendOnlyWriter, trimDebugLog } from "../src/logs";
import { backupNow, listBackups, restoreBackup } from "../src/backup";
import { cachedZh, translateMany, wordsToPrefetch } from "../src/translate";
import { makeFix } from "../src/fixes";
import { WavRecorder } from "../src/recorder";
import { prefetchAudio } from "../src/audiocache";
import { convUser } from "../src/users";
import { makeApp } from "./helpers/app";
import { japaneseBank } from "./helpers/fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- AI 呼叫 ----------
test("hedged：第一次很快失敗後再送的那一次卡住，整體逾時還是會生效（不會永遠等下去）", async () => {
	let calls = 0;
	const fn = () => {
		calls++;
		if (calls === 1) return Promise.reject(new Error("net::ERR_FAILED"));
		return new Promise<string>(() => undefined); // 第二次永遠不回來
	};
	const t0 = Date.now();
	await assert.rejects(hedged(fn, 5000, 60), (e: AIError) => e instanceof AIError && e.kind === "network" && /沒有回應/.test(e.message));
	assert.equal(calls, 2);
	assert.ok(Date.now() - t0 < 1000, "逾時（60 毫秒）到了就結束");
});

test("hedged：原本的行為不變（慢了再送一次取先回來的；兩次都失敗才算失敗）", async () => {
	let calls = 0;
	const slowThenFast = () => (++calls === 1 ? new Promise<string>((ok) => setTimeout(() => ok("slow"), 200)) : Promise.resolve("fast"));
	assert.equal(await hedged(slowThenFast, 20, 1000), "fast");
	calls = 0;
	await assert.rejects(
		hedged(() => (calls++, Promise.reject(new Error("x" + calls))), 20, 1000),
		/x2/,
	);
	assert.equal(calls, 2);
	assert.equal(await hedged(() => Promise.resolve(7)), 7);
});

// ---------- 對話歷史 ----------
test("送給 AI 的歷史：從學習者的訊息開始時不黏上開場指令；從 AI 的訊息開始才補", () => {
	const m = (role: "user" | "model", text: string) => ({ role, text, ts: "t" });
	// 還沒有訊息：只有開場指令
	const empty = historyTurns([]);
	assert.equal(empty.length, 1);
	assert.match(empty[0].text, /just opened the chat/);
	// AI 開場 → 學習者 → AI：前面補開場指令
	const normal = historyTurns([m("model", "A1"), m("user", "U1"), m("model", "A2")]);
	assert.deepEqual(
		normal.map((t) => t.role),
		["user", "model", "user", "model"],
	);
	assert.match(normal[0].text, /just opened the chat/);
	// 只看最近 2 則，剛好從學習者開始：第一則就是那句話，沒有開場指令
	const windowed = historyTurns([m("model", "A1"), m("user", "U1"), m("model", "A2"), m("user", "U2"), m("model", "A3"), m("user", "U3")], 3);
	assert.deepEqual(
		windowed.map((t) => t.text),
		["U2", "A3", "U3"],
	);
	// 連續兩則學習者訊息（AI 那次沒回）合併成一則
	const merged = historyTurns([m("model", "A1"), m("user", "U1"), m("user", "U2")]);
	assert.equal(merged[merged.length - 1].text, "U1\nU2");
});

test("送給 AI 的歷史：空白的訊息不送（空白內容會讓整個請求被拒絕）", () => {
	const turns = historyTurns([
		{ role: "model", text: "A1", ts: "1" },
		{ role: "user", text: "U1", ts: "2" },
		{ role: "model", text: "", ts: "3" },
		{ role: "user", text: "U2", ts: "4" },
		{ role: "model", text: "   ", ts: "5" },
	]);
	assert.ok(turns.every((t) => t.text.trim()));
	assert.deepEqual(
		turns.slice(1).map((t) => t.text),
		["A1", "U1\nU2"],
	);
});

test("AI 回覆被截斷（不完整的 JSON）：把 reply 救出來，不顯示一堆大括號", () => {
	const cut = '{"correction": null, "howto": [], "reply": "Oh nice! I went hiking last week, and it was \\"great\\".", "replyZh": "喔，不錯！我上禮拜去';
	const r = parseReply(cut);
	assert.equal(r.reply, 'Oh nice! I went hiking last week, and it was "great".');
	assert.equal(r.replyZh, "喔，不錯！我上禮拜去");
	assert.equal(r.correction, null);
	// reply 本身寫到一半
	assert.equal(parseReply('{"correction":null,"howto":[],"reply":"I think that').reply, "I think that");
	// 斷在跳脫字元中間
	assert.equal(salvageField('{"reply":"caf\\u00e9 is nice \\u00', "reply"), "café is nice");
	// 還沒寫到 reply：當成沒有內容（畫面會請使用者再送一次）
	assert.equal(parseReply('{"correction": {"original": "I go", "corrected": "I we').reply, "");
	// 不像 JSON 的純文字照舊
	assert.equal(parseReply("Hello there!").reply, "Hello there!");
	// JSON 但不是物件
	assert.equal(parseReply('"just a string"').reply, "just a string");
	assert.equal(parseReply("[1,2]").reply, "");
	assert.equal(parseReply("null").reply, "");
});

test("對話檔的使用者名字：像數字或 true 的名字加引號，讀回來還是同一個人", () => {
	assert.equal(yamlName("ray"), "ray");
	assert.equal(yamlName("kid-2"), "kid-2");
	assert.equal(yamlName("2026"), '"2026"');
	assert.equal(yamlName("no"), '"no"');
	assert.equal(yamlName("true"), '"true"');
	const head = convHeader({ user: "2026", level: "adult", topic: "free", topicLabel: "自由聊天", device: "d", started: "s" });
	assert.match(head, /^user: "2026"$/m);
	assert.equal(convUser(head), "2026");
	assert.equal(convUser(convHeader({ user: "ray", level: "adult", topic: "free", topicLabel: "自由聊天", device: "d", started: "s" })), "ray");
});

// ---------- 題庫 ----------
test("克漏字填答案：答案裡有 $ 也照原樣填", () => {
	assert.equal(fillBlank("It costs ____ a day.", "$5"), "It costs $5 a day.");
	assert.equal(fillBlank("He said ____.", "$& and $'"), "He said $& and $'.");
	assert.equal(fillBlank("Tom ____ the window.", "opened"), "Tom opened the window.");
});

test("出題：兩個字的答案寫成「____ ____」併成一個空格；真的有兩個空格的題目不要", () => {
	const raw = JSON.stringify({
		questions: [
			{ type: "cloze", prompt: "She decided to ____ ____ the old habit.", options: ["give up", "take in", "put on", "set off"], answer: 0, explanation: "放棄" },
			{ type: "cloze", prompt: "He ____ the door and ____ the light.", options: ["closed", "ate", "sang", "drew"], answer: 0, explanation: "關" },
			{ type: "cloze", prompt: "The ___ was closed.", options: ["shop", "sky", "song", "soup"], answer: 0, explanation: "商店" },
		],
	});
	const res = parseQuestions(raw, () => 0.5);
	assert.deepEqual(
		res.questions.map((q) => q.prompt),
		["She decided to ____ the old habit.", "The ____ was closed."],
	);
	assert.ok(res.dropped.some((d) => /兩個以上的空格/.test(d.reason)));
});

test("日文克漏字「答案標錯」：答案換了，讀音也換成新答案的（AI 沒給就拿掉舊的）", async () => {
	const bank = japaneseBank();
	const cloze = bank.questions.find((q) => q.type === "cloze")!;
	const { app } = makeApp();
	let prompt = "";
	const ai = (reply: object): any => ({ complete: async (p: string) => ((prompt = p), { text: JSON.stringify(reply), usage: {}, model: "m" }) });
	const withReading = await makeFix(app, ai({ verdict: "fixed", answer: 2, answerReading: "かきます", answerRomaji: "kakimasu", explanation: "書きます", message: "已修正" }), bank, cloze, "答案標錯了");
	assert.equal(withReading.kind, "replaced");
	assert.match(prompt, /answerReading/);
	const q1: any = (withReading as any).question;
	assert.equal(q1.answer, 2);
	assert.equal(q1.answerReading, "かきます");
	assert.equal(q1.answerRomaji, "kakimasu");
	const without = await makeFix(app, ai({ verdict: "fixed", answer: 1, explanation: "食べます", message: "已修正" }), bank, cloze, "答案標錯了");
	const q2: any = (without as any).question;
	assert.equal(q2.answer, 1);
	assert.equal(q2.answerReading, undefined, "舊答案（散歩します）的讀音不能留著");
	assert.equal(q2.answerRomaji, undefined);
});

// ---------- 紀錄檔 ----------
test("除錯紀錄太長時只留最近的部分，從整行開始", () => {
	const lines = Array.from({ length: 200 }, (_, i) => `- 2026-11-01T00:00:00.000Z line ${String(i).padStart(3, "0")}\n`).join("");
	assert.equal(trimDebugLog(lines, 100_000, 50_000), lines, "沒超過就不動");
	const out = trimDebugLog(lines, 2000, 1000, new Date("2026-11-13T00:00:00Z"));
	assert.ok(out.length < 1200);
	const got = out.split("\n").filter(Boolean);
	assert.equal(got[0], "- 2026-11-13T00:00:00.000Z （較舊的除錯紀錄已清掉，只留最近的部分）");
	assert.ok(got.slice(1).every((l) => /^- 2026-11-01T00:00:00\.000Z line \d{3}$/.test(l)), "每一行都完整");
	assert.equal(got[got.length - 1], "- 2026-11-01T00:00:00.000Z line 199");
});

test("改寫檔案排在同一個佇列：前後的 append 都不會掉", async () => {
	const { app, files } = makeApp(new Map([["debug/ipad-1.md", "old-1\nold-2\nold-3\n"]]));
	const w = new AppendOnlyWriter(app);
	const a = w.append("debug/ipad-1.md", "new-4\n");
	const r = w.rewrite("debug/ipad-1.md", (t) => t.split("\n").filter(Boolean).slice(-2).join("\n") + "\n");
	const b = w.append("debug/ipad-1.md", "new-5\n");
	await Promise.all([a, r, b]);
	assert.equal(files.get("debug/ipad-1.md"), "old-3\nnew-4\nnew-5\n");
	assert.equal(await r, true);
	assert.equal(await w.rewrite("debug/ipad-1.md", (t) => t), false, "內容一樣就不寫");
	assert.equal(await w.rewrite("debug/none.md", () => "x"), false, "沒有這個檔就不建");
	assert.equal(files.has("debug/none.md"), false);
});

test("還原備份：只寫回外掛自己的資料夾", async () => {
	const { app, files } = makeApp(new Map<string, string>([["logs/ray/ipad-1.jsonl", '{"id":"a"}\n']]));
	const r = await backupNow(app, "ipad-1");
	// 備份檔被動過手腳：多了一個外掛資料夾以外的檔
	const data = JSON.parse(String(files.get(r.path)));
	data.files["Notes/evil.md"] = "should not be written";
	data.files[".obsidian/snippets/x.md"] = "nor this";
	data.files["english/sources/Back.md"] = "article";
	files.set(r.path, JSON.stringify(data));
	const res = await restoreBackup(app, listBackups(app).find((b) => b.file.path === r.path)!.file);
	assert.equal(res.created, 1);
	assert.equal(files.get("english/sources/Back.md"), "article");
	assert.equal(files.has("Notes/evil.md"), false);
	assert.equal(files.has(".obsidian/snippets/x.md"), false);
});

// ---------- 翻譯快取 ----------
test("兩個翻譯同時進行：後寫的不會把先寫的快取蓋掉", async () => {
	const { app } = makeApp();
	const gate: Record<string, () => void> = {};
	const ai: any = {
		complete: (p: string) =>
			new Promise((ok) => {
				const word = p.split("\n").pop()!.replace(/^\d+\. /, "");
				gate[word] = () => ok({ text: JSON.stringify({ zh: ["意思-" + word] }), usage: {}, model: "m" });
			}),
	};
	const a = translateMany(app, ai, ["harbor"]);
	const b = translateMany(app, ai, ["gentle"]);
	await sleep(5);
	gate.gentle(); // 後送的先回來、先寫快取
	await b;
	gate.harbor(); // 先送的後回來：寫的時候要重新讀快取
	await a;
	assert.equal(cachedZh(app, "harbor"), "意思-harbor");
	assert.equal(cachedZh(app, "gentle"), "意思-gentle", "之前這一筆會被蓋掉");
	assert.deepEqual(wordsToPrefetch(app, "The gentle harbor master smiled."), ["master", "smiled"]);
});

// ---------- 錄音 ----------
test("拿不到麥克風（沒給權限）：把已經開的 AudioContext 關掉", async () => {
	let closed = 0;
	let opened = 0;
	class FakeCtx {
		state = "running";
		sampleRate = 48000;
		constructor() {
			opened++;
		}
		async resume() {}
		async close() {
			closed++;
		}
	}
	(window as any).AudioContext = FakeCtx;
	Object.defineProperty(globalThis, "navigator", { value: { onLine: true, mediaDevices: { getUserMedia: async () => Promise.reject(new Error("NotAllowedError")) } }, configurable: true });
	const rec = new WavRecorder();
	await assert.rejects(rec.start(), /NotAllowedError/);
	assert.equal(opened, 1);
	assert.equal(closed, 1, "之前不會關，iOS 上漏幾次之後就再也錄不了音");
	assert.equal(rec.recording, false);
	Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
});

test("預先產生錄音：Google Cloud 語音做的也算進「新增」", async () => {
	const order = ["cloud", "dict", "none"];
	const pron: any = { has: (t: string) => t === "have it", ensure: async () => order.shift() };
	const texts = ["have it", "a", "b", "c"].map((text) => ({ text, qids: [] }));
	const r = await prefetchAudio(pron, texts, undefined, undefined, 1);
	assert.equal(r.made, 2, "cloud 和 dict 各一個（之前 cloud 不算）");
	assert.equal(r.already, 1);
});

// ---------- 同步 ----------
test("結束並同步：前面等自動同步等了很久，接著觸發的那次同步也要等到結束才算完成", async () => {
	const { syncWithProbe } = await import("../src/syncwait");
	// 假的時鐘與 Remotely Save：自動同步跑到第 10 秒；觸發後 0.5 秒開始、再跑 20 秒
	let t = 0;
	const rs = { isSyncing: true };
	let triggeredAt = -1;
	const sleep = async (ms: number) => {
		t += ms;
		if (triggeredAt < 0) rs.isSyncing = t < 10_000;
		else rs.isSyncing = t >= triggeredAt + 500 && t < triggeredAt + 20_500;
	};
	const status: string[] = [];
	const r = await syncWithProbe(rs, async () => ((triggeredAt = t), true), { maxMs: 90_000, sleep, now: () => t, onStatus: (s) => status.push(s) });
	assert.equal(r, "done");
	assert.ok(triggeredAt >= 10_000, "自動同步結束後才觸發");
	assert.ok(t >= triggeredAt + 20_500, `要等到觸發的那次同步結束（之前在 ${triggeredAt} 毫秒就回報完成）`);
	assert.ok(status.some((s) => /等待進行中的同步/.test(s)) && status.some((s) => /^同步中/.test(s)));
});

test("結束並同步：沒觸發成功、超過時間", async () => {
	const { syncWithProbe } = await import("../src/syncwait");
	let t = 0;
	const idle = { isSyncing: false };
	assert.equal(await syncWithProbe(idle, async () => false, { maxMs: 1000, sleep: async (ms) => void (t += ms), now: () => t }), "not-triggered");
	// 一直在同步：超過時間就回報 timeout（畫面會請使用者確認）
	t = 0;
	const stuck = { isSyncing: true };
	assert.equal(await syncWithProbe(stuck, async () => true, { maxMs: 5000, sleep: async (ms) => void (t += ms), now: () => t }), "timeout");
	// 觸發了但它覺得沒事要做（isSyncing 沒有變）：等 3 秒就算完成
	t = 0;
	assert.equal(await syncWithProbe(idle, async () => true, { maxMs: 90_000, sleep: async (ms) => void (t += ms), now: () => t }), "done");
	assert.ok(t >= 3000 && t < 4000);
});
