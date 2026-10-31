import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords, matchAnswer, normWord, tokenize, toHiragana } from "../src/lang";
import { markWords, parseQuestions, renderBank, systemPrompt, wordCount } from "../src/generate";
import { buildWordBook, wordKey, wordQid } from "../src/words";
import { buildPhraseBook, chatSystemPrompt, failedSentenceMap, parseReply, phraseKey, TOPICS } from "../src/chat";
import { mentionsWord } from "../src/chattargets";
import { estimateChatLevel, messageScore } from "../src/chatlevel";
import { dictationItems } from "../src/dictation";
import { audioKey } from "../src/pronounce";
import { KANA } from "../src/kana";
import { defaultVoice } from "../src/tts";
import { cachedReading, cachedZh, readingMany, translateMany } from "../src/translate";
import { makeApp } from "./helpers/app";
import { japaneseBank, sampleBank, spanishBank } from "./helpers/fixtures";

test("分字：英文、西班牙文用空白，日文用 Intl.Segmenter", () => {
	const es = tokenize("¿Dónde está el café?", "es").filter((t) => t.word).map((t) => t.text);
	assert.deepEqual(es, ["Dónde", "está", "el", "café"]);
	const ja = tokenize("私は学生です。", "ja").filter((t) => t.word).map((t) => t.text);
	assert.deepEqual(ja, ["私", "は", "学生", "です"]);
	assert.equal(tokenize("私は学生です。", "ja").map((t) => t.text).join(""), "私は学生です。"); // 不會掉字
	assert.equal(countWords("Quiero comprar dos mangos.", "es"), 4);
	assert.equal(wordCount("The cat sat.", "en"), 3);
});

test("打字答案：西班牙文只差重音也算對（會提醒）；日文漢字、假名、片假名、羅馬拼音都可以", () => {
	assert.deepEqual(matchAnswer("Está", "está", "es"), { ok: true });
	assert.deepEqual(matchAnswer("esta", "está", "es"), { ok: true, accentOnly: true });
	assert.equal(matchAnswer("es", "está", "es").ok, false);
	const alt = { reading: "さんぽします", romaji: "sanpo shimasu" };
	assert.ok(matchAnswer("散歩します", "散歩します", "ja", alt).ok);
	assert.ok(matchAnswer("さんぽします", "散歩します", "ja", alt).ok);
	assert.ok(matchAnswer("サンポシマス", "散歩します", "ja", alt).ok);
	assert.ok(matchAnswer("sanposhimasu", "散歩します", "ja", alt).ok);
	assert.ok(matchAnswer("Sanpo Shimasu", "散歩します", "ja", alt).ok);
	assert.ok(!matchAnswer("tabemasu", "散歩します", "ja", alt).ok);
	assert.ok(matchAnswer("toukyou", "東京", "ja", { romaji: "tōkyō" }).ok);
	assert.ok(matchAnswer("tokyo", "東京", "ja", { romaji: "tōkyō" }).ok);
	assert.equal(toHiragana("カタカナ"), "かたかな");
});

test("出題提示：西班牙文用墨西哥用法；日文要讀音與羅馬拼音", () => {
	assert.match(systemPrompt("adult", "es"), /Mexic/);
	assert.match(systemPrompt("adult", "es"), /never vosotros/);
	const ja = systemPrompt("adult", "ja");
	assert.match(ja, /"reading"/);
	assert.match(ja, /"answerReading"/);
	assert.match(ja, /COMPLETE BEGINNER/);
	assert.doesNotMatch(systemPrompt("adult", "en"), /answerReading/); // 英文不變
});

