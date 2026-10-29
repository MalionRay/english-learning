import { test } from "node:test";
import assert from "node:assert/strict";
import { AIError, GeminiBackend, classifyError } from "../src/ai";
const ob = require("obsidian");

test("錯誤訊息轉成中文", () => {
	assert.equal(classifyError(429, "Quota exceeded for metric generate_requests_per_minute", "m1").kind, "minute");
	assert.equal(classifyError(400, "API key not valid", "m1").kind, "auth");
	assert.equal(classifyError(404, "", "m1").kind, "model");
	assert.equal(classifyError(503, "", "m1").kind, "server");
});

test("每日額度用完後，當天不再呼叫", async () => {
	let calls = 0;
	ob.__setRequestHandler(async () => {
		calls++;
		return { status: 429, text: '{"error":{"message":"Quota exceeded: GenerateRequestsPerDayPerProjectPerModel"}}', json: {} };
	});
	const ai = new GeminiBackend("k", "daily-test-model");
	await assert.rejects(ai.complete("hi"), (e: AIError) => e.kind === "daily");
	await assert.rejects(ai.complete("hi"), (e: AIError) => e.kind === "daily");
	assert.equal(calls, 1);
});

test("沒有網路", async () => {
	ob.__setRequestHandler(async () => {
		throw new Error("net::ERR_INTERNET_DISCONNECTED");
	});
	await assert.rejects(new GeminiBackend("k", "net-model").complete("hi"), (e: AIError) => e.kind === "network");
});

test("快速模型不能用時改用主要模型", async () => {
	const { AIError: E, FallbackBackend } = require("../src/ai");
	const mk = (model: string, fail?: string) => ({
		id: "x",
		model,
		complete: async () => {
			if (fail) throw new E("x", 404, "", fail);
			return { text: model, usage: {}, model };
		},
		chat: async () => {
			if (fail) throw new E("x", 404, "", fail);
			return { text: model, usage: {}, model };
		},
	});
	const used: string[] = [];
	assert.equal((await new FallbackBackend(mk("fast", "model"), mk("main"), (e: any) => used.push(e.kind)).complete("hi")).text, "main");
	assert.equal((await new FallbackBackend(mk("fast", "daily"), mk("main")).chat([])).text, "main");
	assert.equal((await new FallbackBackend(mk("fast"), mk("main")).chat([])).text, "fast");
	await assert.rejects(new FallbackBackend(mk("fast", "auth"), mk("main")).complete("hi")); // API key 錯就不用再試
	assert.deepEqual(used, ["model"]);
});

test("Google 伺服器忙：自動重試一次，還是不行就改用主要模型", async () => {
	const { GeminiBackend: G, FallbackBackend: F, setRetryDelay } = require("../src/ai");
	setRetryDelay(1);
	const ok = { status: 200, text: "", json: { candidates: [{ content: { parts: [{ text: "hi" }] } }] } };
	const busy = { status: 503, text: '{"error":{"message":"The model is overloaded."}}', json: {} };
	let seq = [busy, ok];
	ob.__setRequestHandler(async () => seq.shift());
	assert.equal((await new G("k", "m-busy-1").complete("x")).text, "hi");
	seq = [busy, busy];
	await assert.rejects(new G("k", "m-busy-2").complete("x"), (e: any) => e.kind === "server");
	// 快速模型一直忙 → 主要模型
	const calls: string[] = [];
	ob.__setRequestHandler(async (r: any) => (calls.push(r.url.includes("fast-busy") ? "fast" : "main"), r.url.includes("fast-busy") ? busy : ok));
	assert.equal((await new F(new G("k", "fast-busy"), new G("k", "main-ok")).complete("x")).text, "hi");
	assert.deepEqual(calls, ["fast", "fast", "main"]);
});
