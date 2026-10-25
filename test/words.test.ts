import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWordBook, computeStats } from "../src/words";
import { computeStates } from "../src/srs";
import { sampleBank } from "./helpers/fixtures";

test("生字本：標記、答錯、手動加入與移除", () => {
	const t = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
	const logs = [
		{ id: "1", ts: t(3), type: "answer", qid: "v2", qtype: "vocab", correct: false },
		{ id: "2", ts: t(2), type: "answer", qid: "c1", qtype: "cloze", correct: false },
		{ id: "3", ts: t(1), type: "word-add", word: "Sakhalin", meaning: "庫頁島" },
		{ id: "4", ts: t(0.5), type: "word-add", word: "removed" },
		{ id: "5", ts: t(0.4), type: "word-remove", word: "removed" },
	] as any;
	const book = buildWordBook([sampleBank()], logs);
	const keys = book.map((w) => w.key).sort();
	assert.deepEqual(keys, ["gentle", "harbor", "opened", "sakhalin"]);
	assert.ok(book.find((w) => w.key === "harbor")!.reasons.has("marked"));
	assert.equal(book.find((w) => w.key === "gentle")!.wrong, 1);
});

test("統計：連續天數與正確率", () => {
	const now = Date.now();
	const logs = [0, 1, 2].map((d, i) => ({ id: "s" + i, ts: new Date(now - d * 864e5).toISOString(), type: "answer", qid: "q" + i, qtype: "vocab", correct: i !== 1 })) as any;
	const s = computeStats(logs, computeStates(logs), now);
	assert.equal(s.streak, 3);
	assert.equal(s.today, 1);
	assert.deepEqual(s.byType.vocab, { total: 3, right: 2 });
});
