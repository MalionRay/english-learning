import { App, TFile, normalizePath } from "obsidian";

export const LOG_ROOT = "logs";
export const DEBUG_ROOT = "debug";
/**
 * 診斷紀錄（同步、語音、AI 呼叫、麥克風測試、驗證用的「記一筆」）放這裡，不和學習紀錄混在一起：
 * debug/diag/<user>/<deviceId>.jsonl，每台裝置只寫自己的檔，舊的會自動清掉（v0.23.0）。
 * 學習紀錄 logs/… 只留作答、批改、回報、生字本、句子本——每次練習都要整個讀一遍，越小越快。
 */
export const DIAG_ROOT = "debug/diag";
export const DIAG_TYPES: readonly string[] = ["tap", "api", "mic", "sync", "tts"];

export function isDiagType(type: unknown): boolean {
	return typeof type === "string" && DIAG_TYPES.includes(type);
}

export interface LogEntry {
	id: string; // UUID，用於跨裝置去重
	ts: string; // ISO 時間戳
	device: string;
	user: string;
	type: "tap" | "api" | "mic" | "sync" | "tts" | "answer" | "grade" | "flag" | "unflag" | "backup" | "word-add" | "word-remove" | "phrase-add" | "phrase-remove";
	[k: string]: unknown;
}

