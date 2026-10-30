import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sortVoices, voiceLabel } from "../src/tts";
import { noticeMeaning } from "../src/translate";
import { makeApp } from "./helpers/app";
const ob = require("obsidian");

test("語音選單：高品質排前面並標出來", () => {
	const v = (name: string, voiceURI: string, lang = "en-US") => ({ name, voiceURI, lang }) as any;
	const list = sortVoices([v("Fred", "x"), v("Daniel", "y", "en-GB"), v("Ava", "com.apple.voice.premium.en-US.Ava"), v("Zoe", "com.apple.voice.enhanced.en-US.Zoe")]);
	assert.deepEqual(list.map((x: any) => x.name), ["Ava", "Zoe", "Fred", "Daniel"]);
	assert.equal(voiceLabel(list[0]), "Ava（en-US，高品質）");
});

test("看中文意思：先顯示查詢中，查到後更新", async () => {
	const { app } = makeApp();
	const before = ob.__notices.length;
	let resolve: (v: unknown) => void = () => undefined;
	const ai: any = { complete: () => new Promise((ok) => (resolve = ok)) };
	const p = noticeMeaning(app, () => ai, "harbor");
	assert.equal(ob.__notices[before], "harbor：查詢中…"); // 馬上有反應
	resolve({ text: '{"zh":["(n.) 港口"]}', usage: {}, model: "m" });
	await p;
	await noticeMeaning(app, () => ai, "harbor"); // 第二次用快取
	assert.equal(ob.__notices[ob.__notices.length - 1], "harbor：(n.) 港口");
});

test("看中文意思：顯示在字的旁邊，再按一次收起來", async () => {
	const { inlineMeaning } = require("../src/translate");
	const { app } = makeApp();
	const line = document.createElement("div");
	const w = document.createElement("span");
	w.textContent = "gentle";
	line.appendChild(w);
	line.appendChild(document.createTextNode(" voice"));
	const ai: any = { complete: async () => ({ text: '{"zh":["(adj.) 溫柔的"]}', usage: {}, model: "m" }) };
	await inlineMeaning(app, () => ai, "gentle", w);
	assert.equal(line.textContent, "gentle(adj.) 溫柔的 voice");
	await inlineMeaning(app, () => ai, "gentle", w); // 再按一次收起來
	assert.equal(line.textContent, "gentle voice");
});

test("預先查回覆裡的字：跳過常見字、短字、已查過的，一次查完", async () => {
	const { wordsToPrefetch, prefetchMeanings, cachedZh } = require("../src/translate");
	const { app } = makeApp();
	assert.deepEqual(wordsToPrefetch(app, "Oh nice! I went hiking with my dog's friends at the lake."), ["nice", "went", "hiking", "dog", "friends", "lake"]);
	let calls = 0;
	const ai: any = { complete: async (p: string) => (calls++, { text: JSON.stringify({ zh: p.split("\n").map((l) => "意思-" + l.replace(/^\d+\. /, "")) }), usage: {}, model: "m" }) };
	assert.equal(await prefetchMeanings(app, ai, "Hiking near the lake"), 3);
	assert.equal(calls, 1);
	assert.equal(cachedZh(app, "Hiking"), "意思-hiking"); // 大小寫不同也查得到
	assert.equal(await prefetchMeanings(app, ai, "hiking lake"), 0); // 已查過不再呼叫
	assert.equal(calls, 1);
});
