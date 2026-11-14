// 跨對話記憶（v0.23.0）：對話結束時請 AI 把這次聊到的重點整理成幾條「記憶」，
// 下次開新對話時交給 AI，讓它像記得你的朋友一樣自然提起。
// 每位使用者、每種語言各一份（英文的 Alex、西班牙文的 Sofía、日文的結衣各記各的）。
// 存在 Vault：english/memory/<user>/<deviceId>.jsonl（append-only、每台裝置只寫自己的檔），
// 依時間重播，同步後所有裝置一致。
import { App, normalizePath } from "obsidian";
import { AIBackend, AIError } from "./ai";
import { CONV_DIR, ConvMessage, ConvMeta, TOPICS, parseConvMessages, parseConvMeta, parseReply } from "./chat";
import type { Level } from "./generate";
import { LANG, LANGS, Lang, langOf, personaName } from "./lang";
import { listRecursive, safeName, uuid } from "./logs";

export const MEMORY_DIR = "english/memory";
/** 每位使用者、每種語言最多留幾條。 */
export const MEMORY_MAX = 20;
/** 一條記憶最多幾個字。 */
export const MEMORY_TEXT_MAX = 60;
/** 一次對話最多新增幾條。 */
export const MEMORY_ADD_MAX = 4;
/** 學習者至少說了幾句（還沒整理過的部分）才值得請 AI 整理。 */
export const MEMORY_MIN_LEARNER = 2;
/** 補整理（沒按「結束對話」就離開的）：只看最近幾天的對話、一次最多幾個、多久看一次。 */
export const CATCHUP_DAYS = 14;
export const CATCHUP_MAX = 2;
export const CATCHUP_EVERY_MS = 10 * 60_000;
/** 別台裝置開始的對話：最後一句超過這麼久（可能還在聊、或那台自己會整理）才幫忙整理。 */
export const OTHER_DEVICE_QUIET_MS = 30 * 60_000;
/** 同一個對話整理失敗這麼多次（AI 回的內容不能用），補整理就不再試。 */
export const MEMORY_FAIL_MAX = 2;
export const LS_MEMORY_FAIL = "english-learning:memory-fail"; // { [對話檔]: 失敗次數 }
const TRANSCRIPT_MAX = 10_000;
const NOTES_IN_PROMPT = 40;
const DAY_MS = 24 * 3600 * 1000;

export interface MemItem {
	key: string;
	text: string; // 繁體中文的一句話
	at: string; // 哪個時候的對話知道的（ISO）
}

export interface MemEvent {
	id: string;
	ts: string;
	device: string;
	user: string;
	type: "mem";
	lang?: Lang; // 沒有＝英文
	add?: MemItem[];
	remove?: string[];
	conv?: string; // AI 整理的是哪個對話檔
	count?: number; // 整理到那個對話的第幾則訊息
	since?: string; // 這個時間以前開始的對話不補整理（重新打開記憶時寫）
	by?: "ai" | "user";
}

export interface MemState {
	items: Record<Lang, MemItem[]>; // 最新的在前面
	done: Map<string, number>; // 對話檔 → 已整理到第幾則訊息
	since: string; // 沒有是 ""
}