export function uuid(): string {
	const c = globalThis.crypto as Crypto | undefined;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	const b = new Uint8Array(16);
	(c as Crypto).getRandomValues(b);
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 使用者名稱只允許安全字元，避免變成奇怪的路徑。 */
export function safeName(s: string): string {
	return s.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "default";
}

async function ensureFolder(app: App, folder: string): Promise<void> {
	const parts = normalizePath(folder).split("/");
	let cur = "";
	for (const p of parts) {
		cur = cur ? `${cur}/${p}` : p;
		if (!(await app.vault.adapter.exists(cur))) {
			try {
				await app.vault.createFolder(cur);
			} catch {
				/* 可能剛被同步建立 */
			}
		}
	}
}

/**
 * 單一寫入者：每台裝置只 append 到自己的檔案。
 * 寫入用 Vault API，讓 Obsidian 索引（與同步外掛）立即看到變更。
 */
export class AppendOnlyWriter {
	private queue: Promise<void> = Promise.resolve();

	constructor(private app: App) {}

	append(path: string, text: string): Promise<void> {
		const p = normalizePath(path);
		const job = this.queue.then(async () => {
			const folder = p.split("/").slice(0, -1).join("/");
			if (folder) await ensureFolder(this.app, folder);
			const f = this.app.vault.getAbstractFileByPath(p);
			if (f instanceof TFile) {
				await this.app.vault.append(f, text);
			} else if (await this.app.vault.adapter.exists(p)) {
				// 檔案在磁碟上但還沒進索引（例如剛同步下來）
				await this.app.vault.adapter.append(p, text);
			} else {
				await this.app.vault.create(p, text);
			}
		});
		this.queue = job.catch(() => undefined);
		return job;
	}

	/**
	 * 改寫整個檔案（排在同一個佇列裡，不會和 append 交錯）。fn 回傳 null 或原文＝不改。
	 * 只能用在這台裝置自己寫的檔案（單一寫入者）。
	 * create：檔案還不存在時當成空的，fn 有回傳內容就建立。
	 */
	rewrite(path: string, fn: (text: string) => string | null, create = false): Promise<boolean> {
		const p = normalizePath(path);
		const job = this.queue.then(async () => {
			if (!(await this.app.vault.adapter.exists(p))) {
				if (!create) return false;
				const first = fn("");
				if (!first) return false;
				const folder = p.split("/").slice(0, -1).join("/");
				if (folder) await ensureFolder(this.app, folder);
				await this.app.vault.create(p, first);
				return true;
			}
			const f = this.app.vault.getAbstractFileByPath(p);
			const text = f instanceof TFile ? await this.app.vault.read(f) : await this.app.vault.adapter.read(p);
			let next = fn(text);
			// 不留 0 位元組的檔案（有些同步方式不處理空檔）：內容清光時留一個換行，讀的地方本來就會跳過空行
			if (next === "") next = "\n";
			if (next === null || next === text) return false;
			if (f instanceof TFile) await this.app.vault.modify(f, next);
			else await this.app.vault.adapter.write(p, next);
			return true;
		});
		this.queue = job.then(
			() => undefined,
			() => undefined,
		);
		return job;
	}

	/** 等前面排隊的寫入都完成。 */
	flush(): Promise<void> {
		return this.queue;
	}
}

/** 除錯紀錄（debug/<deviceId>.md）超過這麼多字就整理，只留最後這麼多字。 */
export const DEBUG_MAX = 300_000;
export const DEBUG_KEEP = 150_000;

/**
 * 除錯紀錄太長時只留最後一段（從整行開始）；沒超過就原樣回傳。
 * 這個檔每次同步都整個上傳，一直長下去會拖慢同步。
 */
export function trimDebugLog(text: string, max = DEBUG_MAX, keep = DEBUG_KEEP, now = new Date()): string {
	if (text.length <= max) return text;
	const cut = text.indexOf("\n", Math.max(0, text.length - keep));
	const tail = cut < 0 ? text.slice(-keep) : text.slice(cut + 1);
	return `- ${now.toISOString()} （較舊的除錯紀錄已清掉，只留最近的部分）\n${tail}`;
}

export function logPath(user: string, deviceId: string): string {
	return normalizePath(`${LOG_ROOT}/${safeName(user)}/${deviceId}.jsonl`);
}

export function diagPath(user: string, deviceId: string): string {
	return normalizePath(`${DIAG_ROOT}/${safeName(user)}/${deviceId}.jsonl`);
}

/** 這筆紀錄要寫到哪個檔：學習紀錄 → logs/…；診斷紀錄 → debug/diag/…。 */
export function entryPath(e: { type: string; user: string }, deviceId: string): string {
	return isDiagType(e.type) ? diagPath(e.user, deviceId) : logPath(e.user, deviceId);
}

// ---------------------------------------------------------------------
// 學習紀錄瘦身：把以前寫在學習紀錄裡的診斷紀錄搬到診斷檔，診斷檔只留最近的

/** 一般診斷紀錄留幾天。 */
export const DIAG_KEEP_DAYS = 14;
/** Google Cloud 語音的用量紀錄留幾天：每月上限要加總「這個月」的用量，所以至少要留滿一個月。 */
export const DIAG_CLOUD_KEEP_DAYS = 62;
/** 一般診斷紀錄最多留幾筆（不含 Google Cloud 語音的用量）。 */
export const DIAG_MAX_LINES = 2000;
const DAY_MS = 24 * 3600 * 1000;

/** Google Cloud 語音的用量紀錄（每月上限靠它加總，不能隨便丟）。 */
function isCloudUsage(e: Record<string, unknown>): boolean {
	return e.type === "tts" && e.source === "cloud" && typeof e.chars === "number";
}

/** 學習紀錄檔裡的診斷紀錄（有 id 的才算；壞行、沒有 id 的留在原地不動）。 */
export function diagLinesOf(text: string): { id: string; line: string }[] {
	const out: { id: string; line: string }[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (e && typeof e.id === "string" && isDiagType(e.type)) out.push({ id: e.id, line });
		} catch {
			/* 壞行留著 */
		}
	}
	return out;
}

function idOfLine(line: string): string | null {
	try {
		const id = JSON.parse(line)?.id;
		return typeof id === "string" ? id : null;
	} catch {
		return null;
	}
}

