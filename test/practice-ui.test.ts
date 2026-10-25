import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PracticeView, letterHint, nearMiss, sameAnswer } from "../src/practice";
import { renderBank } from "../src/generate";
import { makeApp } from "./helpers/app";
import { sampleBank } from "./helpers/fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
	const { app, files } = makeApp(new Map([["english/bank/b1.md", renderBank(sampleBank(), "english/sources/Story")], ["logs/ray/ipad-1.jsonl", ""]]));
	let n = 0;
	const plugin: any = {
		app,
		user: "ray",
		deviceId: "ipad-1",
		settings: { users: ["ray", "kid"], newPerDay: 10 },
		getApiKey: () => "k",
		backend: () => ({ complete: async () => ({ text: '{"score":80,"feedback":"好","corrected":""}', usage: {}, model: "m" }) }),
		makeEntry: (type: string, extra: Record<string, unknown>) => ({ id: "e" + n++, ts: new Date().toISOString(), device: "ipad-1", user: "ray", type, ...extra }),
		appendLog: async (e: unknown) => void files.set("logs/ray/ipad-1.jsonl", String(files.get("logs/ray/ipad-1.jsonl")) + JSON.stringify(e) + "\n"),
		say: () => undefined,
		syncAndWait: async () => true,
		fixQuestion: async () => null,
		debug: () => undefined,
	};
	const view: any = new PracticeView({ app } as any, plugin);
	const btn = (t: string) => [...view.contentEl.querySelectorAll("button")].find((b: any) => b.textContent === t) as any;
	const logs = () => String(files.get("logs/ray/ipad-1.jsonl")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	return { view, btn, logs };
}

test("克漏字比對與提示", () => {
	assert.ok(sameAnswer(" Opened. ", "opened"));
	assert.ok(!sameAnswer("open", "opened"));
	assert.equal(letterHint("take off"), "t _ _ _   o _ _（4 + 3 個字母）");
	assert.ok(nearMiss("opend", "opened"));
	assert.ok(!nearMiss("cat", "car"));
});

test("練習流程：選擇題、我不知道、克漏字、答錯重練", async () => {
	const { view, btn, logs } = setup();
	await view.onOpen();
	await sleep(30);
	const titles = [...view.contentEl.querySelectorAll(".el-type-card .el-title")].map((x: any) => x.textContent);
	assert.ok(titles.includes("單字") && titles.includes("聽力理解") && titles.includes("句子"));
	const card = (name: string) => [...view.contentEl.querySelectorAll(".el-type-card")].find((c: any) => c.querySelector(".el-title").textContent === name) as any;

	card("單字").querySelector("button").click();
	await sleep(30);
	const q = view.items[0].q;
	view.contentEl.querySelectorAll("button.el-opt")[q.answer].click();
	btn("下一題").click();
	btn("我不知道").click();
	assert.ok(btn("下一題"));
	btn("下一題").click(); // 答錯的題目會在最後重出
	assert.equal(view.items[view.idx].relearn, true);
	view.contentEl.querySelector(".el-quit").click();
	const L = logs();
	assert.deepEqual(L.map((e: any) => [e.correct, !!e.dontKnow]), [[true, false], [false, true]]);

	btn("換一種題型").click();
	await sleep(30);
	card("克漏字").querySelector("button").click();
	await sleep(30);
	view.contentEl.querySelector("input.el-cloze-input").value = "OPENED";
	btn("送出").click();
	assert.match(view.contentEl.querySelector(".el-verdict").textContent, /答對/);
});

test("每日新題上限", async () => {
	const { view } = setup();
	view.plugin.settings.newPerDay = 1;
	await view.onOpen();
	await sleep(30);
	const card = [...view.contentEl.querySelectorAll(".el-type-card")].find((c: any) => c.querySelector(".el-title").textContent === "單字") as any;
	assert.match(card.textContent, /今天還可練 1 題新題/);
	card.querySelector("button").click();
	await sleep(30);
	assert.equal(view.items.length, 1);
});
