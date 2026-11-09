import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SEED_TS, checkNewName, convUser, deleteUserData, replayUsers, seedEvents, stripBackupFiles } from "../src/users";
import { DeleteUserModal, drawUsersSection } from "../src/userview";
import { makeApp } from "./helpers/app";

let n = 0;
const id = () => "u" + n++;
const ev = (type: "user-add" | "user-remove", name: string, ts: string, level?: "adult" | "kid") => ({ id: id(), ts, device: "d1", type, name, level });

test("使用者清單：舊設定當最早的新增，之後的刪除與新增都蓋得過", () => {
	const seeds = seedEvents(["ray", "kid"], "d1", id);
	assert.equal(seeds[0].ts, SEED_TS);
	assert.deepEqual(
		replayUsers(seeds).map((u) => [u.name, u.level]),
		[["kid", "kid"], ["ray", "adult"]].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
	);
	const later = [
		...seeds,
		ev("user-add", "amy", "2026-11-01T00:00:00Z", "kid"),
		ev("user-remove", "kid", "2026-11-02T00:00:00Z"),
		// 別台裝置之後才寫的舊設定 seed：時間是 1970，不會讓 kid 復活
		...seedEvents(["ray", "kid"], "d2", id),
	];
	const users = replayUsers(later);
	assert.deepEqual(users.map((u) => u.name), ["ray", "amy"]);
	assert.equal(users.find((u) => u.name === "amy")!.level, "kid");
	// 刪掉後再建立同名：重新出現
	assert.ok(replayUsers([...later, ev("user-add", "kid", "2026-11-03T00:00:00Z", "adult")]).some((u) => u.name === "kid" && u.level === "adult"));
	// 同一筆（UUID）重複出現只算一次
	const dup = ev("user-add", "bob", "2026-11-04T00:00:00Z");
	assert.equal(replayUsers([dup, dup]).length, 1);
});

test("名字檢查", () => {
	assert.equal(checkNewName("Amy", ["ray"]), null);
	assert.match(checkNewName("小明", [])!, /英文字母/);
	assert.match(checkNewName("ray", ["ray"])!, /已經有/);
	assert.match(checkNewName("  ", [])!, /請輸入/);
});

test("刪除使用者：他的紀錄、對話、報告與備份裡的資料都刪掉，其他人的不動", async () => {
	const conv = (u: string) => `---\nuser: ${u}\nlevel: adult\ntopic: free\n---\n\n# 英文對話\n`;
	const backup = {
		version: 1,
		files: {
			"logs/amy/win-1.jsonl": "{}\n",
			"logs/ray/win-1.jsonl": "{}\n",
			"conversations/2026-10-01-win-1-1.md": conv("amy"),
			"conversations/2026-10-01-win-1-2.md": conv("ray"),
			"english/reports/amy/r.md": "# r",
			"english/sources/A.md": "text",
		},
	};
	const { app, files } = makeApp(
		new Map<string, string>([
			["logs/amy/win-1.jsonl", "{}\n"],
			["logs/amy/ipad-1.jsonl", "{}\n"],
			["logs/amyx/ipad-1.jsonl", "{}\n"], // 名字開頭一樣的別人
			["logs/ray/win-1.jsonl", "{}\n"],
			["conversations/2026-10-01-win-1-1.md", conv("amy")],
			["conversations/2026-10-01-win-1-2.md", conv("ray")],
			["english/reports/amy/r.md", "# r"],
			["english/sources/A.md", "text"],
			["backup/ipad-1/2026-10-01.json", JSON.stringify(backup)],
		]),
	);
	const r = await deleteUserData(app, "amy");
	assert.equal(r.files, 4);
	assert.equal(r.backups, 1);
	assert.deepEqual(
		[...files.keys()].sort(),
		["backup/ipad-1/2026-10-01.json", "conversations/2026-10-01-win-1-2.md", "english/sources/A.md", "logs/amyx/ipad-1.jsonl", "logs/ray/win-1.jsonl"],
	);
	const b = JSON.parse(String(files.get("backup/ipad-1/2026-10-01.json")));
	assert.deepEqual(Object.keys(b.files).sort(), ["conversations/2026-10-01-win-1-2.md", "english/sources/A.md", "logs/ray/win-1.jsonl"]);
	assert.equal(convUser(conv("ray")), "ray");
	assert.equal(stripBackupFiles({ "logs/ray/a.jsonl": "" }, "amy"), 0);
});

