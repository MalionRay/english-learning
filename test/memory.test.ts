// v0.23.0：跨對話記憶（每位使用者、每種語言各一份）——重播、提示、AI 回覆的解析、排程
import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CATCHUP_EVERY_MS,
	LS_MEMORY_FAIL,
	MEMORY_ADD_MAX,
	MEMORY_DIR,
	MEMORY_MAX,
	MEMORY_TEXT_MAX,
	MemEvent,
	MemItem,
	MemoryManager,
	applyOps,
	learnerCount,
	loadMemory,
	memoryPath,
	memoryPrompt,
	parseMemoryOps,
	pendingFrom,
	pickCatchUp,
	recentConvs,
	replayMemory,
	summaryRequest,
	transcriptOf,
} from "../src/memory";
import { ConvMessage, convBlock, convHeader, parseConvMeta } from "../src/chat";
import { AIError } from "../src/ai";
import { deleteUserData, stripBackupFiles } from "../src/users";
import { BACKUP_ROOTS, backupNow, listBackups, restoreBackup } from "../src/backup";
import { makeApp } from "./helpers/app";

const NOW = new Date("2026-11-14T10:00:00.000Z");
const ago = (days: number, base = NOW) => new Date(base.getTime() - days * 24 * 3600 * 1000).toISOString();
const J = (o: object) => JSON.stringify(o);
let seq = 0;
const ev = (o: Partial<MemEvent>): MemEvent => ({ id: `e${seq++}`, ts: ago(1), device: "ipad-1", user: "ray", type: "mem", ...o });
const item = (key: string, text: string, at = ago(1)): MemItem => ({ key, text, at });
const reply = (r: string, correction?: [string, string]) =>
	J({ correction: correction ? { original: correction[0], corrected: correction[1], explanation: "說明", zh: "意思" } : null, howto: [], reply: r, replyZh: "" });
const user = (text: string, ts = ago(1)): ConvMessage => ({ role: "user", text, ts });
const model = (text: string, ts = ago(1), correction?: [string, string]): ConvMessage => ({ role: "model", text: reply(text, correction), ts });

// ---------- 重播 ----------
test("記憶依時間重播：新增、刪除、改寫；每種語言各自一份", () => {
	const s = replayMemory([
		ev({ ts: ago(5), add: [item("a", "在桃園的工廠當工程師", ago(5)), item("b", "12 月要去東京玩 5 天", ago(5))], conv: "conversations/c1.md", count: 8 }),
		ev({ ts: ago(3), lang: "es", add: [item("s1", "喜歡吃墨西哥捲餅", ago(3))], conv: "conversations/c2.md", count: 6 }),
		ev({ ts: ago(2), remove: ["b"], add: [item("b2", "12/20 出發去東京，住新宿", ago(2))], conv: "conversations/c1.md", count: 14 }),
		ev({ ts: ago(1), remove: ["a"], by: "user" }),
		ev({ ts: ago(4), lang: "ja", add: [item("j1", "正在背平假名", ago(4))] }),
	]);
	assert.deepEqual(
		s.items.en.map((m) => m.text),
		["12/20 出發去東京，住新宿"],
	);
	assert.deepEqual(
		s.items.es.map((m) => m.key),
		["s1"],
	);
	assert.deepEqual(
		s.items.ja.map((m) => m.text),
		["正在背平假名"],
	);
	assert.equal(s.done.get("conversations/c1.md"), 14, "同一個對話取整理到最後面的那一次");
	assert.equal(s.done.get("conversations/c2.md"), 6);
	assert.equal(s.since, "");
});

test("重播：順序不看檔案裡的先後、同一筆（UUID）只算一次、最新的排前面、一模一樣的只留一條", () => {
	const add = ev({ ts: ago(3), add: [item("a", "養了一隻貓叫 Mochi", ago(3))] });
	const s = replayMemory([
		ev({ ts: ago(1), remove: ["a"] }), // 檔案裡先出現，但時間比較晚
		add,
		add, // 別台裝置同步來的同一筆
		ev({ ts: ago(2), add: [item("x", "週末常去爬山", ago(9)), item("y", "下個月要搬家", ago(2))] }),
		ev({ ts: ago(2), add: [item("z", "週末常去爬山。", ago(4))] }), // 另一台裝置也整理出同一句
		ev({ ts: ago(2), add: [{ key: "bad" } as MemItem, item("", ""), item("w", "   ")] }),
		{ id: "u1", ts: ago(1), device: "d", user: "ray", type: "user-set" } as unknown as MemEvent,
		ev({ ts: ago(6), since: ago(6) }),
		ev({ ts: ago(4), since: ago(4) }),
		// 另一台裝置的時鐘慢了：刪除的時間比新增還早，照樣算刪掉（刪掉的不會因為順序又跑回來）
		ev({ ts: ago(2), add: [item("late", "時鐘不準的那台加的", ago(2))] }),
		ev({ ts: ago(8), device: "win-1", remove: ["late"] }),
	]);
	assert.deepEqual(
		s.items.en.map((m) => m.key),
		["y", "z"],
		"a 被刪了；x 和 z 是同一句，留比較新的",
	);
	assert.equal(s.since, ago(4));
});