function localDay(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 記憶是哪一天的（本地日期）；時間壞掉就原樣顯示前 10 個字。 */
export function memDay(at: string): string {
	const t = Date.parse(at);
	return Number.isNaN(t) ? String(at ?? "").slice(0, 10) : localDay(new Date(t));
}

/** 比較兩條記憶是不是同一句（不管空白和標點）。 */
function norm(s: string): string {
	return s.replace(/[\s，。、；：,.;:!！?？「」『』"'（）()]/g, "").toLowerCase();
}

function sortItems(items: MemItem[]): MemItem[] {
	return [...items].sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : a.key < b.key ? -1 : 1));
}

export function memoryPath(user: string, deviceId: string): string {
	return normalizePath(`${MEMORY_DIR}/${safeName(user)}/${deviceId}.jsonl`);
}

/**
 * 重播所有裝置的紀錄（UUID 去重）；每種語言各自一份。
 * 每條記憶的 key 不重複使用（改寫＝刪掉舊的、加一條新的），所以「刪掉」是永久的：
 * 結果＝所有加過的減掉所有刪過的，和各裝置的時鐘誰快誰慢、紀錄的先後無關——刪掉的不會因為同步順序又跑回來。
 */
export function replayMemory(events: MemEvent[]): MemState {
	const seen = new Set<string>();
	const list = events
		.filter((e) => e?.id && e.type === "mem" && !seen.has(e.id) && !!seen.add(e.id))
		.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
	const maps: Record<Lang, Map<string, MemItem>> = { en: new Map(), es: new Map(), ja: new Map() };
	const removed = new Set<string>();
	const done = new Map<string, number>();
	let since = "";
	for (const e of list) {
		const m = maps[langOf(e.lang)];
		for (const k of Array.isArray(e.remove) ? e.remove : []) if (typeof k === "string") removed.add(k);
		for (const it of Array.isArray(e.add) ? e.add : []) {
			if (!it || typeof it.key !== "string" || typeof it.text !== "string" || !it.text.trim()) continue;
			m.set(it.key, { key: it.key, text: it.text.trim(), at: typeof it.at === "string" ? it.at : e.ts });
		}
		if (typeof e.conv === "string" && typeof e.count === "number") done.set(e.conv, Math.max(done.get(e.conv) ?? 0, e.count));
		if (typeof e.since === "string" && e.since > since) since = e.since;
	}
	const items = {} as Record<Lang, MemItem[]>;
	for (const l of LANGS) {
		// 兩台裝置各自整理了同一個對話時可能有一模一樣的兩條：只留新的那條
		const texts = new Set<string>();
		items[l] = sortItems([...maps[l].values()].filter((it) => !removed.has(it.key))).filter((it) => !texts.has(norm(it.text)) && !!texts.add(norm(it.text)));
	}
	return { items, done, since };
}

export async function loadMemoryEvents(app: App, user: string): Promise<MemEvent[]> {
	const out: MemEvent[] = [];
	for (const path of await listRecursive(app, `${MEMORY_DIR}/${safeName(user)}`)) {
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
				const e = JSON.parse(line);
				if (e?.type === "mem") out.push(e);
			} catch {
				/* 壞行略過 */
			}
		}
	}
	return out;
}

export async function loadMemory(app: App, user: string): Promise<MemState> {
	return replayMemory(await loadMemoryEvents(app, user));
}

// ---------------------------------------------------------------------
// 對話時：把記憶交給 AI

/** 加在對話系統提示後面的一段；沒有記憶就是空字串。 */
export function memoryPrompt(items: MemItem[], lang: Lang, now = new Date()): string {
	const list = items.slice(0, MEMORY_MAX);
	if (!list.length) return "";
	return `

What you remember about this learner from your earlier conversations (your own private notes, written in Chinese; the date is when you learned it; today is ${localDay(now)}):
${list.map((m) => `- (${memDay(m.at)}) ${m.text}`).join("\n")}
How to use these memories:
- You are the same friend they talked to before. Bring a memory up only when it fits naturally — ask how something went, or connect it to what they just said. Most replies should not mention any of them.
- Never list them, never say that you keep notes, and do not bring up the same memory twice in one conversation.
- When you open a new conversation, you may pick up ONE of these threads instead of a generic greeting, if it suits the scenario.
- Mind the dates: a plan whose date has passed has probably happened, so ask how it went instead of talking about it as upcoming.
- If the learner says something that contradicts a note, trust what they say now.
- Notes about their recurring mistakes are for you only: watch for those points when you correct them, and do not quote the notes.
- If the scenario gives you a role (waiter, interviewer), stay in that role and use a memory only if it truly fits.
- The notes are in Chinese only for record-keeping. Keep speaking ${LANG[lang].english}; never switch to Chinese because of them.`;
}

// ---------------------------------------------------------------------
// 對話結束後：請 AI 整理

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** 從第 from 則開始，學習者說了幾句。 */
export function learnerCount(messages: ConvMessage[], from = 0): number {
	return messages.slice(from).filter((m) => m?.role === "user" && typeof m.text === "string" && m.text.trim()).length;
}

/** 給整理記憶的 AI 看的對話內容：學習者說的話、對方的回覆、被糾正的句子；太長只留後面。 */
export function transcriptOf(messages: ConvMessage[], partner: string, from = 0, max = TRANSCRIPT_MAX): string {
	const lines: string[] = [];
	for (const m of messages.slice(from)) {
		if (typeof m?.text !== "string" || !m.text.trim()) continue;
		if (m.role === "user") lines.push(`Learner: ${oneLine(m.text)}`);
		else {
			const r = parseReply(m.text);
			if (r.correction) lines.push(`[${partner} corrected the learner: "${oneLine(r.correction.original)}" → "${oneLine(r.correction.corrected)}"]`);
			if (r.reply) lines.push(`${partner}: ${oneLine(r.reply)}`);
		}
	}
	const text = lines.join("\n");
	if (text.length <= max) return text;
	const cut = text.indexOf("\n", text.length - max);
	return `(The beginning of this conversation is left out because it is long.)\n${cut < 0 ? text.slice(-max) : text.slice(cut + 1)}`;
}