test("設定頁：列出使用者與程度；刪除要輸入名字才能按", async () => {
	const removed: string[] = [];
	const plugin: any = {
		app: makeApp().app,
		user: "ray", lang: "en",
		users: () => [
			{ name: "ray", level: "adult", created: "" },
			{ name: "amy", level: "kid", created: "" },
		],
		userNames: () => ["ray", "amy"],
		removeUser: async (name: string) => (removed.push(name), { files: 3, backups: 0 }),
		prefs: { ray: 100 } as Record<string, number>,
		chatMemoryOf: (n: string) => plugin.prefs[n] ?? 50,
		setUserPref: async (n: string, k: string, v: number) => void (plugin.prefs[n] = v),
	};
	const el = document.createElement("div");
	drawUsersSection(el, plugin, () => undefined);
	const buttons = [...el.querySelectorAll("button")].map((b) => b.textContent);
	assert.deepEqual(buttons, ["刪除…", "刪除…", "＋ 新增使用者…"]);
	// 每位使用者自己的對話記憶長度
	const selects = [...el.querySelectorAll("select")] as HTMLSelectElement[];
	assert.equal(selects.length, 2);
	assert.deepEqual(
		[...selects[0].options].map((o) => o.textContent),
		["最近 24 則", "最近 50 則（預設）", "最近 100 則", "整段對話"],
	);
	assert.equal(selects[0].value, "100", "ray 已設 100");
	assert.equal(selects[1].value, "50", "amy 沒設＝預設 50");
	selects[1].value = "0";
	selects[1].dispatchEvent(new (window as any).Event("change"));
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(plugin.prefs.amy, 0);

	const m: any = new DeleteUserModal(plugin.app, plugin, "amy");
	m.open();
	const del = [...m.contentEl.querySelectorAll("button")].find((b: any) => b.textContent === "刪除") as HTMLButtonElement;
	const input = m.contentEl.querySelector("input") as HTMLInputElement;
	assert.ok(del.disabled);
	input.value = "ray";
	input.dispatchEvent(new window.Event("input"));
	assert.ok(del.disabled);
	input.value = "amy";
	input.dispatchEvent(new window.Event("input"));
	assert.ok(!del.disabled);
	del.click();
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(removed, ["amy"]);
});

test("檢查修正：讀某位使用者這個月的 Google Cloud 語音字數（刪除時要轉記，免得每月上限少算）", async () => {
	const { readCloudUsage, cloudMonth } = await import("../src/cloudtts");
	const m = cloudMonth();
	const line = (id: string, chars: number, month = m) => JSON.stringify({ id, ts: "", type: "tts", source: "cloud", chars, month });
	const { app } = makeApp(
		new Map<string, string>([
			["logs/amy/ipad-1.jsonl", [line("1", 300), line("2", 200), line("3", 999, "2000-01")].join("\n") + "\n"],
			["logs/ray/ipad-1.jsonl", line("4", 50) + "\n"],
		]),
	);
	assert.equal(await readCloudUsage(app, m, "logs/amy"), 500);
	assert.equal(await readCloudUsage(app, m), 550);
});