test("讀寫位置：english/memory/<user>/<deviceId>.jsonl，所有裝置的檔一起重播", async () => {
	assert.equal(memoryPath("Ray", "ipad-1"), `${MEMORY_DIR}/ray/ipad-1.jsonl`);
	const { app } = makeApp(
		new Map<string, string>([
			["english/memory/ray/ipad-1.jsonl", J(ev({ ts: ago(3), add: [item("a", "在學吉他", ago(3))] })) + "\n{broken\n"],
			["english/memory/ray/win-1.jsonl", J(ev({ ts: ago(1), device: "win-1", remove: ["a"], add: [item("b", "吉他已經會彈三首歌", ago(1))] })) + "\n"],
			["english/memory/kid/ipad-1.jsonl", J(ev({ user: "kid", add: [item("k", "喜歡恐龍")] })) + "\n"],
			["english/memory/ray/notes.md", "不是記憶檔"],
		]),
	);
	assert.deepEqual(
		(await loadMemory(app, "ray")).items.en.map((m) => m.text),
		["吉他已經會彈三首歌"],
	);
	assert.deepEqual(
		(await loadMemory(app, "kid")).items.en.map((m) => m.text),
		["喜歡恐龍"],
	);
	assert.deepEqual((await loadMemory(app, "nobody")).items.en, []);
});

// ---------- 對話時交給 AI ----------
test("對話的系統提示：有記憶才加；帶日期和今天的日期，要求自然提起、照樣說外語", () => {
	assert.equal(memoryPrompt([], "en", NOW), "");
	const p = memoryPrompt([item("a", "12 月要去東京玩 5 天", "2026-11-02T03:00:00.000Z"), item("b", "常把 since 和 for 用錯", "2026-10-28T03:00:00.000Z")], "ja", NOW);
	assert.match(p, /^\n\nWhat you remember about this learner/);
	assert.match(p, /today is 2026-11-14/);
	assert.match(p, /- \(2026-11-02\) 12 月要去東京玩 5 天\n- \(2026-10-28\) 常把 since 和 for 用錯/);
	assert.match(p, /only when it fits naturally/);
	assert.match(p, /a plan whose date has passed has probably happened/);
	assert.match(p, /trust what they say now/);
	assert.match(p, /Keep speaking Japanese; never switch to Chinese/);
	const many: MemItem[] = [];
	for (let i = 0; i < MEMORY_MAX + 5; i++) many.push(item(`k${i}`, `第 ${i} 件事`));
	assert.equal(memoryPrompt(many, "en", NOW).split("\n").filter((l) => l.startsWith("- (")).length, MEMORY_MAX, "最多帶 20 條");
});

// ---------- 請 AI 整理 ----------
test("給 AI 看的對話內容：學習者的話、對方的回覆、糾正；可以只給後面新的部分；太長只留後面", () => {
	const msgs = [
		model("Hey! How's your week going?"),
		user("I have work in the factory since five years."),
		model("Five years is a long time! Do you like it?", ago(1), ["I have work in the factory since five years.", "I've worked at the factory for five years."]),
		{ role: "model", text: "", ts: ago(1) } as ConvMessage,
		user("Yes.  I go to\nTokyo next month!"),
		model("Nice! How long will you stay?"),
	];
	assert.equal(
		transcriptOf(msgs, "Alex"),
		[
			"Alex: Hey! How's your week going?",
			"Learner: I have work in the factory since five years.",
			`[Alex corrected the learner: "I have work in the factory since five years." → "I've worked at the factory for five years."]`,
			"Alex: Five years is a long time! Do you like it?",
			"Learner: Yes. I go to Tokyo next month!",
			"Alex: Nice! How long will you stay?",
		].join("\n"),
	);
	assert.equal(transcriptOf(msgs, "Alex", 4), "Learner: Yes. I go to Tokyo next month!\nAlex: Nice! How long will you stay?");
	assert.equal(learnerCount(msgs), 2);
	assert.equal(learnerCount(msgs, 2), 1);
	const long = transcriptOf(msgs, "Alex", 0, 80);
	assert.match(long, /^\(The beginning of this conversation is left out because it is long\.\)\n/);
	assert.ok(long.endsWith("Alex: Nice! How long will you stay?"));
	assert.ok(!long.includes("How's your week going"));
});