/** 把還沒有的行加到檔案後面（依 id 判斷）；都已經有了就回傳 null。 */
export function addMissingLines(text: string, lines: { id: string; line: string }[]): string | null {
	const have = new Set<string>();
	for (const l of text.split("\n")) {
		const id = l.trim() ? idOfLine(l) : null;
		if (id) have.add(id);
	}
	const add = lines.filter((l) => !have.has(l.id) && !!have.add(l.id));
	if (!add.length) return null;
	return text + (text && !text.endsWith("\n") ? "\n" : "") + add.map((l) => l.line).join("\n") + "\n";
}

/** 拿掉這些 id 的行，其他原樣保留（包含壞行）；沒有變就回傳 null。 */
export function dropLines(text: string, ids: Set<string>): string | null {
	const lines = text.split("\n");
	const keep = lines.filter((l) => {
		if (!l.trim()) return true;
		const id = idOfLine(l);
		return !(id && ids.has(id));
	});
	return keep.length === lines.length ? null : keep.join("\n");
}

/**
 * 診斷檔只留最近的：一般紀錄 14 天（最多 2000 筆），Google Cloud 語音用量 62 天
 * （超過 14 天的只留算用量要用的欄位，id 不變，跨裝置去重照常）。壞行直接丟掉。
 */
export function trimDiag(text: string, now = new Date()): string {
	const t = now.getTime();
	const kept: { line: string; cloud: boolean }[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (!e || typeof e.id !== "string") continue;
		const age = (t - Date.parse(String(e.ts))) / DAY_MS;
		if (isCloudUsage(e)) {
			if (!(age <= DIAG_CLOUD_KEEP_DAYS)) continue;
			if (age <= DIAG_KEEP_DAYS) kept.push({ line, cloud: true });
			else {
				const slim: Record<string, unknown> = { id: e.id, ts: e.ts, device: e.device, user: e.user, type: e.type, source: e.source, chars: e.chars, month: e.month };
				if (e.carriedFrom !== undefined) slim.carriedFrom = e.carriedFrom;
				kept.push({ line: JSON.stringify(slim), cloud: true });
			}
		} else if (age <= DIAG_KEEP_DAYS) kept.push({ line, cloud: false });
	}
	let extra = kept.filter((k) => !k.cloud).length - DIAG_MAX_LINES;
	const out: string[] = [];
	for (const k of kept) {
		if (!k.cloud && extra > 0) {
			extra--; // 太多筆：從最舊的開始丟
			continue;
		}
		out.push(k.line);
	}
	return out.length ? out.join("\n") + "\n" : "";
}

export interface SlimResult {
	moved: number; // 從學習紀錄搬到診斷檔的筆數
	files: number; // 改到的學習紀錄檔數
	trimmed: number; // 整理過的診斷檔數
}

async function subfolders(app: App, root: string): Promise<string[]> {
	if (!(await app.vault.adapter.exists(root))) return [];
	return (await app.vault.adapter.list(root)).folders;
}

/**
 * 學習紀錄瘦身（啟動後跑一次）：
 * 1. 這台裝置自己的學習紀錄檔（logs/<user>/<deviceId>.jsonl）裡，以前版本寫的診斷紀錄搬到診斷檔。
 *    先寫進診斷檔（已經有的不重複）再從學習紀錄拿掉——中途當掉最多是兩邊都有，下次再搬一次；讀的地方都用 id 去重。
 * 2. 這台裝置自己的診斷檔只留最近的（trimDiag）。
 * 只動自己寫的檔（單一寫入者）；別台裝置的檔等它們自己更新後整理。
 */
