// v0.23.0：學習紀錄瘦身——診斷紀錄（同步、語音、AI 呼叫、記一筆、麥克風）另外放，舊的自動清掉
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AppendOnlyWriter,
	DIAG_CLOUD_KEEP_DAYS,
	DIAG_KEEP_DAYS,
	DIAG_MAX_LINES,
	DIAG_ROOT,
	addMissingLines,
	computeTotals,
	diagLinesOf,
	diagPath,
	dropLines,
	entryPath,
	isDiagType,
	slimLogs,
	trimDiag,
} from "../src/logs";
import { cloudMonth, readCloudUsage } from "../src/cloudtts";
import { deleteUserData } from "../src/users";
import { loadUserLogs } from "../src/practice";
import { loadFlags } from "../src/flags";
import { backupNow } from "../src/backup";
import { makeApp } from "./helpers/app";

const NOW = new Date("2026-11-14T10:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();
const J = (o: object) => JSON.stringify(o);
const entry = (id: string, type: string, extra: Record<string, unknown> = {}, ts = daysAgo(1), user = "ray", device = "ipad-1") => J({ id, ts, device, user, type, ...extra });
const lines = (files: Map<string, string | ArrayBuffer>, path: string) =>
	String(files.get(path) ?? "")
		.split("\n")
		.filter(Boolean);
const ids = (files: Map<string, string | ArrayBuffer>, path: string) =>
	lines(files, path)
		.filter((l) => !l.startsWith("{half")) // 測試資料裡故意放的壞行
		.map((l) => JSON.parse(l).id);

test("寫到哪個檔：學習紀錄在 logs，診斷紀錄在 debug/diag", () => {
	for (const t of ["answer", "grade", "flag", "unflag", "word-add", "word-remove", "phrase-add", "phrase-remove"]) {
		assert.equal(isDiagType(t), false, t);
		assert.equal(entryPath({ type: t, user: "ray" }, "ipad-1"), "logs/ray/ipad-1.jsonl");
	}
	for (const t of ["sync", "tts", "api", "tap", "mic"]) {
		assert.equal(isDiagType(t), true, t);
		assert.equal(entryPath({ type: t, user: "Ray" }, "ipad-1"), "debug/diag/ray/ipad-1.jsonl");
	}
	assert.equal(diagPath("kid", "win-1"), `${DIAG_ROOT}/kid/win-1.jsonl`);
});

test("挑出診斷紀錄：壞行、沒有 id 的不動；加到診斷檔時已經有的不重複", () => {
	const text = [entry("a1", "answer", { qid: "q1" }), entry("s1", "sync"), "{broken", J({ type: "sync" }), entry("t1", "tts", { source: "cloud", chars: 12 }), ""].join("\n");
	const d = diagLinesOf(text);
	assert.deepEqual(
		d.map((x) => x.id),
		["s1", "t1"],
	);
	const once = addMissingLines("", d)!;
	assert.equal(once.split("\n").filter(Boolean).length, 2);
	assert.equal(addMissingLines(once, d), null, "都已經有了");
	const more = addMissingLines(once.trimEnd(), [...d, { id: "x9", line: entry("x9", "api") }])!; // 原本最後沒有換行也接得上
	assert.deepEqual(
		more
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l).id),
		["s1", "t1", "x9"],
	);
	const kept = dropLines(text, new Set(["s1", "t1"]))!;
	assert.deepEqual(kept.split("\n"), [entry("a1", "answer", { qid: "q1" }), "{broken", J({ type: "sync" }), ""]);
	assert.equal(dropLines(kept, new Set(["s1"])), null, "沒有要拿掉的就不改");
});

test("診斷檔只留最近的：一般 14 天、Google Cloud 語音用量 62 天（舊的只留算用量的欄位）", () => {
	const cloud = (id: string, days: number) => entry(id, "tts", { source: "cloud", chars: 100, month: "2026-11", text: "Some sentence that was spoken", voice: "Kore", bytes: 9000 }, daysAgo(days));
	const text =
		[
			entry("old-sync", "sync", {}, daysAgo(DIAG_KEEP_DAYS + 1)),
			entry("new-sync", "sync", {}, daysAgo(DIAG_KEEP_DAYS - 1)),
			entry("old-api", "api", { purpose: "chat" }, daysAgo(40)),
			entry("gemini-old", "tts", { source: "gemini", text: "hello" }, daysAgo(20)),
			cloud("c-fresh", 3),
			cloud("c-month", 30),
			cloud("c-gone", DIAG_CLOUD_KEEP_DAYS + 1),
			"{broken line",
			entry("no-ts", "sync", { ts: undefined }, "not a date"),
		].join("\n") + "\n";
	const out = trimDiag(text, NOW)
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	assert.deepEqual(
		out.map((e) => e.id),
		["new-sync", "c-fresh", "c-month"],
	);
	assert.equal(out[1].text, "Some sentence that was spoken", "最近的原樣留著");
	assert.deepEqual(Object.keys(out[2]).sort(), ["chars", "device", "id", "month", "source", "ts", "type", "user"], "超過 14 天的用量紀錄只留必要欄位");
	assert.equal(out[2].chars, 100);
	// 整理過的再整理一次不會變
	const once = trimDiag(text, NOW);
	assert.equal(trimDiag(once, NOW), once);
	assert.equal(trimDiag(entry("x", "sync", {}, daysAgo(99)) + "\n", NOW), "", "全部過期就清空");
});