test("整理的請求：現有的記憶編號 m1、m2…，帶今天和對話的日期、情境；還沒有記憶寫 (none yet)", () => {
	const msgs = [model("Hi!", "2026-11-13T09:00:00.000Z"), user("I will move to Taichung in January.", "2026-11-13T09:01:00.000Z"), user("My cat is Mochi.", "2026-11-13T09:02:00.000Z")];
	const items = [item("k1", "12 月要去東京玩 5 天", "2026-11-02T03:00:00.000Z"), item("k2", "在工廠當工程師", "2026-10-28T03:00:00.000Z")];
	const r = summaryRequest({ items, messages: msgs, from: 0, lang: "en", level: "adult", topic: "restaurant", now: NOW });
	assert.deepEqual([...r.ids], [["m1", "k1"], ["m2", "k2"]]);
	assert.match(r.system, /^You keep the memory notes of Alex, who chats with a language learner in English/);
	assert.match(r.system, /at most 20 notes; there are 2 now/);
	assert.match(r.system, /"add": \["<new note>"\]/);
	assert.match(r.system, /Traditional Chinese \(Taiwan usage\)/);
	assert.match(r.system, /role-play/);
	assert.match(r.prompt, /^Today: 2026-11-14\n\nExisting notes:\nm1 \(2026-11-02\) 12 月要去東京玩 5 天\nm2 \(2026-10-28\) 在工廠當工程師\n\nConversation on 2026-11-13 — scenario: 餐廳點餐 \(Role-play: you are a friendly waiter/);
	assert.match(r.prompt, /Learner: I will move to Taichung in January\.\nLearner: My cat is Mochi\.$/);
	assert.ok(!r.prompt.includes("already processed"));

	const es = summaryRequest({ items: [], messages: msgs, from: 1, lang: "es", level: "kid", topic: "free", now: NOW });
	assert.match(es.system, /^You keep the memory notes of Diego, who chats with a language learner in Latin American Spanish/);
	assert.match(es.prompt, /Existing notes:\n\(none yet\)/);
	assert.match(es.prompt, /\(The earlier part of this conversation was already processed; only the new part is below\.\)\nLearner: I will move/);
	assert.ok(!es.prompt.includes("Hi!"));
});

test("AI 的回覆：新增、改寫、刪除；不認得的編號略過；格式不對當作沒整理成功", () => {
	const ids = new Map([
		["m1", "k1"],
		["m2", "k2"],
	]);
	assert.deepEqual(parseMemoryOps('{"add":["1 月要搬到台中"," - 養了一隻貓叫 Mochi "],"update":[{"id":"m1","text":"去過東京了，玩得很開心"},{"id":"m9","text":"不存在"}],"remove":["m2","m7"]}', ids), {
		add: ["1 月要搬到台中", "養了一隻貓叫 Mochi"],
		update: [{ key: "k1", text: "去過東京了，玩得很開心" }],
		remove: ["k2"],
	});
	assert.deepEqual(parseMemoryOps('```json\n{"add":[],"update":[],"remove":[]}\n```', ids), { add: [], update: [], remove: [] });
	assert.deepEqual(parseMemoryOps('{"add":[{"text":"喜歡喝手沖咖啡"}, 5, null, ""], "remove":[{"id":"m1"}]}', ids), { add: ["喜歡喝手沖咖啡"], update: [], remove: ["k1"] });
	// 一次最多加 4 條、一條最多 60 個字
	const many = parseMemoryOps(J({ add: ["一", "二", "三", "四", "五", "六"] }), ids)!;
	assert.equal(many.add.length, MEMORY_ADD_MAX);
	const long = parseMemoryOps(J({ add: ["長".repeat(200)] }), ids)!;
	assert.equal([...long.add[0]].length, MEMORY_TEXT_MAX);
	for (const bad of ["", "not json", "[]", '"text"', "{}", '{"memories":["x"]}', '{"add":"x"}']) assert.equal(parseMemoryOps(bad, ids), null, bad);
});

test("套用修改：改寫＝舊的拿掉加新的；一樣的不重複加；沒提到的不動", () => {
	let n = 0;
	const key = () => `n${++n}`;
	const items = [item("k1", "12 月要去東京玩 5 天", ago(12)), item("k2", "在工廠當工程師", ago(20)), item("k3", "喜歡喝手沖咖啡", ago(30))];
	const r = applyOps(
		items,
		{
			add: ["1 月要搬到台中", "在工廠當工程師。", "1 月要搬到台中"],
			update: [
				{ key: "k1", text: "去過東京了，最喜歡淺草" },
				{ key: "k3", text: "喜歡喝手沖咖啡" }, // 內容沒變
				{ key: "gone", text: "不存在的" },
			],
			remove: ["nope"],
		},
		ago(0),
		key,
	);
	assert.deepEqual(r.remove, ["k1"]);
	assert.deepEqual(
		r.add.map((m) => [m.key, m.text, m.at]),
		[
			["n1", "去過東京了，最喜歡淺草", ago(0)],
			["n2", "1 月要搬到台中", ago(0)],
		],
	);
	assert.deepEqual(
		r.items.map((m) => m.key),
		["n1", "n2", "k2", "k3"],
		"最新的在前面",
	);
	// 什麼都沒有要改
	assert.deepEqual(applyOps(items, { add: [], update: [], remove: [] }, ago(0), key), { add: [], remove: [], items });
	// 兩條講同一件事：改寫成和另一條一樣＝合併，只留一條
	const merged = applyOps([item("a", "養了一隻貓"), item("b", "貓的名字叫 Mochi")], { add: [], update: [{ key: "a", text: "貓的名字叫 Mochi" }], remove: [] }, ago(0), key);
	assert.deepEqual(merged.remove, ["a"]);
	assert.deepEqual(merged.add, []);
});

test("超過 20 條：從最舊的開始丟（剛加的如果是最舊的就不加）", () => {
	const items: MemItem[] = [];
	for (let i = 0; i < MEMORY_MAX; i++) items.push(item(`k${i}`, `第 ${i} 件事`, ago(i + 1)));
	let n = 0;
	const r = applyOps(items, { add: ["新的事一", "新的事二"], update: [], remove: [] }, ago(0), () => `n${++n}`);
	assert.equal(r.items.length, MEMORY_MAX);
	assert.deepEqual(r.remove.sort(), ["k18", "k19"], "最舊的兩條被擠掉");
	assert.equal(r.add.length, 2);
	// 補整理很久以前的對話：新整理出來的比現有的都舊，就不擠掉別人
	const old = applyOps(items, { add: ["很久以前的事"], update: [], remove: [] }, ago(99), () => "old");
	assert.deepEqual(old, { add: [], remove: [], items });
});

// ---------- 哪些對話要整理 ----------
const conv = (o: { user?: string; lang?: "en" | "es" | "ja"; device?: string; started: string; msgs: ConvMessage[]; level?: "adult" | "kid"; topic?: string }) =>
	convHeader({ user: o.user ?? "ray", level: o.level ?? "adult", ...(o.lang && o.lang !== "en" ? { lang: o.lang } : {}), topic: o.topic ?? "free", topicLabel: "自由聊天", device: o.device ?? "ipad-1", started: o.started }) +
	o.msgs.map(convBlock).join("");
const chatty = (ts = ago(1)) => [model("Hi! How are you?", ts), user("I am fine. I start a new job in Hsinchu.", ts), model("Congrats! What's the job?", ts), user("I am a nurse.", ts), model("That's hard work.", ts)];

test("對話檔開頭的資料直接從內容讀（不靠 Obsidian 的索引）", () => {
	const md = conv({ user: "2026", lang: "ja", device: "win-1", started: "2026-11-13T09:00:00.000Z", msgs: chatty(), level: "kid", topic: "school" });
	assert.deepEqual(parseConvMeta(md), { user: "2026", level: "kid", lang: "ja", topic: "school", topicLabel: "自由聊天", device: "win-1", started: "2026-11-13T09:00:00.000Z" });
	assert.equal(parseConvMeta(md.replace(/\n/g, "\r\n"))?.user, "2026", "換行是 CRLF 也讀得到");
	assert.equal(parseConvMeta("# 沒有 frontmatter 的筆記"), null);
	assert.equal(parseConvMeta("---\ntitle: x\n---\n"), null, "沒有 user 的不是對話檔");
	assert.equal(parseConvMeta(conv({ started: "x", msgs: [] }))?.lang, "en");
});

test("還沒整理的部分：學習者至少說了兩句才整理；整理過的只看後面新的", () => {
	const state = replayMemory([ev({ conv: "conversations/a.md", count: 5 })]);
	const msgs = chatty();
	assert.equal(pendingFrom("conversations/new.md", msgs, state), 0);
	assert.equal(pendingFrom("conversations/new.md", msgs.slice(0, 3), state), -1, "只說了一句");
	assert.equal(pendingFrom("conversations/a.md", msgs, state), -1, "整理過了");
	assert.equal(pendingFrom("conversations/a.md", [...msgs, user("One more thing."), model("Yes?")], state), -1, "新的只有一句");
	assert.equal(pendingFrom("conversations/a.md", [...msgs, user("One more thing."), model("Yes?"), user("I bought a bike.")], state), 5);
});

test("補整理挑哪些：這位使用者、這個語言、最近 30 天、最多 2 個（最近的），照時間順序", async () => {
	const { app } = makeApp(
		new Map<string, string>([
			["conversations/2026-11-10-ipad-1-1.md", conv({ started: ago(4), msgs: chatty(ago(4)) })],
			["conversations/2026-11-12-ipad-1-1.md", conv({ started: ago(2), msgs: chatty(ago(2)) })],
			["conversations/2026-11-13-ipad-1-1.md", conv({ started: ago(1), msgs: chatty(ago(1)) })],
			["conversations/2026-11-13-ipad-1-2.md", conv({ started: ago(1), msgs: chatty().slice(0, 3) })], // 只說了一句
			["conversations/2026-11-13-ipad-1-3.md", conv({ user: "kid", started: ago(1), msgs: chatty() })],
			["conversations/2026-11-13-ipad-1-4.md", conv({ lang: "es", started: ago(1), msgs: chatty() })],
			["conversations/2026-10-01-ipad-1-1.md", conv({ started: ago(44), msgs: chatty(ago(44)) })], // 太久以前
			["conversations/2026-11-14-win-1-1.md", conv({ device: "win-1", started: ago(0.01), msgs: chatty(new Date(NOW.getTime() - 5 * 60_000).toISOString()) })], // 別台裝置、5 分鐘前還在聊
			["conversations/2026-11-11-win-1-1.md", conv({ device: "win-1", started: ago(3), msgs: chatty(ago(3)) })], // 別台裝置、很久沒動
			["conversations/readme.md", "不是對話檔"],
		]),
	);
	const convs = await recentConvs(app, NOW);
	assert.equal(convs.length, 8, "太久以前的和不是對話的不讀");
	const none = replayMemory([]);
	const pick = (state = none, o: Partial<Parameters<typeof pickCatchUp>[2]> = {}) => pickCatchUp(convs, state, { user: "ray", lang: "en", deviceId: "ipad-1", now: NOW, ...o }).map((c) => c.path);
	assert.deepEqual(pick(), ["conversations/2026-11-12-ipad-1-1.md", "conversations/2026-11-13-ipad-1-1.md"]);
	// 整理過的不再挑；輪到比較舊的和別台裝置的
	const done = replayMemory([ev({ conv: "conversations/2026-11-12-ipad-1-1.md", count: 5 }), ev({ conv: "conversations/2026-11-13-ipad-1-1.md", count: 5 })]);
	assert.deepEqual(pick(done), ["conversations/2026-11-10-ipad-1-1.md", "conversations/2026-11-11-win-1-1.md"]);
	assert.deepEqual(pick(none, { lang: "es" }), ["conversations/2026-11-13-ipad-1-4.md"]);
	assert.deepEqual(pick(none, { user: "kid" }), ["conversations/2026-11-13-ipad-1-3.md"]);
	assert.deepEqual(pick(none, { skip: new Set(["conversations/2026-11-13-ipad-1-1.md"]) }), ["conversations/2026-11-11-win-1-1.md", "conversations/2026-11-12-ipad-1-1.md"]);
	// 在電腦上：iPad 開始的對話也可以幫忙整理（最後一句超過 30 分鐘），自己 5 分鐘前的那個當然可以
	assert.deepEqual(pick(none, { deviceId: "win-1" }), ["conversations/2026-11-13-ipad-1-1.md", "conversations/2026-11-14-win-1-1.md"]);
	// 半個月前的對話也補得到（30 天內）；一個多月前的不補
	const older = replayMemory(["conversations/2026-11-10-ipad-1-1.md", "conversations/2026-11-11-win-1-1.md", "conversations/2026-11-12-ipad-1-1.md", "conversations/2026-11-13-ipad-1-1.md"].map((c) => ev({ conv: c, count: 5 })));
	const { app: app2 } = makeApp(
		new Map<string, string>([
			["conversations/2026-10-29-ipad-1-1.md", conv({ started: ago(16), msgs: chatty(ago(15)) })],
			["conversations/2026-10-01-ipad-1-1.md", conv({ started: ago(44), msgs: chatty(ago(44)) })],
		]),
	);
	assert.deepEqual(
		pickCatchUp(await recentConvs(app2, NOW), older, { user: "ray", lang: "en", deviceId: "win-1", now: NOW }).map((c) => c.path),
		["conversations/2026-10-29-ipad-1-1.md"],
	);
	// 記憶關掉又打開：打開以前開始的對話不補整理
	assert.deepEqual(pick(replayMemory([ev({ since: ago(1.5) })])), ["conversations/2026-11-13-ipad-1-1.md"]);
	assert.deepEqual(pick(replayMemory([ev({ since: ago(0.5) })])), []);
});

// ---------- 排程 ----------
function manager(files: [string, string][], replies: (object | string | Error)[], over: Record<string, unknown> = {}) {
	const { app, files: store, ls } = makeApp(new Map<string, string>(files));
	const calls: { prompt: string; system: string }[] = [];
	const debugs: string[] = [];
	const host: any = {
		app,
		deviceId: "ipad-1",
		getApiKey: () => "k",
		remembers: () => true,
		fastBackend: () => ({
			complete: async (prompt: string, o: { system: string }) => {
				calls.push({ prompt, system: o.system });
				const r = replies.shift() ?? { add: [] };
				if (r instanceof Error) throw r;
				return { text: typeof r === "string" ? r : J(r), usage: {}, model: "m" };
			},
		}),
		appendMemory: async (e: MemEvent) => {
			const p = memoryPath(e.user, "ipad-1");
			store.set(p, String(store.get(p) ?? "") + J(e) + "\n");
		},
		flushWrites: async () => undefined,
		debug: (m: string) => debugs.push(m),
		...over,
	};
	let now = NOW;
	const m = new MemoryManager(host, () => now);
	const events = (u = "ray") =>
		String(store.get(memoryPath(u, "ipad-1")) ?? "")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as MemEvent);
	return { m, app, store, ls, calls, debugs, host, events, setNow: (d: Date) => (now = d) };
}
const C1 = "conversations/2026-11-13-ipad-1-1.md";

