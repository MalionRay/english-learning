// 使用者：每位使用者是成人或小孩，資料（答題紀錄、對話、錯誤分析報告）各自獨立。
// 使用者清單放在 Vault 裡（english/users/<deviceId>.jsonl，append-only、每台裝置只寫自己的檔），
// 所以在一台裝置新增或刪除使用者，同步後其他裝置也會看到。依時間重播 user-add／user-remove。
// 每位使用者自己的設定（例如對話記憶長度）也記在這裡：user-set（key、value），最後一筆為準，所有裝置一致。
import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { Level } from "./generate";
import { DIAG_ROOT, LOG_ROOT, listRecursive, safeName } from "./logs";

export const USERS_DIR = "english/users";
// 這幾個資料夾名稱與 chat.ts、patterns.ts、backup.ts、memory.ts 相同（這裡不 import，避免互相引用）
const CONV_DIR = "conversations";
const REPORT_DIR = "english/reports";
const BACKUP_DIR = "backup";
const MEMORY_DIR = "english/memory";

/** 舊版設定裡的使用者在這個時間「建立」：任何真正的新增或刪除都比它晚，所以不會蓋掉。 */
export const SEED_TS = "1970-01-01T00:00:00.000Z";

export interface UserEvent {
	id: string;
	ts: string;
	device: string;
	type: "user-add" | "user-remove" | "user-set";
	name: string;
	level?: Level;
	key?: keyof UserPrefs;
	value?: unknown;
}

/** 每位使用者自己的設定（存在 english/users，會同步）。 */
export interface UserPrefs {
	chatMemory?: number; // 對話記憶長度：AI 看得到最近幾則訊息；0＝整段對話
	remember?: boolean; // 記得以前的對話（跨對話記憶，src/memory.ts）；沒設定＝開
}

export interface UserInfo {
	name: string;
	level: Level;
	created: string;
	prefs: UserPrefs;
}

/** 對話記憶長度的選項（0＝整段對話）與預設值。 */
export const CHAT_MEMORY_OPTIONS = [24, 50, 100, 0] as const;
export const CHAT_MEMORY_DEFAULT = 50;

export function chatMemoryLabel(n: number): string {
	return n === 0 ? "整段對話" : `最近 ${n} 則`;
}

/** 只接受選項裡的值，其他（舊資料、亂填）用預設。 */
export function normalizeChatMemory(v: unknown): number {
	const n = typeof v === "number" ? v : Number(v);
	return (CHAT_MEMORY_OPTIONS as readonly number[]).includes(n) ? n : CHAT_MEMORY_DEFAULT;
}

export const LEVEL_NAME: Record<Level, string> = { adult: "成人", kid: "小孩" };

/** 依時間重播（同時間依 UUID），UUID 去重。新增已存在的名字＝更新程度。 */
export function replayUsers(events: UserEvent[]): UserInfo[] {
	const seen = new Set<string>();
	const list = events
		.filter((e) => e?.id && e.name && (e.type === "user-add" || e.type === "user-remove" || e.type === "user-set") && !seen.has(e.id) && !!seen.add(e.id))
		.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
	const users = new Map<string, UserInfo>();
	for (const e of list) {
		const name = safeName(e.name);
		const cur = users.get(name);
		if (e.type === "user-remove") users.delete(name);
		else if (e.type === "user-set") {
			// 設定只套用在已經存在的使用者（刪掉的人不會因為設定而復活）
			if (cur && e.key) cur.prefs = { ...cur.prefs, [e.key]: e.value } as UserPrefs;
		} else users.set(name, { name, level: e.level === "kid" ? "kid" : "adult", created: cur?.created ?? e.ts, prefs: cur?.prefs ?? {} });
	}
	return [...users.values()].sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.name < b.name ? -1 : 1));
}

/** 舊版：使用者只有名字，叫 kid 的是小孩。 */
export function seedEvents(names: string[], device: string, makeId: () => string): UserEvent[] {
	return names.map((n) => ({ id: makeId(), ts: SEED_TS, device, type: "user-add", name: safeName(n), level: safeName(n) === "kid" ? "kid" : "adult" }));
}

export function usersPath(deviceId: string): string {
	return normalizePath(`${USERS_DIR}/${deviceId}.jsonl`);
}

export async function loadUserEvents(app: App): Promise<UserEvent[]> {
	const out: UserEvent[] = [];
	for (const path of await listRecursive(app, USERS_DIR)) {
		if (!path.endsWith(".jsonl")) continue;
		let text = "";
		try {
			text = await app.vault.adapter.read(path);
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line));
			} catch {
				/* 壞行略過 */
			}
		}
	}
	return out;
}