test("診斷檔太多筆：從最舊的開始丟，但 Google Cloud 語音的用量一筆都不丟", () => {
	const many: string[] = [];
	for (let i = 0; i < DIAG_MAX_LINES + 30; i++) many.push(entry(`s${i}`, "sync", {}, daysAgo(1)));
	many.splice(5, 0, entry("cloud-1", "tts", { source: "cloud", chars: 7, month: "2026-11" }, daysAgo(1)));
	const out = trimDiag(many.join("\n") + "\n", NOW)
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l).id);
	assert.equal(out.length, DIAG_MAX_LINES + 1);
	assert.equal(out[0], "cloud-1");
	assert.equal(out[1], "s30", "前 30 筆最舊的丟掉");
	assert.equal(out[out.length - 1], `s${DIAG_MAX_LINES + 29}`);
});

function vault() {
	const m = cloudMonth(NOW);
	const mine = [
		entry("a1", "answer", { qid: "q1", correct: true }),
		entry("s1", "sync", { triggered: true }),
		entry("t1", "tts", { source: "cloud", chars: 300, month: m, text: "A made-up sentence." }),
		entry("p1", "phrase-add", { key: "k1", zh: "你好", en: "Hello" }),
		"{half written",
		entry("api1", "api", { ok: true, purpose: "chat", ms: 900 }),
		entry("tap1", "tap"),
		entry("w1", "word-add", { word: "harbor" }),
		entry("old1", "sync", {}, daysAgo(200)),
	];
	return makeApp(
		new Map<string, string>([
			["logs/ray/ipad-1.jsonl", mine.join("\n") + "\n"],
			["logs/ray/win-1.jsonl", [entry("a2", "answer", { qid: "q2" }, daysAgo(2), "ray", "win-1"), entry("t2", "tts", { source: "cloud", chars: 50, month: m }, daysAgo(2), "ray", "win-1")].join("\n") + "\n"],
			["logs/kid/ipad-1.jsonl", [entry("k-sync", "sync", {}, daysAgo(1), "kid"), entry("k-ans", "answer", { qid: "q3" }, daysAgo(1), "kid")].join("\n") + "\n"],
			["logs/amy/ipad-1.jsonl", entry("amy-ans", "answer", { qid: "q4" }, daysAgo(1), "amy") + "\n"],
		]),
	);
}

test("瘦身：這台裝置的學習紀錄裡的診斷紀錄搬到診斷檔，學習紀錄一筆都不少；別台裝置的檔不動", async () => {
	const { app, files } = vault();
	const before = { win: files.get("logs/ray/win-1.jsonl"), amy: files.get("logs/amy/ipad-1.jsonl") };
	const logsBefore = await loadUserLogs(app, "ray");
	const usageBefore = await readCloudUsage(app, cloudMonth(NOW));
	const w = new AppendOnlyWriter(app);
	const r = await slimLogs(app, w, "ipad-1", NOW);
	assert.deepEqual({ moved: r.moved, files: r.files }, { moved: 6, files: 2 });

	assert.deepEqual(lines(files, "logs/ray/ipad-1.jsonl"), [
		entry("a1", "answer", { qid: "q1", correct: true }),
		entry("p1", "phrase-add", { key: "k1", zh: "你好", en: "Hello" }),
		"{half written",
		entry("w1", "word-add", { word: "harbor" }),
	]);
	assert.ok(String(files.get("logs/ray/ipad-1.jsonl")).endsWith("\n"), "結尾的換行還在，之後 append 不會黏在一起");
	assert.deepEqual(ids(files, "debug/diag/ray/ipad-1.jsonl"), ["s1", "t1", "api1", "tap1"], "超過 14 天的那筆順便清掉了");
	assert.deepEqual(ids(files, "logs/kid/ipad-1.jsonl"), ["k-ans"]);
	assert.deepEqual(ids(files, "debug/diag/kid/ipad-1.jsonl"), ["k-sync"]);
	assert.equal(files.get("logs/ray/win-1.jsonl"), before.win, "別台裝置寫的檔不動（單一寫入者）");
	assert.equal(files.get("logs/amy/ipad-1.jsonl"), before.amy, "沒有診斷紀錄的檔不重寫");
	assert.equal(files.has("debug/diag/amy/ipad-1.jsonl"), false);

	// 學習資料和 Google Cloud 語音用量都和搬之前一樣
	assert.deepEqual(await loadUserLogs(app, "ray"), logsBefore);
	assert.equal(await readCloudUsage(app, cloudMonth(NOW)), usageBefore);
	assert.equal(usageBefore, 350);

	// 再跑一次什麼都不會變
	const snapshot = new Map(files);
	const again = await slimLogs(app, w, "ipad-1", NOW);
	assert.deepEqual(again, { moved: 0, files: 0, trimmed: 0 });
	assert.deepEqual([...files.entries()], [...snapshot.entries()]);
});