test("整理一個對話：寫進這台裝置的記憶檔，記下整理到第幾則；再叫一次不會重複整理", async () => {
	const { m, calls, events } = manager([[C1, conv({ started: ago(1), msgs: chatty("2026-11-13T09:00:00.000Z") })]], [{ add: ["剛到新竹的醫院當護理師"], update: [], remove: [] }]);
	const changes: number[] = [];
	m.onChange(() => changes.push(1));
	assert.equal(await m.remember(C1), "updated");
	assert.equal(calls.length, 1);
	const e = events()[0];
	assert.deepEqual(
		{ type: e.type, user: e.user, device: e.device, conv: e.conv, count: e.count, by: e.by, lang: e.lang, remove: e.remove },
		{ type: "mem", user: "ray", device: "ipad-1", conv: C1, count: 5, by: "ai", lang: undefined, remove: undefined },
	);
	assert.equal(e.add![0].text, "剛到新竹的醫院當護理師");
	assert.equal(e.add![0].at, "2026-11-13T09:00:00.000Z", "記憶的日期是那次對話的時間");
	assert.deepEqual(
		(await m.list("ray", "en")).map((x) => x.text),
		["剛到新竹的醫院當護理師"],
	);
	assert.deepEqual(await m.list("ray", "es"), []);
	assert.equal(changes.length, 1);
	assert.equal(m.busy, false);
	assert.equal(await m.remember(C1), "skipped", "已經整理到最後了");
	assert.equal(calls.length, 1);
});