/** 名字檢查：只能英文小寫、數字、- 和 _；不能重複。回傳錯誤訊息或 null。 */
export function checkNewName(raw: string, existing: string[]): string | null {
	const t = raw.trim().toLowerCase();
	if (!t) return "請輸入名字";
	if (!/^[a-z0-9_-]+$/.test(t)) return "只能用英文字母、數字、- 和 _（例如 amy、kid2）";
	if (t.length > 20) return "名字太長（最多 20 個字）";
	if (existing.includes(t)) return `已經有「${t}」了`;
	return null;
}

/** 對話檔的 frontmatter 裡的 user。 */
export function convUser(md: string): string | null {
	const fm = md.match(/^---\n([\s\S]*?)\n---/);
	const m = fm?.[1].match(/^user:\s*(.+)$/m);
	return m ? safeName(m[1].replace(/^["']|["']$/g, "")) : null;
}

/** 這位使用者的資料：答題紀錄、錯誤分析報告、對話記憶的資料夾，以及他的對話檔路徑。 */
export function isUserDataPath(path: string, name: string, content?: string): boolean {
	const n = safeName(name);
	if (path.startsWith(`${LOG_ROOT}/${n}/`) || path.startsWith(`${REPORT_DIR}/${n}/`) || path.startsWith(`${MEMORY_DIR}/${n}/`)) return true;
	if (path.startsWith(`${CONV_DIR}/`) && content !== undefined) return convUser(content) === n;
	return false;
}

/** 從一份備份的 files 拿掉這位使用者的資料；回傳拿掉幾個。 */
export function stripBackupFiles(files: Record<string, string>, name: string): number {
	let n = 0;
	for (const [path, content] of Object.entries(files)) {
		if (isUserDataPath(path, name, content)) {
			delete files[path];
			n++;
		}
	}
	return n;
}

export interface DeleteResult {
	files: number;
	backups: number;
}

/** 刪一個檔案（依 Obsidian「刪除的檔案」設定：系統垃圾桶或 .trash）。 */
async function removeFile(app: App, path: string) {
	const f = app.vault.getAbstractFileByPath(path);
	if (f instanceof TFile) await app.fileManager.trashFile(f);
	else if (await app.vault.adapter.exists(path)) await app.vault.adapter.remove(path);
}

/** 檔案刪完後把空資料夾也拿掉。 */
async function removeFolder(app: App, path: string) {
	try {
		const f = app.vault.getAbstractFileByPath(path);
		if (f instanceof TFolder) await app.vault.delete(f, true);
		else if (await app.vault.adapter.exists(path)) await app.vault.adapter.rmdir(path, true);
	} catch {
		/* 留下空資料夾也沒關係 */
	}
}

/**
 * 刪除一位使用者的所有資料（所有裝置寫的都刪，同步後每台都會刪掉）：
 * logs/<name>/、debug/diag/<name>/（診斷紀錄）、english/reports/<name>/、english/memory/<name>/（對話記憶）、他的對話檔，
 * 並從每一份備份裡拿掉他的資料。
 */
export async function deleteUserData(app: App, name: string): Promise<DeleteResult> {
	const n = safeName(name);
	let files = 0;
	for (const dir of [`${LOG_ROOT}/${n}`, `${DIAG_ROOT}/${n}`, `${REPORT_DIR}/${n}`, `${MEMORY_DIR}/${n}`]) {
		const inside = await listRecursive(app, dir);
		if (!inside.length && !(await app.vault.adapter.exists(dir))) continue;
		for (const f of inside) {
			await removeFile(app, f);
			files++;
		}
		await removeFolder(app, dir);
	}
	for (const path of await listRecursive(app, CONV_DIR)) {
		if (!path.endsWith(".md")) continue;
		let text = "";
		try {
			text = await app.vault.adapter.read(path);
		} catch {
			continue;
		}
		if (convUser(text) !== n) continue;
		await removeFile(app, path);
		files++;
	}
	// 備份裡也拿掉（不然之後「從備份還原」會把資料救回來）
	let backups = 0;
	for (const path of await listRecursive(app, BACKUP_DIR)) {
		if (!path.endsWith(".json")) continue;
		try {
			const j = JSON.parse(await app.vault.adapter.read(path));
			if (!j?.files || !stripBackupFiles(j.files, n)) continue;
			const f = app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) await app.vault.modify(f, JSON.stringify(j));
			else await app.vault.adapter.write(path, JSON.stringify(j));
			backups++;
		} catch {
			/* 壞的備份略過 */
		}
	}
	return { files, backups };
}
