import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PatternModal } from "../src/patternview";
import { ImportModal } from "../src/views";
import { renderBank } from "../src/generate";
import { makeApp } from "./helpers/app";
import { sampleBank } from "./helpers/fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("錯誤分析畫面：產生報告、勾選練習句加入句子本", async () => {
	const t = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
	const answers = [0, 1, 2, 3, 4, 5].map((i) => JSON.stringify({ id: "a" + i, ts: t(i + 1), type: "answer", qid: "t1", qtype: "translate", text: `Boat stay harbor ${i}`, score: 50, corrected: `The boat stays in the harbor ${i}.` }));
	const { app, files } = makeApp(new Map([["english/bank/b1.md", renderBank(sampleBank(), "english/sources/Story")], ["logs/ray/ipad-1.jsonl", answers.join("\n") + "\n"]]));
	let prompt = "";
	const added: any[] = [];
	const plugin: any = {
		app,
		user: "ray",
		deviceId: "ipad-1",
		backend: () => ({
			complete: async (p: string) => {
				prompt = p;
				return { text: JSON.stringify({ summary: "動詞常漏掉。", patterns: [{ title: "少了 be 動詞", explanation: "x", examples: [{ wrong: "Boat stay harbor 0", right: "The boat stays in the harbor 0." }], tip: "檢查動詞", drills: [{ zh: "貓在家。", en: "The cat is at home." }, { zh: "他很累。", en: "He is tired." }] }] }), usage: {}, model: "m" };
			},
		}),
		addPhrase: async (p: unknown) => void added.push(p),
	};
	const m: any = new PatternModal(app, plugin);
	m.onOpen();
	await sleep(50);
	assert.match(prompt, /Boat stay harbor 0 → The boat stays in the harbor 0\./);
	const reports = [...files.keys()].filter((k) => k.startsWith("english/reports/ray/"));
	assert.equal(reports.length, 1);
	const boxes = [...m.contentEl.querySelectorAll("input[type=checkbox]")] as HTMLInputElement[];
	assert.equal(boxes.length, 2);
	boxes[1].checked = false;
	([...m.contentEl.querySelectorAll("button")].find((b: any) => b.textContent === "加入句子本") as any).click();
	await sleep(10);
	assert.deepEqual(added.map((a) => [a.en, a.source]), [["The cat is at home.", "pattern"]]);
});

test("錯誤太少時不呼叫 AI", async () => {
	const { app } = makeApp(new Map([["logs/ray/ipad-1.jsonl", ""]]));
	let called = false;
	const plugin: any = { app, user: "ray", deviceId: "ipad-1", backend: () => ({ complete: async () => ((called = true), { text: "{}" }) }) };
	const m: any = new PatternModal(app, plugin);
	m.onOpen();
	await sleep(30);
	assert.equal(called, false);
	assert.match(m.contentEl.textContent, /至少要 5 筆/);
});

test("匯入視窗有拍照按鈕", () => {
	const { app } = makeApp();
	const m: any = new ImportModal(app, { lastLevel: "adult" } as any);
	m.onOpen();
	const input = m.contentEl.querySelector("input[type=file]");
	assert.equal(input.getAttribute("accept"), "image/*");
	assert.ok(input.hasAttribute("multiple"));
	assert.ok([...m.contentEl.querySelectorAll("button")].some((b: any) => b.textContent.includes("拍照")));
});