test("沒有值得記的：照樣記下「整理過了」，之後不再問 AI", async () => {
	const { m, calls, events } = manager([[C1, conv({ started: ago(1), msgs: chatty() })]], [{ add: [], update: [], remove: [] }]);
	assert.equal(await m.remember(C1), "nothing");
	assert.deepEqual(Object.keys(events()[0]).sort(), ["by", "conv", "count", "device", "id", "ts", "type", "user"]);
	assert.equal(await m.remember(C1), "skipped");
	assert.equal(calls.length, 1);
});

test("西班牙文的對話記在西班牙文的記憶；現有的英文記憶不會交給它", async () => {
	const { m, calls, events } = manager(
		[
			[C1, conv({ lang: "es", started: ago(1), msgs: chatty() })],
			["english/memory/ray/win-1.jsonl", J(ev({ device: "win-1", ts: ago(3), add: [item("k1", "12 月要去東京玩 5 天", ago(3))] })) + "\n"],
		],
		[{ add: ["在新竹當護理師"] }],
	);
	assert.equal(await m.remember(C1), "updated");
	assert.match(calls[0].system, /^You keep the memory notes of Sofía/);
	assert.match(calls[0].prompt, /Existing notes:\n\(none yet\)/);
	assert.equal(events()[0].lang, "es");
	assert.deepEqual(
		(await m.list("ray", "es")).map((x) => x.text),
		["在新竹當護理師"],
	);
	assert.deepEqual(
		(await m.list("ray", "en")).map((x) => x.text),
		["12 月要去東京玩 5 天"],
	);
});