test("主畫面（書本圖示）可以選使用者、新增使用者、選語言", async () => {
	const { HomeView } = await import("../src/views");
	const { app } = makeApp();
	const plugin: any = {
		app,
		user: "ray",
		lang: "en",
		deviceId: "ipad-1",
		generating: new Set(),
		users: () => [
			{ name: "ray", level: "adult", created: "" },
			{ name: "amy", level: "kid", created: "" },
		],
		userNames: () => ["ray", "amy"],
		openView: () => undefined,
	};
	const view: any = new HomeView({ app } as any, plugin);
	view.render();
	const sel = view.contentEl.querySelector("select.el-user-select") as HTMLSelectElement;
	assert.deepEqual([...sel.options].map((o) => o.textContent), ["ray", "amy（小孩）"]);
	assert.equal(sel.value, "ray");
	sel.value = "amy";
	sel.dispatchEvent(new window.Event("change"));
	assert.equal(plugin.user, "amy");
	assert.ok([...view.contentEl.querySelectorAll("button")].some((b: any) => b.textContent === "＋ 新增使用者"));
	// 刪除：開的是選單上目前選的使用者，要輸入名字才能按
	const del = [...view.contentEl.querySelectorAll("button")].find((b: any) => b.textContent === "刪除使用者…") as HTMLButtonElement;
	assert.ok(del && !del.disabled);
	del.click();
	const m: any = (globalThis as any).__lastModal;
	assert.match(m.title, /刪除使用者「amy」/);
	assert.ok(view.contentEl.querySelector("select.el-lang-select"));
});

test("每位使用者自己的對話記憶長度：user-set 最後一筆為準；刪掉的人不會因設定復活；不合法的值用預設 50", async () => {
	const { CHAT_MEMORY_DEFAULT, normalizeChatMemory, chatMemoryLabel } = await import("../src/users");
	const e = (type: string, name: string, ts: string, extra: Record<string, unknown> = {}) => ({ id: `${type}-${name}-${ts}`, ts, device: "pc", type, name, ...extra }) as any;
	const evs = [
		e("user-add", "ray", "2026-11-01T00:00:00Z", { level: "adult" }),
		e("user-add", "amy", "2026-11-01T00:00:01Z", { level: "kid" }),
		e("user-set", "ray", "2026-11-02T00:00:00Z", { key: "chatMemory", value: 100 }),
		e("user-set", "ray", "2026-11-03T00:00:00Z", { key: "chatMemory", value: 0 }),
		e("user-set", "ghost", "2026-11-03T00:00:00Z", { key: "chatMemory", value: 24 }),
	];
	const users = replayUsers(evs);
	assert.deepEqual(
		users.map((u) => [u.name, u.prefs.chatMemory]),
		[["ray", 0], ["amy", undefined]],
	);
	assert.ok(!users.some((u) => u.name === "ghost"));
	const again = replayUsers([...evs, e("user-add", "ray", "2026-11-04T00:00:00Z", { level: "kid" })]);
	assert.equal(again.find((u) => u.name === "ray")!.prefs.chatMemory, 0, "改程度不會清掉設定");
	const removed = replayUsers([...evs, e("user-remove", "ray", "2026-11-05T00:00:00Z"), e("user-add", "ray", "2026-11-06T00:00:00Z", { level: "adult" })]);
	assert.equal(removed.find((u) => u.name === "ray")!.prefs.chatMemory, undefined, "刪掉再建立是新的人");
	assert.equal(normalizeChatMemory(undefined), CHAT_MEMORY_DEFAULT);
	assert.equal(normalizeChatMemory(37), 50);
	assert.equal(normalizeChatMemory("100"), 100);
	assert.equal(normalizeChatMemory(0), 0);
	assert.equal(chatMemoryLabel(0), "整段對話");
	assert.equal(chatMemoryLabel(24), "最近 24 則");
});

test("送給 AI 的歷史依記憶長度截取；0＝整段對話", async () => {
	const { historyTurns } = await import("../src/chat");
	const msgs = Array.from({ length: 120 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: `m${i}` })) as any;
	const count = (max?: number) => historyTurns(msgs, max).reduce((n, t) => n + t.text.split("\n").filter((x) => /^m\d+$/.test(x)).length, 0);
	assert.equal(count(24), 24);
	assert.equal(count(), 50, "預設 50");
	assert.equal(count(100), 100);
	assert.equal(count(0), 120);
});
