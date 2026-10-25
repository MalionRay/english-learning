import { test } from "node:test";
import assert from "node:assert/strict";
import { fitSize, mergeOcr, ocrImage, parseOcr } from "../src/ocr";
import { GeminiBackend } from "../src/ai";
const ob = require("obsidian");

test("照片縮小：長邊不超過上限、小圖不放大", () => {
	assert.deepEqual(fitSize(4032, 3024), { w: 1600, h: 1200 });
	assert.deepEqual(fitSize(3024, 4032), { w: 1200, h: 1600 });
	assert.deepEqual(fitSize(800, 600), { w: 800, h: 600 });
});

test("解析辨識結果、多頁合併", () => {
	const a = parseOcr('```json\n{"title":"A Walk","text":"Para one.\\n\\n\\n\\nPara two.","marked":["stroll"," stroll","",1]}\n```');
	assert.deepEqual(a, { title: "A Walk", text: "Para one.\n\nPara two.", marked: ["stroll"] });
	assert.equal(parseOcr("Just plain text").text, "Just plain text");
	const m = mergeOcr([a, { title: "", text: "Page two.", marked: ["meadow", "stroll"] }, { title: "", text: "", marked: [] }]);
	assert.equal(m.title, "A Walk");
	assert.equal(m.text, "Para one.\n\nPara two.\n\nPage two.");
	assert.deepEqual(m.marked, ["stroll", "meadow"]);
});

test("圖片以 inlineData 送給 Gemini", async () => {
	let sent: any;
	ob.__setRequestHandler(async (r: any) => {
		sent = JSON.parse(r.body);
		return { status: 200, text: "", json: { candidates: [{ content: { parts: [{ text: '{"title":"","text":"Hello world.","marked":[]}' }] } }] } };
	});
	const r = await ocrImage(new GeminiBackend("k", "ocr-model"), { mimeType: "image/jpeg", data: "QUJD" });
	assert.equal(r.text, "Hello world.");
	assert.deepEqual(sent.contents[0].parts[0], { inlineData: { mimeType: "image/jpeg", data: "QUJD" } });
	assert.match(sent.contents[0].parts[1].text, /Transcribe/);
	assert.equal(sent.generationConfig.responseMimeType, "application/json");
});
