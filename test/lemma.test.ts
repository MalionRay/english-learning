import { test } from "node:test";
import assert from "node:assert/strict";
import { lemmaMap, looksInflected, suffixCandidates } from "../src/lemma";
import { aliasWordQids, buildWordBookWithAliases } from "../src/words";
import { computeStates } from "../src/srs";
import { sampleBank } from "./helpers/fixtures";

test("字形：不規則變化一定合併、字尾規則只在原形存在時合併", () => {
	const m = lemmaMap(["went", "gone", "going", "open", "opened", "makes", "seed", "see", "evening", "even", "left", "children"]);
	assert.equal(m.get("went"), "go");
	assert.equal(m.get("gone"), "go");
	assert.equal(m.get("going"), "go");
	assert.equal(m.get("opened"), "open");
	assert.equal(m.get("makes"), "makes"); // make 不在生字本
	assert.equal(m.get("seed"), "seed"); // 不是 see 的變化形
	assert.equal(m.get("evening"), "evening");
	assert.equal(m.get("left"), "left"); // 有歧義、leave 不在生字本
	assert.equal(m.get("children"), "child");
	assert.equal(lemmaMap(["left", "leave"]).get("left"), "leave");
	assert.ok(suffixCandidates("stopped").includes("stop"));
	assert.ok(suffixCandidates("making").includes("make"));
	assert.ok(suffixCandidates("studies").includes("study"));
	assert.ok(looksInflected("walked"));
	assert.ok(!looksInflected("look up"));
});

test("AI 回報的原形優先", () => {
	const m = lemmaMap(["stunk", "flabbergasted"], new Map([["flabbergasted", "flabbergast"]]));
	assert.equal(m.get("flabbergasted"), "flabbergast");
	assert.equal(m.get("stunk"), "stink");
});

test("生字本合併形態，舊的複習紀錄算到合併後的字", () => {
	const t = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
	const logs = [
		{ id: "1", ts: t(5), type: "word-add", word: "went", meaning: "去（過去式）" },
		{ id: "2", ts: t(4), type: "answer", qid: "word:went", qtype: "word", correct: true },
		{ id: "3", ts: t(3), type: "word-add", word: "go", meaning: "去" },
		{ id: "4", ts: t(2), type: "word-add", word: "Opening" },
		{ id: "5", ts: t(1), type: "answer", qid: "c1", qtype: "cloze", correct: false }, // 答案 opened
		{ id: "6", ts: t(1), type: "word-add", word: "open" },
	] as any;
	const { words, aliases } = buildWordBookWithAliases([sampleBank()], logs);
	const go = words.find((w) => w.key === "go")!;
	assert.equal(go.word, "go");
	assert.equal(go.meaning, "去"); // 原形的意思優先
	assert.deepEqual([...go.forms], ["went"]);
	assert.ok(!words.some((w) => w.key === "went"));
	const open = words.find((w) => w.key === "open")!;
	assert.deepEqual([...open.forms].sort(), ["Opening", "opened"]);
	assert.equal(open.wrong, 1);
	const states = computeStates(aliasWordQids(logs.filter((e: any) => e.type === "answer"), aliases));
	assert.equal(states.get("word:go")?.right, 1);

	// 移除合併後的字：所有形態一起消失
	const removed = buildWordBookWithAliases([sampleBank()], [...logs, { id: "7", ts: t(0), type: "word-remove", word: "go" }] as any).words;
	assert.ok(!removed.some((w) => w.key === "go" || w.key === "went"));
});