export async function slimLogs(app: App, writer: AppendOnlyWriter, deviceId: string, now = new Date()): Promise<SlimResult> {
	const r: SlimResult = { moved: 0, files: 0, trimmed: 0 };
	for (const dir of await subfolders(app, LOG_ROOT)) {
		const user = dir.split("/").pop() ?? "";
		const path = normalizePath(`${dir}/${deviceId}.jsonl`);
		if (!user || !(await app.vault.adapter.exists(path))) continue;
		const diag = diagLinesOf(await app.vault.adapter.read(path));
		if (!diag.length) continue;
		await writer.rewrite(diagPath(user, deviceId), (cur) => addMissingLines(cur, diag), true);
		const ids = new Set(diag.map((d) => d.id));
		if (await writer.rewrite(path, (cur) => dropLines(cur, ids))) {
			r.moved += diag.length;
			r.files++;
		}
	}
	for (const dir of await subfolders(app, DIAG_ROOT)) {
		const path = normalizePath(`${dir}/${deviceId}.jsonl`);
		if (await writer.rewrite(path, (cur) => trimDiag(cur, now))) r.trimmed++;
	}
	return r;
}

export interface Totals {
	files: { path: string; lines: number; bad: number; wellFormed: boolean }[];
	uniqueTaps: number;
	rawTaps: number;
	duplicates: number;
	badLines: number;
	byDevice: Record<string, number>;
	byUser: Record<string, number>;
	latest: Record<string, { api?: LogEntry; mic?: LogEntry; sync?: LogEntry }>;
	suspicious: string[]; // 不符合 logs/<user>/<deviceId>.jsonl 的檔案（例如衝突副本）
}

export async function listRecursive(app: App, folder: string): Promise<string[]> {
	const out: string[] = [];
	if (!(await app.vault.adapter.exists(folder))) return out;
	const { files, folders } = await app.vault.adapter.list(folder);
	out.push(...files);
	for (const sub of folders) out.push(...(await listRecursive(app, sub)));
	return out;
}

/**
 * 從磁碟上所有 log 重算（不依賴快取），用 UUID 去重。
 * 「記一筆」和 API／麥克風／同步的最新狀態是診斷紀錄：新版寫在 debug/diag，舊版寫在 logs，兩邊都讀。
 */
export async function computeTotals(app: App): Promise<Totals> {
	const t: Totals = {
		files: [],
		uniqueTaps: 0,
		rawTaps: 0,
		duplicates: 0,
		badLines: 0,
		byDevice: {},
		byUser: {},
		latest: {},
		suspicious: [],
	};
	const seen = new Set<string>();
	const logs = await listRecursive(app, LOG_ROOT);
	const all = [...logs, ...(await listRecursive(app, DIAG_ROOT))];
	const wellFormedRe = /^logs\/[a-z0-9_-]+\/[a-z]+-[0-9a-f]{8}\.jsonl$/;

	for (let i = 0; i < all.length; i++) {
		const path = all[i];
		const isLog = i < logs.length; // 檔案清單、衝突副本、壞行只看學習紀錄
		const wellFormed = wellFormedRe.test(path);
		if (isLog && !wellFormed) t.suspicious.push(path);
		if (!path.endsWith(".jsonl")) continue;
		const content = await app.vault.adapter.read(path);
		let lines = 0;
		let bad = 0;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			lines++;
			let e: LogEntry;
			try {
				e = JSON.parse(line);
			} catch {
				bad++;
				continue;
			}
			if (!e || typeof e.id !== "string") {
				bad++;
				continue;
			}
			if (e.type === "tap") t.rawTaps++;
			if (seen.has(e.id)) {
				t.duplicates++;
				continue;
			}
			seen.add(e.id);
			if (e.type === "tap") {
				t.uniqueTaps++;
				t.byDevice[e.device] = (t.byDevice[e.device] ?? 0) + 1;
				t.byUser[e.user] = (t.byUser[e.user] ?? 0) + 1;
			} else if (e.type === "api" || e.type === "mic" || e.type === "sync") {
				const d = (t.latest[e.device] ??= {});
				const prev = d[e.type];
				if (!prev || prev.ts < e.ts) d[e.type] = e;
			}
		}
		if (!isLog) continue;
		t.badLines += bad;
		t.files.push({ path, lines, bad, wellFormed });
	}
	t.files.sort((a, b) => a.path.localeCompare(b.path));
	return t;
}
