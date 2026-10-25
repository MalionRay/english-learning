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