test("排隊：一次整理一個，後面的看得到前面整理的結果；同一個對話排兩次只做一次", async () => {
	const C2 = "conversations/2026-11-13-ipad-1-2.md";
	const { m, calls } = manager(
		[
			[C1, conv({ started: ago(2), msgs: chatty(ago(2)) })],
			[C2, conv({ started: ago(1), msgs: chatty(ago(1)) })],
		],
		[{ add: ["在新竹當護理師"] }, { add: [], update: [{ id: "m1", text: "在新竹的醫院當護理師，剛換工作" }], remove: [] }],
	);
	const a = m.remember(C1);
	const a2 = m.remember(C1);
	const b = m.remember(C2);
	assert.equal(a, a2);
	assert.equal(m.busy, true);
	assert.equal(await m.settle(1000), true);
	assert.deepEqual([await a, await b], ["updated", "updated"]);
	assert.equal(calls.length, 2);
	assert.match(calls[1].prompt, /Existing notes:\nm1 \(\d{4}-\d\d-\d\d\) 在新竹當護理師/, "第二個對話看得到第一個整理出來的");
	assert.deepEqual(
		(await m.list("ray", "en")).map((x) => x.text),
		["在新竹的醫院當護理師，剛換工作"],
	);
});

test("沒整理成功：不寫記憶、不算整理過。AI 回的內容不能用算一次失敗；額度、網路的問題不算", async () => {
	const { m, events, ls, debugs, calls } = manager(
		[[C1, conv({ started: ago(1), msgs: chatty() })]],
		["這不是 JSON", new AIError("今天的額度用完了", 429, "", "daily"), new AIError("沒有網路", undefined, "", "network"), new AIError("HTTP 400", 400, "", "other"), { add: ["在新竹當護理師"] }],
	);
	assert.equal(await m.remember(C1), "failed");
	assert.deepEqual(ls.get(LS_MEMORY_FAIL), { [C1]: 1 });
	assert.equal(await m.remember(C1), "failed");
	assert.equal(await m.remember(C1), "failed");
	assert.deepEqual(ls.get(LS_MEMORY_FAIL), { [C1]: 1 }, "額度用完、沒有網路不算這個對話的錯");
	assert.equal(await m.remember(C1), "failed");
	assert.deepEqual(ls.get(LS_MEMORY_FAIL), { [C1]: 2 });
	assert.equal(events().length, 0);
	assert.ok(debugs.some((d) => /unusable reply: 這不是 JSON/.test(d)));
	// 失敗兩次：補整理不再自動試；但按「結束對話」那種直接叫的還是會做
	assert.equal(await m.catchUp("ray", "en"), 0);
	assert.equal(calls.length, 4);
	assert.equal(await m.remember(C1), "updated");
});