export interface SummaryRequest {
	system: string;
	prompt: string;
	ids: Map<string, string>; // 給 AI 看的編號（m1、m2…）→ 記憶的 key
}

/** 請 AI 決定這次對話之後記憶要怎麼改：回傳要新增、改寫、刪掉的（沒提到的不動）。 */
export function summaryRequest(o: { items: MemItem[]; messages: ConvMessage[]; from: number; lang: Lang; level: Level; topic: string; now: Date }): SummaryRequest {
	const who = personaName(o.lang, o.level);
	const notes = o.items.slice(0, NOTES_IN_PROMPT);
	const ids = new Map<string, string>();
	notes.forEach((m, i) => ids.set(`m${i + 1}`, m.key));
	const topic = TOPICS.find((t) => t.id === o.topic);
	const last = [...o.messages].reverse().find((m) => !Number.isNaN(Date.parse(m?.ts)));
	const convDay = last ? memDay(last.ts) : localDay(o.now);
	const system = `You keep the memory notes of ${who}, who chats with a language learner in ${LANG[o.lang].english} and wants to remember them between conversations the way a friend would.

You get today's date, ${who}'s existing notes about this learner (each with an id and the date it was learned), and one conversation (with its date and scenario). Decide how the notes should change because of this conversation.

Worth a note (only things the LEARNER said about themselves):
- lasting facts: family, job or school, where they live, pets, hobbies, tastes, routines;
- plans and upcoming events (say when), and recent events a friend would ask about later;
- topics they clearly enjoyed or want to continue next time;
- a recurring language difficulty, only if the same kind of mistake was corrected at least twice in this conversation or it matches an existing note.
Not worth a note: greetings and small talk; one-off details nobody would ask about later; ${who}'s own stories and opinions; anything said only as part of a role-play (ordering as a customer, practice interview answers); passwords, ID or account numbers, phone numbers, home addresses.

Return ONLY a JSON object:
{"add": ["<new note>"], "update": [{"id": "<id of an existing note>", "text": "<the rewritten note>"}], "remove": ["<id of an existing note>"]}

Rules:
- Write every note in Traditional Chinese (Taiwan usage): ONE short statement, at most 40 characters, no subject needed (for example 「12 月要去東京玩 5 天」「養了一隻貓叫 Mochi」「常把 since 和 for 用錯」). Keep names, places and foreign words as written.
- Turn relative times into concrete ones using the conversation date (「下個月」→ the month, 「明天」→ the date).
- "add": at most ${MEMORY_ADD_MAX} genuinely new notes; use [] when the conversation has nothing worth remembering — that is common and fine.
- "update": when this conversation changes or extends an existing note (a plan happened, a detail changed, two notes say the same thing), rewrite that note instead of adding a similar one.
- "remove": existing notes that are now wrong, outdated, or covered by another note.
- Existing notes that you do not list in "update" or "remove" stay exactly as they are. Never copy an existing note into "add".
- There can be at most ${MEMORY_MAX} notes; there are ${o.items.length} now. If your changes would exceed that, also remove the least useful or oldest ones.`;
	const prompt = `Today: ${localDay(o.now)}

Existing notes:
${notes.length ? notes.map((m, i) => `m${i + 1} (${memDay(m.at)}) ${m.text}`).join("\n") : "(none yet)"}

Conversation on ${convDay} — scenario: ${topic ? `${topic.label} (${topic.prompt})` : o.topic}
${o.from > 0 ? "(The earlier part of this conversation was already processed; only the new part is below.)\n" : ""}${transcriptOf(o.messages, who, o.from)}`;
	return { system, prompt, ids };
}

export interface MemOps {
	add: string[];
	update: { key: string; text: string }[];
	remove: string[];
}

function cleanNote(v: unknown): string {
	if (typeof v !== "string") return "";
	const t = v
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[-•・*\s]+/, "");
	return [...t].slice(0, MEMORY_TEXT_MAX).join("");
}

