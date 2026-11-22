// v0.23.2：AI 批改太慢（使用者 2026-11-22：kid 測試結果回應太慢）——4 秒沒回就再送一次、20 秒放棄、按鈕顯示秒數、記下花多久
import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { GRADE_HEDGE_MS, GRADE_TIMEOUT_MS, gradeListening, gradeTranslation } from "../src/grade";
import { PENDING_OFFLINE, PENDING_SLOW, PracticeView, pendingNote } from "../src/practice";
import { AIError, AIOptions } from "../src/ai";
import { renderBank } from "../src/generate";
import { makeApp, NO_MEMORY } from "./helpers/app";
import { sampleBank } from "./helpers/fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("批改都會 4 秒、10 秒沒回就再送一份，20 秒放棄", async () => {
	const seen: AIOptions[] = [];
	const ai = {
		id: "fake",
		model: "m",
		complete: async (_p: string, o?: AIOptions) => (seen.push(o!), { text: '{"score":90,"feedback":"好","corrected":"The boat is in the harbor."}', usage: {}, model: "m" }),
		chat: async () => ({ text: "", usage: {}, model: "m" }),
	};
	const q = { id: "t1", type: "translate" as const, prompt: "船停在港口。", reference: "The boat is in the harbor.", explanation: "" };
	assert.equal((await gradeTranslation(ai, q, "The boat is in the harbor.", "kid")).score, 90);
	assert.equal((await gradeListening(ai, "The boat is in the harbor.", "船停在港口。", "船在港口", "kid")).score, 90);
	assert.deepEqual(
		seen.map((o) => [o.hedgeAfterMs, o.timeoutMs]),
		[
			[[4000, 10000], 20000],
			[[4000, 10000], 20000],
		],
	);
	assert.deepEqual([GRADE_HEDGE_MS, GRADE_TIMEOUT_MS], [[4000, 10000], 20000]);
});

test("沒批改到時怎麼說：離線，還是 AI 太慢", () => {
	assert.equal(pendingNote(new Error("offline")), PENDING_OFFLINE);
	assert.equal(pendingNote(new AIError("AI 超過 20 秒沒有回應，請再送一次。", undefined, "", "network")), PENDING_SLOW);
	assert.match(PENDING_SLOW, /太慢.*下次開始練習時會自動批改/);
});

/** 句子翻譯的練習畫面；批改用的 AI 由測試控制什麼時候回來。 */
function translatePractice(reply: () => Promise<string>) {
	const { app, files } = makeApp(
		new Map([
			["english/bank/b1.md", renderBank(sampleBank(), "english/sources/Story")],
			["logs/ray/ipad-1.jsonl", ""],
		]),
	);
	const debugs: string[] = [];
	let n = 0;
	const plugin: any = {
		app,
		user: "ray",
		lang: "en",
		deviceId: "ipad-1",
		settings: { users: ["ray", "kid"], newPerDay: 10, fastModel: "fast-model" },
		userNames: () => ["ray", "kid"],
		chatMemoryOf: () => 50,
		...NO_MEMORY,
		levelOf: (u: string) => (u === "kid" ? "kid" : "adult"),
		getApiKey: () => "k",
		fastBackend: () => ({ complete: async () => ({ text: await reply(), usage: {}, model: "m" }) }),
		makeEntry(type: string, extra: Record<string, unknown> = {}, user?: string) {
			return { id: "e" + n++, ts: new Date().toISOString(), device: "ipad-1", user: user ?? this.user, type, ...extra };
		},
		appendLog: async (e: any) => void files.set(`logs/${e.user}/ipad-1.jsonl`, String(files.get(`logs/${e.user}/ipad-1.jsonl`) ?? "") + JSON.stringify(e) + "\n"),
		addPhrase: async () => undefined,
		addWord: async () => undefined,
		say: () => undefined,
		syncAndWait: async () => true,
		triggerSync: () => undefined,
		debug: (m: string) => debugs.push(m),
	};
	const view: any = new PracticeView({ app } as any, plugin);
	const entries = () =>
		String(files.get("logs/ray/ipad-1.jsonl") ?? "")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	const start = async () => {
		await view.onOpen();
		await sleep(30);
		const card = [...view.contentEl.querySelectorAll(".el-type-card")].find((c: any) => c.querySelector(".el-title").textContent === "句子翻譯") as any;
		card.querySelector("button").click();
		await sleep(30);
		view.contentEl.querySelector("textarea.el-answer").value = "The boat is in the harbor.";
		const send = [...view.contentEl.querySelectorAll("button")].find((b: any) => b.textContent === "送出") as HTMLButtonElement;
		send.click();
		return send;
	};
	return { view, entries, debugs, start };
}

