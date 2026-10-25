import { test } from "node:test";
import assert from "node:assert/strict";
import { backupNow, listBackups, restoreBackup } from "../src/backup";
import { makeApp } from "./helpers/app";

test("備份只保留 4 份，還原只補缺少的內容", async () => {
	const { app, files } = makeApp(
		new Map<string, string>([
			["logs/ray/ipad-1.jsonl", '{"id":"a"}\n{"id":"b"}\n'],
			["english/sources/S.md", "article"],
		]),
	);
	for (const d of ["2026-01-01", "2026-01-08", "2026-01-15", "2026-01-22", "2026-01-29"]) files.set(`backup/ipad-1/${d}.json`, "{}");
	const r = await backupNow(app, "ipad-1");
	assert.equal(r.files, 2);
	assert.equal([...files.keys()].filter((k) => k.startsWith("backup/")).length, 4);

	// 模擬誤刪：少一行、少一個檔，另外新增一行
	files.set("logs/ray/ipad-1.jsonl", '{"id":"a"}\n{"id":"c"}\n');
	files.delete("english/sources/S.md");
	files.set("english/sources/S2.md", "keep");
	const info = listBackups(app).find((b) => b.file.path === r.path)!;
	const res = await restoreBackup(app, info.file);
	assert.deepEqual(res, { created: 1, linesAdded: 1, kept: 0 });
	assert.equal(files.get("logs/ray/ipad-1.jsonl"), '{"id":"a"}\n{"id":"c"}\n{"id":"b"}\n');
	assert.equal(files.get("english/sources/S.md"), "article");
	assert.equal(files.get("english/sources/S2.md"), "keep");
});