test("解析日文題目：讀音、羅馬拼音、克漏字答案讀音都保留", () => {
	const raw = JSON.stringify({
		questions: [
			{ type: "vocab", direction: "en2zh", word: "天気", reading: "てんき", romaji: "tenki", context: "今日はとても天気がいいです。", prompt: "天気", options: ["天氣", "電車", "朋友", "早餐"], answer: 0, explanation: "x" },
			{ type: "cloze", prompt: "毎朝、公園を____。", options: ["散歩します", "食べます", "書きます", "読みます"], answer: 0, answerReading: "さんぽします", answerRomaji: "sanpo shimasu", explanation: "x" },
		],
	});
	const { questions } = parseQuestions(raw, () => 0, "ja");
	const v = questions.find((q) => q.type === "vocab") as any;
	const c = questions.find((q) => q.type === "cloze") as any;
	assert.equal(v.reading, "てんき");
	assert.equal(v.romaji, "tenki");
	assert.equal(c.answerReading, "さんぽします");
	assert.equal(c.answerRomaji, "sanpo shimasu");
});

test("標記生字：日文直接找字；西班牙文認得重音字母的邊界", () => {
	assert.equal(markWords("今日はとても天気がいいです。", ["天気"], "ja").text, "今日はとても==天気==がいいです。");
	assert.deepEqual(markWords("今日は晴れです。", ["雨"], "ja").notFound, ["雨"]);
	assert.equal(markWords("Mi café está frío.", ["café"], "es").text, "Mi ==café== está frío.");
});