test("句子翻譯：批改中按鈕顯示等了幾秒；回來後顯示分數，並記下花了多久", async () => {
	let release!: (s: string) => void;
	const x = translatePractice(() => new Promise((ok) => (release = ok)));
	const send = await x.start();
	assert.equal(send.textContent, "批改中…");
	assert.equal(send.disabled, true);
	assert.equal(x.view.contentEl.querySelector("textarea.el-answer").disabled, true, "等批改時不能再改答案");
	await sleep(1100);
	assert.equal(send.textContent, "批改中… 1 秒");
	release('{"score":85,"feedback":"很好","corrected":"The boat is in the harbor."}');
	await sleep(20);
	assert.equal(x.view.contentEl.querySelector(".el-verdict").textContent, "✓ 85 分");
	assert.equal(send.textContent, "已送出");
	const api = x.entries().find((e) => e.type === "api");
	assert.equal(api.purpose, "grade-translate");
	assert.equal(api.ok, true);
	assert.ok(api.ms >= 1000 && api.ms < 5000, String(api.ms));
	assert.deepEqual(x.debugs.filter((d) => d.startsWith("grade-")), [], "不到 6 秒不寫 debug");
	const ans = x.entries().find((e) => e.type === "answer");
	assert.deepEqual([ans.score, ans.correct, ans.pending], [85, true, undefined]);
});

test("句子翻譯：AI 太慢放棄了，就記成待批改、說明下次會自動批改，並留下紀錄", async () => {
	const x = translatePractice(() => Promise.reject(new AIError("AI 超過 20 秒沒有回應，請再送一次。", undefined, "", "network")));
	const send = await x.start();
	await sleep(20);
	assert.equal(x.view.contentEl.querySelector(".el-verdict").textContent, PENDING_SLOW);
	assert.equal(send.textContent, "已送出");
	assert.ok(x.view.contentEl.querySelector(".el-feedback").textContent.includes("The boat is in the harbor."), "照樣顯示參考答案");
	const ans = x.entries().find((e) => e.type === "answer");
	assert.equal(ans.pending, true);
	const api = x.entries().find((e) => e.type === "api");
	assert.deepEqual([api.purpose, api.ok], ["grade-translate", false]);
	assert.match(api.error, /20 秒/);
	assert.ok(x.debugs.some((d) => /^grade-translate failed: \d+ ms \(AI 超過 20 秒/.test(d)));
});

test("句子翻譯：離線時不送出、直接記成待批改（連上網路後補批）", async () => {
	const nav = globalThis.navigator as any;
	const before = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(nav), "onLine");
	Object.defineProperty(nav, "onLine", { configurable: true, get: () => false });
	try {
		let called = 0;
		const x = translatePractice(async () => (called++, "{}"));
		await x.start();
		await sleep(20);
		assert.equal(x.view.contentEl.querySelector(".el-verdict").textContent, PENDING_OFFLINE);
		assert.equal(called, 0);
		assert.equal(
			x.entries().filter((e) => e.type === "api").length,
			0,
			"沒送出就沒有 AI 紀錄",
		);
	} finally {
		delete nav.onLine;
		if (before) Object.defineProperty(Object.getPrototypeOf(nav), "onLine", before);
	}
});