/** AI 的回覆 → 要做的修改；格式不對回傳 null（當作這次沒整理成功）。不認得的編號略過。 */
export function parseMemoryOps(text: string, ids: Map<string, string>): MemOps | null {
	let j: Record<string, unknown>;
	try {
		j = JSON.parse(
			text
				.trim()
				.replace(/^```(?:json)?\s*/i, "")
				.replace(/\s*```$/, ""),
		);
	} catch {
		return null;
	}
	if (!j || typeof j !== "object" || Array.isArray(j)) return null;
	if (!Array.isArray(j.add) && !Array.isArray(j.update) && !Array.isArray(j.remove)) return null;
	const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
	const keyOf = (v: unknown) => ids.get(String(v ?? "").trim()) ?? "";
	const add = arr(j.add)
		.map((x) => cleanNote(typeof x === "string" ? x : (x as { text?: unknown })?.text))
		.filter(Boolean)
		.slice(0, MEMORY_ADD_MAX);
	const update = arr(j.update)
		.map((u) => ({ key: keyOf((u as { id?: unknown })?.id), text: cleanNote((u as { text?: unknown })?.text) }))
		.filter((u) => u.key && u.text);
	const remove = arr(j.remove)
		.map((r) => keyOf(typeof r === "string" ? r : (r as { id?: unknown })?.id))
		.filter(Boolean);
	return { add, update, remove };
}

function shortKey(): string {
	return uuid().replace(/-/g, "").slice(0, 12);
}

/**
 * 把修改套到目前的記憶上：回傳要寫進紀錄的（add／remove）和套用後的清單。
 * 改寫＝舊的拿掉、加一條新的；和現有的一模一樣的不重複加；超過上限從最舊的開始丟。
 */
export function applyOps(items: MemItem[], ops: MemOps, at: string, makeKey: () => string = shortKey, max = MEMORY_MAX): { add: MemItem[]; remove: string[]; items: MemItem[] } {
	const cur = new Map(items.map((m) => [m.key, m]));
	const added = new Map<string, MemItem>();
	const removed = new Set<string>();
	const has = (text: string) => [...cur.values()].some((m) => norm(m.text) === norm(text));
	const put = (text: string) => {
		const it = { key: makeKey(), text, at };
		cur.set(it.key, it);
		added.set(it.key, it);
	};
	const drop = (key: string) => {
		if (!cur.delete(key)) return;
		if (!added.delete(key)) removed.add(key); // 這次才加的直接不加，不用寫刪除
	};
	for (const key of ops.remove) drop(key);
	for (const u of ops.update) {
		const old = cur.get(u.key);
		if (!old || norm(old.text) === norm(u.text)) continue; // 這條剛被刪、或內容沒變
		drop(u.key);
		if (!has(u.text)) put(u.text);
	}
	for (const text of ops.add) if (!has(text)) put(text);
	const sorted = sortItems([...cur.values()]);
	for (const it of sorted.slice(max)) drop(it.key);
	return { add: [...added.values()], remove: [...removed], items: sorted.slice(0, max) };
}

// ---------------------------------------------------------------------
// 哪些對話還沒整理

export interface ConvInfo {
	path: string;
	meta: ConvMeta;
	messages: ConvMessage[];
}

/** 這個對話從第幾則訊息開始還沒整理；沒有（或新的內容太少）回傳 -1。 */
export function pendingFrom(path: string, messages: ConvMessage[], state: MemState): number {
	const done = state.done.get(path) ?? 0;
	if (messages.length <= done) return -1;
	return learnerCount(messages, done) >= MEMORY_MIN_LEARNER ? done : -1;
}

/**
 * 補整理要做哪幾個：這位使用者、這個語言、最近 14 天、還有沒整理的內容；
 * 別台裝置開始的要等最後一句過了 30 分鐘；最多 2 個（挑最近的，照時間順序做）。
 */
export function pickCatchUp(convs: ConvInfo[], state: MemState, o: { user: string; lang: Lang; deviceId: string; now: Date; skip?: Set<string> }): ConvInfo[] {
	const now = o.now.getTime();
	const since = state.since ? Date.parse(state.since) : NaN;
	return convs
		.filter((c) => safeName(c.meta.user) === safeName(o.user) && langOf(c.meta.lang) === o.lang && !o.skip?.has(c.path))
		.filter((c) => {
			const t = Date.parse(c.meta.started);
			if (Number.isNaN(t) || t < now - CATCHUP_DAYS * DAY_MS) return false;
			return Number.isNaN(since) || t >= since;
		})
		.filter((c) => pendingFrom(c.path, c.messages, state) >= 0)
		.filter((c) => {
			if (c.meta.device === o.deviceId) return true;
			const last = Date.parse(c.messages[c.messages.length - 1]?.ts);
			return Number.isNaN(last) || now - last >= OTHER_DEVICE_QUIET_MS;
		})
		.sort((a, b) => (a.meta.started < b.meta.started ? 1 : -1))
		.slice(0, CATCHUP_MAX)
		.reverse();
}

