import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSpeedRows, pickCompareModels, runSpeedTest } from "../src/speedtest";
import { splitForSpeech } from "../src/pronounce";
const ob = require("obsidian");

test("挑比較用的模型：只要文字用的 flash", () => {
	const names = ["models/gemini-3.5-flash-lite", "models/gemini-3.8-flash", "models/gemini-3.8-flash-lite", "models/gemini-3.8-flash-lite-tts", "models/gemini-3.6-flash", "models/text-embedding-004", "models/gemini-3.8-flash-image"];
	assert.deepEqual(pickCompareModels(names, "gemini-3.5-flash-lite"), ["gemini-3.8-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash"]);
});

test("速度測試：每一步都有結果，失敗也記下來", async () => {
	ob.__setRequestHandler(async () => ({ status: 200, json: { models: [{ name: "models/gemini-9-flash" }] } }));
	let n = 0;
	const backend = (m: string) =>
		({
			id: "f",
			model: m,
			complete: async () => ({ text: "OK", usage: { outputTokens: 1 }, model: m }),
			chat: async (_t: unknown, o: any) => {
				n++;
				if (o.generationExtra?.thinkingConfig) throw new Error("HTTP 400 unknown field");
				return { text: "{}", usage: { outputTokens: 50 }, model: m };
			},
		}) as any;
	const rows = await runSpeedTest("k", "m1", () => undefined, backend, { model: "tts", bench: async () => ({ ms: 5, decodeMs: 1, bytes: 10 }) });
	assert.deepEqual(rows.map((r) => [r.label, r.model, r.ok]), [
		["網路來回（列出模型）", "-", true],
		["最短的生成", "m1", true],
		["對話大小（第 1 次）", "m1", true],
		["對話大小（第 2 次）", "m1", true],
		["對話＋thinkingLevel minimal", "m1", true],
		["對話＋thinkingConfig minimal", "m1", false],
		["對話大小", "gemini-9-flash", true],
		["自然語音（解碼 0.0 秒）", "tts", true],
	]);
	assert.match(formatSpeedRows(rows), /✗ 對話＋thinkingConfig minimal｜m1｜.*HTTP 400/);
});

test("語音先唸第一句", () => {
	assert.deepEqual(splitForSpeech("That's great! What did you and your dog do at the park yesterday?"), ["That's great!", "What did you and your dog do at the park yesterday?"]);
	assert.deepEqual(splitForSpeech("Hi there."), ["Hi there."]);
	assert.deepEqual(splitForSpeech("Hi! How are you doing today, my friend? I hope all is going well."), ["Hi! How are you doing today, my friend?", "I hope all is going well."]);
	assert.deepEqual(splitForSpeech(""), []);
});
