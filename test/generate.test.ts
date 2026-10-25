import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, extractMarked, markWords, parseBank, parseQuestions, planFor, planTotal, planWithMarked, renderBank, stripMarks, wordCount, missingMarked } from "../src/generate";
import { sampleBank } from "./helpers/fixtures";

test("題數依文章長度", () => {
	assert.equal(planTotal(planFor(80)), 8);
	assert.equal(planTotal(planFor(500)), 16);
	assert.equal(planTotal(planFor(2000)), 20);
	const p = planWithMarked(80, 12);
	assert.ok(p.vocab + p.cloze >= 12);
});

test("解析 AI 回傳：丟掉不合格的題目", () => {
	const raw = JSON.stringify({
		questions: [
			{ type: "vocab", word: "a", prompt: "alpha", context: "Alpha is the first letter of the Greek alphabet here.", options: ["1", "2", "3", "4"], answer: 0, explanation: "e" },
			{ type: "cloze", prompt: "No blank here", options: ["a", "b", "c", "d"], answer: 0, explanation: "" },
			{ type: "vocab", prompt: "x", options: ["a", "a", "b", "c"], answer: 0, explanation: "" },
			{ type: "cloze", prompt: "Alpha is the first ____ of the Greek alphabet here.", options: ["letter", "b", "c", "d"], answer: 0, explanation: "" },
			{ type: "essay", prompt: "?" },
			{ type: "translate", prompt: "中文", reference: "English.", explanation: "" },
		],
	});
	const r = parseQuestions("```json\n" + raw + "\n```");
	assert.deepEqual(r.questions.map((q) => q.type), ["vocab", "translate"]);
	assert.deepEqual(r.dropped.map((d) => d.reason).sort(), ["克漏字沒有空格", "和其他題用同一句", "未知題型 essay", "選項重複"].sort());
});

test("洗牌時中文選項跟著一起動", () => {
	let seed = 7;
	const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
	const raw = JSON.stringify({ questions: [{ type: "cloze", prompt: "I ____ it.", options: ["saw", "ate", "ran", "sat"], optionsZh: ["看見", "吃", "跑", "坐"], answer: 0, explanation: "" }] });
	for (let i = 0; i < 20; i++) {
		const q = parseQuestions(raw, rand).questions[0] as { options: string[]; optionsZh: string[]; answer: number };
		assert.equal(q.options[q.answer], "saw");
		assert.equal(q.optionsZh[q.options.indexOf("ran")], "跑");
	}
});

test("生字標記：容許字尾變化、已標記不算找不到", () => {
	const m = markWords("Officials lodged a protest. Espionage is serious.", ["lodge a protest", "espionage", "xyz"]);
	assert.match(m.text, /==lodged a protest==/);
	assert.match(m.text, /==Espionage==/);
	assert.deepEqual(m.notFound, ["xyz"]);
	assert.deepEqual(extractMarked(m.text), ["lodged a protest", "Espionage"]);
	assert.equal(stripMarks(m.text), "Officials lodged a protest. Espionage is serious.");
});

test("題庫檔來回轉換", () => {
	const b = sampleBank();
	const md = renderBank(b, "english/sources/Story");
	assert.equal(parseBank(md)?.questions.length, b.questions.length);
	assert.match(md, /el-say/);
	assert.deepEqual(missingMarked(b.questions, ["harbor", "volcano"]), ["volcano"]);
});

test("字數與零寬字元", () => {
	assert.equal(wordCount("It's a well-known fact — don’t panic. 中文 123"), 6);
	assert.equal(cleanText("a​b﻿c"), "abc");
});
