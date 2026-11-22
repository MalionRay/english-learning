// v0.23.2：再送一份的時間可以排好幾份；不能用的回應（429、5xx）不能贏過還在跑的那份
// （使用者 2026-11-22：kid 的語音對話回應太慢——免費版偶爾一份卡 20～30 秒）
import { test } from "node:test";
import assert from "node:assert/strict";
import { AIError, GeminiBackend, HedgeStats, geminiVerdict, hedged, setRetryDelay } from "../src/ai";

const ob = require("obsidian");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 第 n 份在 after[n-1] 毫秒後回 value[n-1]（沒有寫就永遠不回）。 */
function copies<T>(after: (number | null)[], value: (n: number) => T) {
	const sent: number[] = [];
	const t0 = Date.now();
	const fn = () => {
		const n = sent.push(Date.now() - t0);
		const ms = after[n - 1];
		return new Promise<T>((ok) => {
			if (ms !== null && ms !== undefined) setTimeout(() => ok(value(n)), ms);
		});
	};
	return { fn, sent };
}

test("可以排好幾份：第一、二份都卡住時，第三份照時間送出、先回來的贏", async () => {
	const c = copies([null, null, 10], (n) => "r" + n);
	const stats: HedgeStats = { sent: 0, winner: 0 };
	assert.equal(await hedged(c.fn, [30, 80], 1000, undefined, stats), "r3");
	assert.equal(c.sent.length, 3);
	assert.ok(c.sent[1] >= 25 && c.sent[1] < 70, `第二份在 30 毫秒左右送（${c.sent[1]}）`);
	assert.ok(c.sent[2] >= 75 && c.sent[2] < 140, `第三份在 80 毫秒左右送，從第一份算（${c.sent[2]}）`);
	assert.deepEqual(stats, { sent: 3, winner: 3 });
});

test("第二份很快就回來了：不會再送第三份", async () => {
	const c = copies([null, 5, 5], (n) => "r" + n);
	assert.equal(await hedged(c.fn, [20, 60], 1000), "r2");
	await sleep(90);
	assert.equal(c.sent.length, 2);
});

test("一個數字的寫法照舊：最多兩份", async () => {
	const c = copies([null, null, 5], (n) => "r" + n);
	await assert.rejects(hedged(c.fn, 20, 120), (e: AIError) => e.kind === "network" && /沒有回應/.test(e.message));
	assert.equal(c.sent.length, 2);
});

test("很快就連不上：馬上送下一份，但總共不超過排好的份數", async () => {
	let n = 0;
	const fn = () => (++n < 3 ? Promise.reject(new Error("net")) : Promise.resolve("ok"));
	assert.equal(await hedged(fn, [1000, 2000], 3000), "ok");
	assert.equal(n, 3);
	n = 0;
	await assert.rejects(
		hedged(() => (++n, Promise.reject(new Error("down"))), [1000, 2000], 3000),
		/down/,
	);
	assert.equal(n, 3);
});

const res = (status: number) => ({ status });

test("另一份很快回了「超過每分鐘上限」：不能贏過還在跑的那份，也不再多送", async () => {
	// 第一份 60 毫秒後成功；第二份（20 毫秒送）馬上回 429
	const c = copies([60, 1, 1], (n) => (n === 1 ? res(200) : res(429)));
	const stats: HedgeStats = { sent: 0, winner: 0 };
	const r = await hedged(c.fn, [20, 40], 1000, geminiVerdict, stats);
	assert.equal(r.status, 200);
	assert.equal(c.sent.length, 2, "429 之後第三份就不送了");
	assert.deepEqual(stats, { sent: 2, winner: 1 });
});

test("另一份回了「伺服器忙」：等還在跑的、第三份照時間送", async () => {
	const c = copies([null, 1, 10], (n) => (n === 2 ? res(503) : res(200)));
	const r = await hedged(c.fn, [20, 50], 1000, geminiVerdict);
	assert.equal(r.status, 200);
	assert.equal(c.sent.length, 3);
});

test("都不能用：交回不能用的那個（「不要再送」的優先），讓呼叫的地方處理", async () => {
	const a = copies([1], () => res(503));
	assert.equal((await hedged(a.fn, [50], 1000, geminiVerdict)).status, 503, "沒有別的在跑：馬上交回（之後照舊等 1 秒重試）");
	assert.equal(a.sent.length, 1);
	const b = copies([30, 1], (n) => (n === 1 ? res(503) : res(429)));
	assert.equal((await hedged(b.fn, [10], 1000, geminiVerdict)).status, 429);
	// 逾時的時候手上已經有不能用的結果：交回它，比「逾時」清楚（例如今天額度用完要換模型）
	const c = copies([null, 1], () => res(429));
	assert.equal((await hedged(c.fn, [10], 80, geminiVerdict)).status, 429);
});

test("Gemini：很快回 429 的那份不會蓋掉慢一點的正常回覆；回覆記下送了幾份、用第幾份", async () => {
	setRetryDelay(1);
	const ok = { status: 200, text: "", json: { candidates: [{ content: { parts: [{ text: "hi" }] } }] } };
	const limit = { status: 429, text: '{"error":{"message":"Resource exhausted. Please retry in 30s."}}', json: {} };
	let n = 0;
	ob.__setRequestHandler(async () => (++n === 1 ? (await sleep(60), ok) : limit));
	const r = await new GeminiBackend("k", "m-hedge-429").complete("x", { hedgeAfterMs: [15, 30], timeoutMs: 1000 });
	assert.equal(r.text, "hi");
	assert.deepEqual([r.copies, r.winner, n], [2, 1, 2]);

	// 伺服器忙重試的那一輪也算進去：第一輪兩份都 503，第二輪第一份就好
	const busy = { status: 503, text: '{"error":{"message":"The model is overloaded."}}', json: {} };
	// 第一份 20 毫秒後才回 503，第二份（5 毫秒送）馬上 503 → 等 1 毫秒重試 → 第三份成功
	let m = 0;
	ob.__setRequestHandler(async () => (++m === 1 ? (await sleep(20), busy) : m === 2 ? busy : ok));
	const r2 = await new GeminiBackend("k", "m-hedge-503").complete("x", { hedgeAfterMs: [5], timeoutMs: 1000 });
	assert.equal(r2.text, "hi");
	assert.deepEqual([r2.copies, r2.winner, m], [3, 3, 3]);
});
