// 自動備份：把答題紀錄、文章、題庫打包成一個 JSON 檔，存到 backup/<deviceId>/。
// 同步會把刪除也同步出去，所以 log 被誤刪時，這份備份（以及 Dropbox 的版本紀錄）是救援用的。
// 每台裝置只寫自己的資料夾（單一寫入者），只保留最近幾份。
import { App, TFile, normalizePath } from "obsidian";
import { LOG_ROOT, listRecursive } from "./logs";
import { BANK_DIR, SOURCES_DIR } from "./sources";
import { FIX_DIR } from "./fixes";
import { CONV_DIR } from "./chat";

export const BACKUP_DIR = "backup";
export const LS_LAST_BACKUP = "english-learning:last-backup";
const KEEP = 4;
const EVERY_DAYS = 7;

export interface BackupResult {
	path: string;
	files: number;
	bytes: number;
}

function localDate(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function ensureFolder(app: App, folder: string) {
	let cur = "";
	for (const p of normalizePath(folder).split("/")) {
		cur = cur ? `${cur}/${p}` : p;
		if (!(await app.vault.adapter.exists(cur))) await app.vault.createFolder(cur).catch(() => undefined);
	}
}

export async function backupNow(app: App, deviceId: string): Promise<BackupResult> {
	const files: Record<string, string> = {};
	for (const dir of [LOG_ROOT, SOURCES_DIR, BANK_DIR, FIX_DIR, CONV_DIR]) {
		for (const path of await listRecursive(app, dir)) {
			if (!/\.(jsonl|md)$/.test(path)) continue;
			files[path] = await app.vault.adapter.read(path);
		}
	}
	const body = JSON.stringify({ version: 1, createdAt: new Date().toISOString(), device: deviceId, files });
	const folder = normalizePath(`${BACKUP_DIR}/${deviceId}`);
	await ensureFolder(app, folder);
	const path = normalizePath(`${folder}/${localDate()}.json`);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) await app.vault.modify(existing, body);
	else await app.vault.create(path, body);

	// 只保留最近 KEEP 份（只刪自己資料夾裡的舊備份）
	const mine = app.vault
		.getFiles()
		.filter((f) => f.path.startsWith(folder + "/") && /^\d{4}-\d{2}-\d{2}$/.test(f.basename))
		.sort((a, b) => (a.basename < b.basename ? 1 : -1));
	for (const old of mine.slice(KEEP)) await app.vault.delete(old).catch(() => undefined);

	app.saveLocalStorage(LS_LAST_BACKUP, new Date().toISOString());
	return { path, files: Object.keys(files).length, bytes: body.length };
}

/** 距離上次備份超過 7 天才備份。 */
export async function maybeAutoBackup(app: App, deviceId: string): Promise<BackupResult | null> {
	const last = app.loadLocalStorage(LS_LAST_BACKUP);
	if (typeof last === "string" && Date.now() - Date.parse(last) < EVERY_DAYS * 24 * 3600 * 1000) return null;
	return backupNow(app, deviceId);
}

// ---------------------------------------------------------------------
// 還原（合併）：不覆蓋任何現有內容
//   - 檔案不存在 → 從備份建立
//   - .jsonl 已存在 → 只補上備份裡有、現在沒有的那幾行（依每行的 UUID 判斷）
//   - .md 已存在 → 保留現在的版本

export interface BackupInfo {
	file: TFile;
	device: string;
	date: string;
}

export function listBackups(app: App): BackupInfo[] {
	return app.vault
		.getFiles()
		.filter((f) => f.path.startsWith(BACKUP_DIR + "/") && f.extension === "json" && /^\d{4}-\d{2}-\d{2}$/.test(f.basename))
		.map((f) => ({ file: f, device: f.parent?.name ?? "", date: f.basename }))
		.sort((a, b) => (a.date === b.date ? (a.device < b.device ? -1 : 1) : a.date < b.date ? 1 : -1));
}

export interface RestoreResult {
	created: number;
	linesAdded: number;
	kept: number;
}

function lineId(line: string): string | null {
	try {
		const id = JSON.parse(line)?.id;
		return typeof id === "string" ? id : null;
	} catch {
		return null;
	}
}

export async function restoreBackup(app: App, file: TFile): Promise<RestoreResult> {
	const data = JSON.parse(await app.vault.read(file)) as { files?: Record<string, string> };
	const res: RestoreResult = { created: 0, linesAdded: 0, kept: 0 };
	for (const [path, content] of Object.entries(data.files ?? {})) {
		if (typeof content !== "string" || !/\.(jsonl|md)$/.test(path) || path.includes("..")) continue;
		const p = normalizePath(path);
		if (!(await app.vault.adapter.exists(p))) {
			await ensureFolder(app, p.split("/").slice(0, -1).join("/"));
			await app.vault.create(p, content);
			res.created++;
			continue;
		}
		if (!p.endsWith(".jsonl")) {
			res.kept++;
			continue;
		}
		const current = await app.vault.adapter.read(p);
		const have = new Set(current.split("\n").map(lineId).filter((x): x is string => !!x));
		const missing = content.split("\n").filter((l) => {
			const id = l.trim() && lineId(l);
			return id && !have.has(id);
		});
		if (!missing.length) {
			res.kept++;
			continue;
		}
		const text = (current.endsWith("\n") || !current ? "" : "\n") + missing.join("\n") + "\n";
		const f = app.vault.getAbstractFileByPath(p);
		if (f instanceof TFile) await app.vault.append(f, text);
		else await app.vault.adapter.append(p, text);
		res.linesAdded += missing.length;
	}
	return res;
}