test("不用整理的情況：離線、沒有 API key、這位使用者關掉了、檔案不見了", async () => {
	const files: [string, string][] = [[C1, conv({ started: ago(1), msgs: chatty() })]];
	const off = manager(files, [], { remembers: () => false });
	assert.equal(await off.m.remember(C1), "skipped");
	assert.equal(await off.m.catchUp("ray", "en"), 0);
	const nokey = manager(files, [], { getApiKey: () => null });
	assert.equal(await nokey.m.remember(C1), "skipped");
	const gone = manager(files, []);
	assert.equal(await gone.m.remember("conversations/none.md"), "skipped");
	const offline = manager(files, []);
	(navigator as any).onLine = false;
	try {
		assert.equal(await offline.m.remember(C1), "skipped");
		assert.equal(await offline.m.catchUp("ray", "en"), 0);
	} finally {
		(navigator as any).onLine = true;
	}
	for (const x of [off, nokey, gone, offline]) assert.equal(x.calls.length, 0);
	// 剛剛離線沒看到的，連上以後馬上可以補（離線那次不算「看過了」）
	assert.equal(await offline.m.catchUp("ray", "en"), 1);
});

test("補整理：排進去照順序做；10 分鐘內不重複看", async () => {
	const C0 = "conversations/2026-11-12-ipad-1-1.md";
	const x = manager(
		[
			[C0, conv({ started: ago(2), msgs: chatty(ago(2)) })],
			[C1, conv({ started: ago(1), msgs: chatty(ago(1)) })],
		],
		[{ add: ["在新竹當護理師"] }, { add: ["養了一隻狗叫 Biscuit"] }],
	);
	assert.equal(await x.m.catchUp("ray", "en"), 2);
	assert.equal(x.m.busy, true);
	assert.equal(await x.m.catchUp("ray", "en"), 0, "剛看過");
	await x.m.settle(1000);
	assert.match(x.calls[0].prompt, /Conversation on 2026-11-12/);
	assert.match(x.calls[1].prompt, /Conversation on 2026-11-13/);
	assert.equal((await x.m.list("ray", "en")).length, 2);
	// 又有一個沒結束的對話：10 分鐘後才會再看
	x.store.set("conversations/2026-11-14-ipad-1-1.md", conv({ started: ago(0), msgs: chatty(ago(0)) }));
	x.setNow(new Date(NOW.getTime() + CATCHUP_EVERY_MS - 1000));
	assert.equal(await x.m.catchUp("ray", "en"), 0);
	x.setNow(new Date(NOW.getTime() + CATCHUP_EVERY_MS + 1000));
	assert.equal(await x.m.catchUp("ray", "en"), 1);
	await x.m.settle(1000);
});

