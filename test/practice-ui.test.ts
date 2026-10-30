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
		fastBackend() {
			return this.backend();
		},
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

test("克漏字答錯後，句子練習會出現整句", async () => {
	const { view, btn } = setup();
	await view.onOpen();
	await sleep(30);
	const card = (name: string) => [...view.contentEl.querySelectorAll(".el-type-card")].find((c: any) => c.querySelector(".el-title").textContent === name) as any;
	card("克漏字").querySelector("button").click();
	await sleep(30);
	btn("我不知道").click();
	view.contentEl.querySelector(".el-quit").click();
	await sleep(30);
	btn("換一種題型").click();
	await sleep(30);
	card("句子").querySelector("button").click();
	await sleep(30);
	assert.match(view.contentEl.textContent, /之前克漏字答錯的句子/);
	assert.match(view.contentEl.querySelector(".el-qword").textContent, /湯姆打開窗戶/);
	btn("看答案（自己判斷）").click();
	assert.match(view.contentEl.textContent, /Tom opened the window because the room was hot\./);
});

test("今日複習：各題型到期的輪流混在一起，不夠再補新題（受每日上限）", async () => {
	const { mixSession } = await import("../src/practice");
	const mk = (id: string) => ({ q: { id } as any, bank: {} as any, marked: false });
	const past = Date.now() - 864e5;
	const st = (due: number) => ({ step: 1, due, lastCorrect: true }) as any;
	const states = new Map([
		["w1", st(past)],
		["w2", st(past)],
		["w3", st(Date.now() + 5 * 864e5)], // 還沒到期
		["c1", st(past)],
	]);
	const groups = [
		{ pqs: [mk("w1"), mk("w2"), mk("w3"), mk("wn1")], newAllowed: 10 },
		{ pqs: [mk("c1"), mk("cn1"), mk("cn2")], newAllowed: 1 },
		{ pqs: [mk("ln1")], newAllowed: 0 },
	];
	const m = mixSession(groups, states, 20);
	assert.deepEqual(m.items.map((x) => x.q.id), ["w1", "c1", "w2", "wn1", "cn1"]);
	assert.equal(m.due, 3);
	assert.equal(m.fresh, 2);
	assert.equal(m.dueTotal, 3);
	assert.equal(m.freshAvailable, 2);
	// 題數上限：到期的優先
	assert.deepEqual(mixSession(groups, states, 2).items.map((x) => x.q.id), ["w1", "c1"]);
});

test("今日複習按鈕：開始畫面最上面，按下去混合出題", async () => {
	const { view, btn } = setup();
	await view.onOpen();
	await sleep(30);
	const first = view.contentEl.querySelector(".el-type-card .el-title");
	assert.equal(first.textContent, "📅 今日複習");
	view.contentEl.querySelector(".el-today-card button").click();
	await sleep(30);
	assert.ok(view.items.length > 0);
	assert.equal(view.sessionType, "mixed");
	const types = new Set(view.items.map((x: any) => (x.word ? "word" : x.dict ? "listening" : x.phrase ? "phrase" : x.q.type)));
	assert.ok(types.size >= 3, `mixed types: ${[...types].join(",")}`);
});