test("題庫檔：外語的朗讀標籤帶 lang、日文顯示讀音", () => {
	const md = renderBank(japaneseBank(), "english/sources/Tenki");
	assert.match(md, /<span class="el-say" lang="ja">天気<\/span>/);
	assert.match(md, /てんき（tenki）/);
	assert.match(md, /^lang: ja$/m);
	assert.match(md, /翻成日文/);
	const en = renderBank(sampleBank(), "english/sources/Story");
	assert.doesNotMatch(en, /lang="/); // 英文題庫格式不變
});

test("生字本：每種語言分開，qid 加語言前綴；英文的 key 不變", () => {
	assert.equal(wordKey("Harbor"), "harbor");
	assert.equal(wordKey("Mercado", "es"), "es:mercado");
	assert.equal(wordKey("天気", "ja"), "ja:天気");
	assert.equal(wordQid(wordKey("天気", "ja")), "word:ja:天気");
	const logs = [
		{ id: "1", ts: "2026-01-05T00:00:00Z", type: "word-add", word: "casa", lang: "es" },
		{ id: "2", ts: "2026-01-05T00:00:00Z", type: "word-add", word: "boat" },
	] as any;
	const banks = [sampleBank(), spanishBank(), japaneseBank()];
	const es = buildWordBook(banks, logs, "es").map((w) => w.key).sort();
	assert.deepEqual(es, ["es:casa", "es:mercado"]);
	const en = buildWordBook(banks, logs, "en").map((w) => w.key);
	assert.ok(en.includes("boat") && en.includes("harbor") && !en.includes("es:casa"));
	const ja = buildWordBook(banks, logs, "ja");
	assert.deepEqual(ja.map((w) => [w.key, w.ipa]), [["ja:天気", "てんき（tenki）"]]);
});

test("句子本：每種語言分開，同一句不同語言的 key 也不同", () => {
	assert.notEqual(phraseKey("no", "en"), phraseKey("no", "es"));
	assert.equal(phraseKey("I like it."), phraseKey("I like it.", "en")); // 英文不變
	const banks = [sampleBank(), spanishBank()];
	const failed = failedSentenceMap(banks.flatMap((b) => b.questions.map((q) => ({ q, bank: b }))));
	const logs = [
		{ id: "a1", ts: "2026-01-06T00:00:00Z", type: "answer", qid: "es-c1", correct: false },
		{ id: "a2", ts: "2026-01-06T00:00:00Z", type: "answer", qid: "c1", correct: false },
		{ id: "p1", ts: "2026-01-06T00:00:00Z", type: "phrase-add", key: "k", zh: "我想要咖啡", en: "Quiero un café", lang: "es", source: "howto" },
	] as any;
	assert.deepEqual(buildPhraseBook(logs, failed, "es").map((p) => p.en).sort(), ["Ella está muy cansada después del viaje.", "Quiero un café"]);
	assert.deepEqual(buildPhraseBook(logs, failed, "en").map((p) => p.en), ["Tom opened the window because the room was hot."]);
});

test("對話提示：西班牙文 Sofía（墨西哥）、日文結衣並回傳讀音；英文不變", () => {
	const es = chatSystemPrompt("adult", TOPICS[0], undefined, "es");
	assert.match(es, /Sofía/);
	assert.match(es, /Mexican Spanish/);
	const ja = chatSystemPrompt("adult", TOPICS[0], undefined, "ja");
	assert.match(ja, /Yui/);
	assert.match(ja, /replyRomaji/);
	assert.match(ja, /ROMAJI/);
	assert.match(chatSystemPrompt("adult", TOPICS[0]), /You are Alex/);
	const r = parseReply(JSON.stringify({ correction: null, howto: [{ zh: "謝謝", en: "ありがとう", reading: "ありがとう", romaji: "arigatou" }], reply: "こんにちは！", replyZh: "你好！", replyReading: "こんにちは！", replyRomaji: "konnichiwa!" }));
	assert.equal(r.replyRomaji, "konnichiwa!");
	assert.equal(r.howto[0].romaji, "arigatou");
});

test("對話裡用到複習的字：日文直接找字、西班牙文認得重音", () => {
	assert.ok(mentionsWord("今日は天気がいいですね", { en: "天気", forms: [] }, "ja"));
	assert.ok(!mentionsWord("今日は雨です", { en: "天気", forms: [] }, "ja"));
	assert.ok(mentionsWord("Fui al mercado ayer", { en: "mercado", forms: [] }, "es"));
	assert.ok(!mentionsWord("Fui a la escuela", { en: "mercado", forms: [] }, "es"));
});

test("對話程度：日文從「很簡單」開始；只有漢字（中文）的訊息算不會說，有假名或羅馬拼音的不算", () => {
	assert.equal(estimateChatLevel([], "adult", 10, "ja").level, 1);
	const ok = '{"correction":null,"howto":[],"reply":"いいですね","replyZh":"不錯"}';
	assert.equal(messageScore("我想去公園", ok, "ja"), 0.15);
	assert.ok(messageScore("私は公園に行きます", ok, "ja") > 0.5);
	assert.ok(messageScore("watashi wa koen ni ikimasu", ok, "ja") > 0.5);
});

test("聽力句子：外語的 id 和英文不同；錄音 key 英文不變", () => {
	const items = dictationItems([...spanishBank().questions.map((q) => ({ q, bank: spanishBank() }))]);
	assert.ok(items.length > 0 && items.every((x) => x.lang === "es"));
	assert.equal(items[0].id, "listen:" + audioKey(items[0].text, "es"));
	assert.notEqual(audioKey("no", "es"), audioKey("no"));
	assert.equal(audioKey("Hello"), audioKey("hello", "en"));
});

test("假名：平假名、片假名各 46 個，id 不重複", () => {
	assert.equal(KANA.length, 92);
	assert.equal(new Set(KANA.map((k) => k.id)).size, 92);
	assert.ok(KANA.every((k) => k.romaji && k.example));
});

test("系統語音：西班牙文挑墨西哥／美國，日文挑日本", () => {
	const v = (name: string, lang: string) => ({ name, lang, voiceURI: name, localService: true, default: false }) as SpeechSynthesisVoice;
	const voices = [v("Mónica", "es-ES"), v("Paulina", "es-MX"), v("Kyoko", "ja-JP")];
	assert.equal(defaultVoice(voices, "es")?.name, "Paulina");
	assert.equal(defaultVoice(voices.filter((x) => x.lang.startsWith("ja")), "ja")?.name, "Kyoko");
});

test("檢查修正：日文讀音分批查（避免回覆被截斷），快取不會互相蓋掉", async () => {
	const { readingBatches, READING_BATCH } = await import("../src/translate");
	const items = Array.from({ length: 20 }, (_, i) => ({ t: "今日はいい天気です。".repeat(i === 3 ? 70 : 1) }));
	const batches = readingBatches(items);
	assert.ok(batches.every((b) => b.length <= READING_BATCH.items));
	assert.equal(batches.flat().length, 20);
	const { app } = makeApp();
	let calls = 0;
	const ai: any = { complete: async (p: string) => (calls++, { text: JSON.stringify({ items: p.split("\n").map((l) => ({ kana: "か", romaji: l.slice(0, 3) })) }) }) };
	const texts = Array.from({ length: 12 }, (_, i) => `文${i}です。`);
	const r = await readingMany(app, ai, texts);
	assert.equal(calls, 2); // 8 + 4
	assert.ok(r.every((x) => x.kana === "か"));
	assert.ok(texts.every((t) => cachedReading(app, t)));
});

test("翻譯快取各語言分開；日文讀音一次查多句並快取", async () => {
	const { app } = makeApp();
	let calls = 0;
	const ai: any = {
		complete: async (p: string, o: any) => {
			calls++;
			if (/hiragana/.test(o.system)) return { text: JSON.stringify({ items: p.split("\n").map(() => ({ kana: "きょうはいいてんきです。", romaji: "kyou wa ii tenki desu." })) }) };
			return { text: JSON.stringify({ zh: p.split("\n").map(() => /Spanish/.test(o.system) ? "否" : "不") }) };
		},
	};
	await translateMany(app, ai, ["no"], "es");
	assert.equal(cachedZh(app, "no", "es"), "否");
	assert.equal(cachedZh(app, "no"), undefined);
	const r = await readingMany(app, ai, ["今日はいい天気です。"]);
	assert.equal(r[0].romaji, "kyou wa ii tenki desu.");
	assert.equal(cachedReading(app, "今日はいい天気です。")?.kana, "きょうはいいてんきです。");
	const before = calls;
	await readingMany(app, ai, ["今日はいい天気です。"]);
	assert.equal(calls, before); // 快取命中不再呼叫
	assert.equal(normWord("「天気」", "ja"), "天気");
});

test("檢查修正：合併變化形時，生字本顯示的字不會帶語言前綴", () => {
	const logs = [{ id: "w1", ts: "2026-01-07T00:00:00Z", type: "word-add", word: "fui", lemma: "ir", lang: "es" }] as any;
	const book = buildWordBook([spanishBank()], logs, "es");
	const ir = book.find((w) => w.key === "es:ir")!;
	assert.equal(ir.word, "ir");
	assert.ok(ir.forms.has("fui"));
});

test("檢查修正：西班牙文、日文的移除紀錄帶 lang 才會生效", () => {
	const add = { id: "a", ts: "2026-01-07T00:00:00Z", type: "word-add", word: "casa", lang: "es" };
	const removeEn = { id: "r1", ts: "2026-01-08T00:00:00Z", type: "word-remove", word: "casa" };
	const removeEs = { id: "r2", ts: "2026-01-08T00:00:00Z", type: "word-remove", word: "casa", lang: "es" };
	assert.ok(buildWordBook([], [add, removeEn] as any, "es").some((w) => w.key === "es:casa")); // 沒帶 lang＝英文的移除
	assert.ok(!buildWordBook([], [add, removeEs] as any, "es").some((w) => w.key === "es:casa"));
	const p = { id: "p", ts: "2026-01-07T00:00:00Z", type: "phrase-add", key: "k1", zh: "早安", en: "おはよう", lang: "ja" };
	assert.equal(buildPhraseBook([p, { id: "x", ts: "2026-01-08T00:00:00Z", type: "phrase-remove", key: "k1", lang: "ja" }] as any, new Map(), "ja").length, 0);
});

test("檢查修正：日文標記生字不會標到已經標記的字裡面", () => {
	const r = markWords("==天気予報==を見ました。明日の天気は晴れです。", ["天気"], "ja");
	assert.equal(r.text, "==天気予報==を見ました。明日の==天気==は晴れです。");
	assert.deepEqual(markWords("==天気予報==を見ました。", ["天気"], "ja"), { text: "==天気予報==を見ました。", notFound: [] });
});
