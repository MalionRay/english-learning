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
	};
	const el = document.createElement("div");
	drawUsersSection(el, plugin, () => undefined);
	const buttons = [...el.querySelectorAll("button")].map((b) => b.textContent);
	assert.deepEqual(buttons, ["刪除…", "刪除…", "＋ 新增使用者…"]);

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
