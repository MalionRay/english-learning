import { App, TFile, normalizePath } from "obsidian";

export const LOG_ROOT = "logs";
export const DEBUG_ROOT = "debug";

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
}

export function logPath(user: string, deviceId: string): string {
	return normalizePath(`${LOG_ROOT}/${safeName(user)}/${deviceId}.jsonl`);
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

/** 從磁碟上所有 log 重算（不依賴快取），用 UUID 去重。 */
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
	const all = await listRecursive(app, LOG_ROOT);
	const wellFormedRe = /^logs\/[a-z0-9_-]+\/[a-z]+-[0-9a-f]{8}\.jsonl$/;

	for (const path of all) {
		const wellFormed = wellFormedRe.test(path);
		if (!wellFormed) t.suspicious.push(path);
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
		t.badLines += bad;
		t.files.push({ path, lines, bad, wellFormed });
	}
	t.files.sort((a, b) => a.path.localeCompare(b.path));
	return t;
}