/** 最近幾天的對話檔（檔名開頭是本地日期）。 */
export async function recentConvs(app: App, now: Date, days = CATCHUP_DAYS): Promise<ConvInfo[]> {
	const min = localDay(new Date(now.getTime() - (days + 1) * DAY_MS));
	const out: ConvInfo[] = [];
	for (const path of await listRecursive(app, CONV_DIR)) {
		const name = path.split("/").pop() ?? "";
		if (!name.endsWith(".md") || name.slice(0, 10) < min) continue;
		try {
			const md = await app.vault.adapter.read(path);
			const meta = parseConvMeta(md);
			if (meta) out.push({ path, meta, messages: parseConvMessages(md) });
		} catch {
			/* 讀不到的略過 */
		}
	}
	return out;
}

// ---------------------------------------------------------------------
// 排程：同一時間只整理一個對話（後面的要看到前面整理的結果）

export interface MemoryHost {
	app: App;
	deviceId: string;
	fastBackend(): AIBackend;
	getApiKey(): string | null;
	/** 這位使用者有沒有開「記得以前的對話」。 */
	remembers(user: string): boolean;
	/** 寫進這台裝置自己的記憶檔。 */
	appendMemory(e: MemEvent): Promise<void>;
	/** 等前面排隊的寫入（對話檔的最後幾則）都寫完。 */
	flushWrites(): Promise<void>;
	debug(msg: string): void;
}

/** updated＝記憶有變；nothing＝整理了但沒有要記的；skipped＝不用整理；failed＝沒整理成功（之後再試）。 */
export type MemResult = "updated" | "nothing" | "skipped" | "failed";

function offline(): boolean {
	return typeof navigator !== "undefined" && navigator.onLine === false;
}

export class MemoryManager {
	private chain: Promise<unknown> = Promise.resolve();
	private queued = new Map<string, Promise<MemResult>>();
	private caughtUp = new Map<string, number>();
	private listeners = new Set<() => void>();

	constructor(
		private host: MemoryHost,
		private now: () => Date = () => new Date(),
	) {}