test("瘦身：上次搬到一半（診斷檔已經有了、學習紀錄還沒拿掉）再跑一次不會重複", async () => {
	const { app, files } = vault();
	files.set("debug/diag/ray/ipad-1.jsonl", entry("s1", "sync", { triggered: true }) + "\n" + entry("later", "sync", {}, daysAgo(0)) + "\n");
	// 這時候加總 Google Cloud 語音用量：只在學習紀錄裡的那筆照算
	assert.equal(await readCloudUsage(app, cloudMonth(NOW)), 350);
	await slimLogs(app, new AppendOnlyWriter(app), "ipad-1", NOW);
	assert.deepEqual(ids(files, "debug/diag/ray/ipad-1.jsonl"), ["s1", "later", "t1", "api1", "tap1"]);
	assert.equal(await readCloudUsage(app, cloudMonth(NOW)), 350);
});

test("瘦身：整理的同時有新的紀錄寫進來，一筆都不會掉", async () => {
	const { app, files } = vault();
	const w = new AppendOnlyWriter(app);
	const job = slimLogs(app, w, "ipad-1", NOW);
	const a = w.append("logs/ray/ipad-1.jsonl", entry("a9", "answer", { qid: "q9" }, daysAgo(0)) + "\n");
	const b = w.append("debug/diag/ray/ipad-1.jsonl", entry("s9", "sync", {}, daysAgo(0)) + "\n");
	await Promise.all([job, a, b]);
	assert.ok(ids(files, "logs/ray/ipad-1.jsonl").includes("a9"));
	assert.ok(!ids(files, "logs/ray/ipad-1.jsonl").includes("s1"));
	const d = ids(files, "debug/diag/ray/ipad-1.jsonl");
	for (const id of ["s1", "t1", "api1", "tap1", "s9"]) assert.ok(d.includes(id), id);
	assert.equal(new Set(d).size, d.length, "沒有重複");
});

test("學習紀錄裡全部都是診斷紀錄（只拿來開發測試的裝置）：搬完留一個換行，不留 0 位元組的空檔；之後照常寫入", async () => {
	const { app, files } = makeApp(
		new Map<string, string>([
			["logs/ray/ipad-1.jsonl", [entry("s1", "sync"), entry("s2", "sync"), entry("t1", "tts", { source: "system" })].join("\n") + "\n"],
			["debug/diag/kid/ipad-1.jsonl", entry("old", "sync", {}, daysAgo(90), "kid") + "\n"],
		]),
	);
	const w = new AppendOnlyWriter(app);
	const r = await slimLogs(app, w, "ipad-1", NOW);
	assert.deepEqual(r, { moved: 3, files: 1, trimmed: 1 });
	assert.equal(files.get("logs/ray/ipad-1.jsonl"), "\n");
	assert.equal(files.get("debug/diag/kid/ipad-1.jsonl"), "\n", "診斷檔全部過期也一樣");
	assert.deepEqual(ids(files, "debug/diag/ray/ipad-1.jsonl"), ["s1", "s2", "t1"]);
	assert.deepEqual(await loadUserLogs(app, "ray"), []);
	const t = await computeTotals(app);
	assert.equal(t.badLines, 0, "空行不算壞行");
	assert.deepEqual(await slimLogs(app, w, "ipad-1", NOW), { moved: 0, files: 0, trimmed: 0 }, "再跑一次不會一直重寫");
	await w.append("logs/ray/ipad-1.jsonl", entry("a1", "answer", { qid: "q1", correct: true }) + "\n");
	assert.deepEqual(
		(await loadUserLogs(app, "ray")).map((e: any) => e.id),
		["a1"],
	);
});

