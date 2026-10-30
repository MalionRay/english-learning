import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { bookStatus, splitByStatus } from "../src/words";
import { WordsView } from "../src/wordviews";
import { renderBank } from "../src/generate";
import { makeApp } from "./helpers/app";
import { sampleBank } from "./helpers/fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("狀態：還沒複習、要加強、學習中、熟練（間隔 7 天以上）", () => {
	assert.equal(bookStatus(undefined), "new");
	assert.equal(bookStatus({ step: 0, lastCorrect: false } as any), "wrong");
	assert.equal(bookStatus({ step: 2, lastCorrect: true } as any), "learning");
	assert.equal(bookStatus({ step: 3, lastCorrect: true } as any), "mastered");
	const s = { a: "mastered", b: "new", c: "wrong", d: "learning", e: "wrong" } as const;
	const r = splitByStatus(["a", "b", "c", "d", "e"], (x) => s[x as keyof typeof s]);
	assert.deepEqual(r.active, ["c", "e", "d", "b"]);
	assert.deepEqual(r.mastered, ["a"]);
	assert.deepEqual(r.counts, { new: 1, wrong: 2, learning: 1, mastered: 1 });
});

test("生字本：熟練的收在「已熟練」裡，其他依狀態排前面並加標籤", async () => {
	const t = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
	// harbor 連續答對 → 熟練；gentle 答錯 → 要加強
	const logs = [
		...[40, 30, 20, 10].map((d, i) => ({ id: "h" + i, ts: t(d), device: "d", user: "ray", type: "answer", qid: "word:harbor", qtype: "word", correct: true })),
		{ id: "g0", ts: t(2), device: "d", user: "ray", type: "answer", qid: "v2", qtype: "vocab", correct: false },
		{ id: "g1", ts: t(1), device: "d", user: "ray", type: "answer", qid: "word:gentle", qtype: "word", correct: false },
	];
	const { app } = makeApp(
		new Map([
			["english/bank/b1.md", renderBank(sampleBank(), "english/sources/Story")],
			["logs/ray/d.jsonl", logs.map((l) => JSON.stringify(l)).join("\n") + "\n"],
		]),
	);
	const plugin: any = { app, user: "ray", settings: { users: ["ray"] }, makeEntry: () => ({}), appendLog: async () => undefined };
	const view: any = new WordsView({ app } as any, plugin);
	await view.onOpen();
	await sleep(30);
	const el: HTMLElement = view.contentEl;
	const mastered = el.querySelector("details.el-mastered") as HTMLDetailsElement;
	assert.ok(mastered, "有已熟練區");
	assert.ok(!mastered.open);
	assert.match(mastered.textContent!, /harbor/);
	const activeTitles = [...el.querySelectorAll(":scope > div > .el-word-card .el-title")].map((x) => x.textContent);
	assert.ok(!activeTitles.includes("harbor"));
	assert.equal(activeTitles[0], "gentle"); // 要加強排最前
	assert.equal(el.querySelector(".el-word-card .el-status")!.textContent, "要加強");
	assert.match(el.querySelector(".el-book-summary")!.textContent!, /熟練 1/);
});