test("刪掉記憶、重新打開記憶：寫進記憶檔，重播後生效", async () => {
	const x = manager([["english/memory/ray/ipad-1.jsonl", J(ev({ ts: ago(3), add: [item("k1", "12 月要去東京玩 5 天", ago(3)), item("k2", "在工廠當工程師", ago(3))] })) + "\n"]], []);
	let changed = 0;
	const offFn = x.m.onChange(() => changed++);
	await x.m.forget("ray", "en", ["k1"]);
	await x.m.forget("ray", "en", []);
	assert.equal(changed, 1);
	assert.deepEqual(
		(await x.m.list("ray", "en")).map((i) => i.key),
		["k2"],
	);
	const last = x.events().pop()!;
	assert.deepEqual({ remove: last.remove, by: last.by }, { remove: ["k1"], by: "user" });
	offFn();
	await x.m.forget("ray", "en", ["k2"]);
	assert.equal(changed, 1, "取消之後不再通知");
	await x.m.markSince("ray");
	assert.equal((await loadMemory(x.app, "ray")).since, NOW.toISOString());
});

// ---------- 刪除使用者、備份 ----------
test("刪除使用者：他的記憶也刪掉，備份裡的也拿掉；備份和還原包含記憶", async () => {
	assert.ok(BACKUP_ROOTS.includes(MEMORY_DIR));
	const mem = J(ev({ add: [item("k1", "在學吉他")] })) + "\n";
	const { app, files } = makeApp(
		new Map<string, string>([
			["english/memory/amy/ipad-1.jsonl", mem],
			["english/memory/amy/win-1.jsonl", mem],
			["english/memory/ray/ipad-1.jsonl", mem],
			["logs/ray/ipad-1.jsonl", '{"id":"a"}\n'],
		]),
	);
	const b = await backupNow(app, "ipad-1");
	const saved = JSON.parse(String(files.get(b.path)));
	assert.ok(saved.files["english/memory/amy/ipad-1.jsonl"]);
	assert.equal(stripBackupFiles({ "english/memory/amy/x.jsonl": "", "english/memory/amyx/x.jsonl": "", "english/memory/ray/x.jsonl": "" }, "amy"), 1);
	const r = await deleteUserData(app, "amy");
	assert.equal(r.files, 2);
	assert.equal(r.backups, 1);
	assert.deepEqual(
		[...files.keys()].filter((k) => k.startsWith("english/memory/")),
		["english/memory/ray/ipad-1.jsonl"],
	);
	assert.deepEqual(Object.keys(JSON.parse(String(files.get(b.path))).files).sort(), ["english/memory/ray/ipad-1.jsonl", "logs/ray/ipad-1.jsonl"]);
	// 記憶檔不見了：從備份補回來
	files.delete("english/memory/ray/ipad-1.jsonl");
	await restoreBackup(app, listBackups(app)[0].file);
	assert.equal(files.get("english/memory/ray/ipad-1.jsonl"), mem);
});