test("Google Cloud 語音用量：診斷檔和還沒搬的學習紀錄都算，同一筆只算一次", async () => {
	const m = cloudMonth();
	const line = (id: string, chars: number, month = m) => J({ id, ts: new Date().toISOString(), device: "d", user: "ray", type: "tts", source: "cloud", chars, month });
	const { app } = makeApp(
		new Map<string, string>([
			["debug/diag/ray/ipad-1.jsonl", [line("a", 100), line("b", 50), line("old", 999, "2000-01")].join("\n") + "\n"],
			["logs/ray/ipad-1.jsonl", [line("a", 100), line("c", 20)].join("\n") + "\n"], // a：搬到一半，兩邊都有
			["logs/kid/iphone-1.jsonl", line("d", 5) + "\n"], // 還沒更新的裝置
			["debug/diag/kid/win-1.jsonl", line("e", 1) + "\n"],
		]),
	);
	assert.equal(await readCloudUsage(app), 176);
	assert.equal(await readCloudUsage(app, m, ["logs/kid", "debug/diag/kid"]), 6, "只算一位使用者（刪除使用者前轉記用）");
	assert.equal(await readCloudUsage(app, m, "logs/ray"), 120, "也可以只給一個資料夾");
});

test("驗證面板的合計：「記一筆」和最新狀態從診斷檔和舊的學習紀錄一起算，檔案清單只列學習紀錄", async () => {
	const { app } = makeApp(
		new Map<string, string>([
			["logs/ray/ipad-1a2b3c4d.jsonl", [entry("t-old", "tap", {}, daysAgo(3), "ray", "ipad-1a2b3c4d"), entry("ans", "answer", {}, daysAgo(3), "ray", "ipad-1a2b3c4d")].join("\n") + "\n"],
			[
				"debug/diag/ray/ipad-1a2b3c4d.jsonl",
				[
					entry("t-new", "tap", {}, daysAgo(1), "ray", "ipad-1a2b3c4d"),
					entry("t-old", "tap", {}, daysAgo(3), "ray", "ipad-1a2b3c4d"),
					entry("sy", "sync", {}, daysAgo(1), "ray", "ipad-1a2b3c4d"),
					entry("ap", "api", { ok: true }, daysAgo(1), "ray", "ipad-1a2b3c4d"),
					"{bad",
				].join("\n") + "\n",
			],
			["debug/diag/kid/win-0000aaaa.jsonl", entry("t-kid", "tap", {}, daysAgo(1), "kid", "win-0000aaaa") + "\n"],
			["debug/ipad-1a2b3c4d.md", "- some debug text\n"],
		]),
	);
	const t = await computeTotals(app);
	assert.equal(t.uniqueTaps, 3);
	assert.equal(t.rawTaps, 4);
	assert.equal(t.duplicates, 1);
	assert.deepEqual(t.byUser, { ray: 2, kid: 1 });
	assert.equal(t.latest["ipad-1a2b3c4d"].sync?.id, "sy");
	assert.equal(t.latest["ipad-1a2b3c4d"].api?.id, "ap");
	assert.deepEqual(
		t.files.map((f) => f.path),
		["logs/ray/ipad-1a2b3c4d.jsonl"],
	);
	assert.deepEqual(t.suspicious, []);
	assert.equal(t.badLines, 0, "診斷檔的壞行不算在學習紀錄的健康檢查裡");
});

test("刪除使用者：他的診斷紀錄也刪掉", async () => {
	const { app, files } = makeApp(
		new Map<string, string>([
			["logs/amy/ipad-1.jsonl", "{}\n"],
			["debug/diag/amy/ipad-1.jsonl", "{}\n"],
			["debug/diag/amy/win-1.jsonl", "{}\n"],
			["debug/diag/amyx/ipad-1.jsonl", "{}\n"],
			["debug/diag/ray/ipad-1.jsonl", "{}\n"],
			["debug/ipad-1.md", "- debug\n"],
		]),
	);
	const r = await deleteUserData(app, "amy");
	assert.equal(r.files, 3);
	assert.deepEqual([...files.keys()].sort(), ["debug/diag/amyx/ipad-1.jsonl", "debug/diag/ray/ipad-1.jsonl", "debug/ipad-1.md"]);
});

test("回報的題目、備份：診斷檔不影響（回報只讀學習紀錄；備份不含診斷檔）", async () => {
	const { app, files } = makeApp(
		new Map<string, string>([
			["logs/ray/ipad-1.jsonl", entry("f1", "flag", { qid: "q1", bank: "b1", reason: "答案標錯了" }) + "\n"],
			["debug/diag/ray/ipad-1.jsonl", entry("f2", "flag", { qid: "q2", bank: "b1", reason: "不該被讀到" }) + "\n" + entry("s1", "sync") + "\n"],
		]),
	);
	const flags = await loadFlags(app);
	assert.deepEqual([...flags.keys()], ["q1"]);
	const b = await backupNow(app, "ipad-1");
	const data = JSON.parse(String(files.get(b.path)));
	assert.deepEqual(Object.keys(data.files), ["logs/ray/ipad-1.jsonl"]);
});