	/** 記憶有變、或整理做完時通知（畫面重畫用）；回傳取消的函式。 */
	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	private emit() {
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch {
				/* 畫面的錯不影響整理 */
			}
		}
	}

	/** 還有對話在排隊或整理中。 */
	get busy(): boolean {
		return this.queued.size > 0;
	}

	/** 這位使用者在這個語言的記憶（最新的在前面）。 */
	async list(user: string, lang: Lang): Promise<MemItem[]> {
		return (await loadMemory(this.host.app, user)).items[lang];
	}

	/** 等排隊中的整理做完，最多等 ms 毫秒；回傳是不是都做完了。 */
	async settle(ms: number): Promise<boolean> {
		if (!this.queued.size) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<boolean>((ok) => (timer = setTimeout(() => ok(false), ms)));
		const all = Promise.all([...this.queued.values()]).then(() => true);
		const done = await Promise.race([all, timeout]);
		if (timer) clearTimeout(timer);
		return done;
	}

	/** 整理一個對話（排隊，一次一個）。同一個對話已經在排隊就回傳那一次的結果。 */
	remember(path: string): Promise<MemResult> {
		const p = normalizePath(path);
		const running = this.queued.get(p);
		if (running) return running;
		const job: Promise<MemResult> = this.chain
			.then(() => this.run(p))
			.catch((e): MemResult => {
				this.host.debug(`memory: ${p} failed: ${(e as Error)?.message ?? e}`);
				return "failed";
			})
			.then((r) => {
				this.queued.delete(p);
				this.emit();
				return r;
			});
		this.queued.set(p, job);
		this.chain = job;
		return job;
	}

	private failed(): Record<string, number> {
		const v = this.host.app.loadLocalStorage(LS_MEMORY_FAIL);
		return v && typeof v === "object" ? { ...(v as Record<string, number>) } : {};
	}

	private countFail(path: string) {
		const all = this.failed();
		all[path] = (all[path] ?? 0) + 1;
		this.host.app.saveLocalStorage(LS_MEMORY_FAIL, all);
	}

	private async run(path: string): Promise<MemResult> {
		const h = this.host;
		if (offline() || !h.getApiKey()) return "skipped";
		await h.flushWrites();
		if (!(await h.app.vault.adapter.exists(path))) return "skipped";
		const md = await h.app.vault.adapter.read(path);
		const meta = parseConvMeta(md);
		if (!meta || !h.remembers(meta.user)) return "skipped";
		const lang = langOf(meta.lang);
		const messages = parseConvMessages(md);
		const state = await loadMemory(h.app, meta.user);
		const from = pendingFrom(path, messages, state);
		if (from < 0) return "skipped";
		const now = this.now();
		const req = summaryRequest({ items: state.items[lang], messages, from, lang, level: meta.level, topic: meta.topic, now });
		const t0 = Date.now();
		let text = "";
		try {
			text = (await h.fastBackend().complete(req.prompt, { system: req.system, json: true, maxOutputTokens: 1536, temperature: 0.2, hedgeAfterMs: 15_000, timeoutMs: 45_000 })).text;
		} catch (e) {
			// 額度、網路、伺服器、金鑰的問題不是這個對話的錯：不記失敗次數，之後再試
			if (!(e instanceof AIError) || e.kind === "other") this.countFail(path);
			h.debug(`memory: ${path} not summarized: ${(e as Error)?.message ?? e}`);
			return "failed";
		}
		const ops = parseMemoryOps(text, req.ids);
		if (!ops) {
			this.countFail(path);
			h.debug(`memory: ${path} unusable reply: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
			return "failed";
		}
		const last = [...messages].reverse().find((m) => !Number.isNaN(Date.parse(m?.ts)));
		const r = applyOps(state.items[lang], ops, last?.ts ?? now.toISOString());
		await h.appendMemory({
			id: uuid(),
			ts: now.toISOString(),
			device: h.deviceId,
			user: safeName(meta.user),
			type: "mem",
			...(lang !== "en" ? { lang } : {}),
			conv: path,
			count: messages.length,
			by: "ai",
			...(r.add.length ? { add: r.add } : {}),
			...(r.remove.length ? { remove: r.remove } : {}),
		});
		h.debug(`memory: ${path} (${lang}) +${r.add.length} -${r.remove.length}, ${r.items.length} notes, ${Date.now() - t0} ms`);
		return r.add.length || r.remove.length ? "updated" : "nothing";
	}

	/**
	 * 補整理沒按「結束對話」就離開的對話（開對話的開始畫面時呼叫；10 分鐘內不重複看）。
	 * 回傳排了幾個。
	 */
	async catchUp(user: string, lang: Lang): Promise<number> {
		const h = this.host;
		const key = `${safeName(user)}|${lang}`;
		const now = this.now();
		if (now.getTime() - (this.caughtUp.get(key) ?? -Infinity) < CATCHUP_EVERY_MS) return 0;
		if (!h.remembers(user) || !h.getApiKey() || offline()) return 0;
		this.caughtUp.set(key, now.getTime());
		try {
			const state = await loadMemory(h.app, user);
			const failed = this.failed();
			const skip = new Set([...this.queued.keys(), ...Object.keys(failed).filter((p) => failed[p] >= MEMORY_FAIL_MAX)]);
			const picked = pickCatchUp(await recentConvs(h.app, now), state, { user, lang, deviceId: h.deviceId, now, skip });
			for (const c of picked) void this.remember(c.path);
			if (picked.length) this.emit(); // 畫面顯示「整理中…」
			return picked.length;
		} catch (e) {
			h.debug(`memory: catch-up failed: ${(e as Error)?.message ?? e}`);
			return 0;
		}
	}

	/** 使用者刪掉幾條記憶。 */
	async forget(user: string, lang: Lang, keys: string[]): Promise<void> {
		if (!keys.length) return;
		const h = this.host;
		await h.appendMemory({ id: uuid(), ts: this.now().toISOString(), device: h.deviceId, user: safeName(user), type: "mem", ...(lang !== "en" ? { lang } : {}), remove: keys, by: "user" });
		this.emit();
	}

	/** 重新打開記憶時：這之前開始的對話不補整理（關掉的那段時間聊的不會被記下來）。 */
	async markSince(user: string): Promise<void> {
		const h = this.host;
		const ts = this.now().toISOString();
		await h.appendMemory({ id: uuid(), ts, device: h.deviceId, user: safeName(user), type: "mem", since: ts, by: "user" });
		this.caughtUp.clear();
	}
}
