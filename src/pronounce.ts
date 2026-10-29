// 發音：依序嘗試
//   1. Vault 裡已存好的錄音（任何裝置存的都可以用，離線也能播）
//   2. 單字：Free Dictionary API 的真人錄音（免費、不需金鑰）
//   3. Gemini 語音模型（有免費額度；額度用完當天就不再呼叫）
//   4. 系統語音（speechSynthesis）
// 新取得的錄音存到 english/audio/<deviceId>/<hash>.<ext>：每台裝置只寫自己的資料夾（單一寫入者）。
import { App, TAbstractFile, TFile, normalizePath, requestUrl } from "obsidian";
import { AIError, quotaDay } from "./ai";
import { CloudUsage, billedChars, cloudMonth, synthCloud } from "./cloudtts";

export const AUDIO_DIR = "english/audio";
const LS_DICT_MISS = "english-learning:dict-miss";
const LS_TTS_QUOTA = "english-learning:tts-quota";

export interface PronounceSettings {
	dictAudio: boolean;
	geminiTts: boolean;
	ttsModel: string;
	ttsVoice: string;
	ttsDailyCap: number;
	prefetchGemini?: boolean;
	cloudTts?: boolean; // Google Cloud 語音（Chirp 3 HD）
	cloudVoice?: string;
	cloudMonthlyCap?: number;
}

export type PronounceSource = "cache" | "dict" | "cloud" | "gemini" | "system";

// ---------------------------------------------------------------------
// 雜湊與正規化

/** cyrb53：簡單、穩定的 53-bit 雜湊，不需要 crypto.subtle。 */
function cyrb53(str: string, seed = 0): string {
	let h1 = 0xdeadbeef ^ seed,
		h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export function normalizeSpeech(text: string): string {
	return text
		.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
		.replace(/[’‘]/g, "'")
		.replace(/^\s*(\.\.\.|…)\s*/, "") // 題庫原句常以 ... 開頭或結尾，唸的時候一樣
		.replace(/\s*(\.\.\.|…)\s*$/, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function audioKey(text: string): string {
	return cyrb53(normalizeSpeech(text).toLowerCase());
}

export function isSingleWord(text: string): boolean {
	return /^[A-Za-z][A-Za-z'-]*$/.test(normalizeSpeech(text));
}

// ---------------------------------------------------------------------
// 每日額度（以 Google 的重置時間：美國太平洋時間午夜為準）

export { quotaDay };

interface QuotaState {
	day: string;
	count: number;
	exhausted: boolean;
}

export function loadQuota(app: App): QuotaState {
	const today = quotaDay();
	const q = app.loadLocalStorage(LS_TTS_QUOTA) as QuotaState | null;
	if (!q || q.day !== today) return { day: today, count: 0, exhausted: false };
	return q;
}

function saveQuota(app: App, q: QuotaState) {
	app.saveLocalStorage(LS_TTS_QUOTA, q);
}

// ---------------------------------------------------------------------
// 播放（iOS 需要在使用者點擊的同一個事件裡先「解鎖」播放）

const SILENT_WAV =
	"data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
let player: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

/** 一定要在 click handler 裡同步呼叫。 */
export function unlockAudio() {
	try {
		if (!player) player = new Audio();
		player.src = SILENT_WAV;
		player.play().catch(() => undefined);
	} catch {
		/* 沒有 Audio 也沒關係，最後會退回系統語音 */
	}
}

/** 停止正在播放的錄音。 */
export function stopAudio() {
	try {
		player?.pause();
	} catch {
		/* ignore */
	}
}

async function playBuffer(data: ArrayBuffer, mime: string, rate = 1): Promise<void> {
	if (!player) player = new Audio();
	if (currentUrl) URL.revokeObjectURL(currentUrl);
	currentUrl = URL.createObjectURL(new Blob([data], { type: mime }));
	player.src = currentUrl;
	player.defaultPlaybackRate = rate;
	player.playbackRate = rate;
	await player.play();
}

/** 播放並等到播完（或被停止）。 */
async function playToEnd(data: ArrayBuffer, mime: string): Promise<void> {
	await playBuffer(data, mime);
	const p = player;
	if (!p) return;
	await new Promise<void>((done) => {
		const end = () => {
			p.removeEventListener("ended", end);
			p.removeEventListener("pause", end);
			p.removeEventListener("error", end);
			done();
		};
		p.addEventListener("ended", end);
		p.addEventListener("pause", end);
		p.addEventListener("error", end);
	});
}

/** 把一段話切成「第一句」和「其他」：第一句先產生、先播，等待時間比較短。 */
export function splitForSpeech(text: string): string[] {
	const t = text.replace(/\s+/g, " ").trim();
	const m = /^(.{12,}?[.!?])\s+(\S.*)$/.exec(t);
	if (!m || t.length < 60) return t ? [t] : [];
	return [m[1], m[2]];
}

function mimeFor(path: string): string {
	return path.endsWith(".mp3") ? "audio/mpeg" : path.endsWith(".ogg") ? "audio/ogg" : "audio/wav";
}

// ---------------------------------------------------------------------

/**
 * 把 24 kHz、16-bit、單聲道的 WAV 轉成 16 kHz，檔案小三分之一，語音清晰度幾乎不變。
 * 不是這個格式就原樣回傳。
 */
export function downsampleWav(buf: ArrayBuffer, target = 16000): ArrayBuffer {
	const v = new DataView(buf);
	if (buf.byteLength < 44 || v.getUint32(0, false) !== 0x52494646 || v.getUint32(8, false) !== 0x57415645) return buf;
	// 找 fmt 與 data chunk
	let off = 12,
		rate = 0,
		ch = 0,
		bits = 0,
		fmt = 0,
		dataOff = -1,
		dataLen = 0;
	while (off + 8 <= buf.byteLength) {
		const id = v.getUint32(off, false);
		const len = v.getUint32(off + 4, true);
		if (id === 0x666d7420) {
			fmt = v.getUint16(off + 8, true);
			ch = v.getUint16(off + 10, true);
			rate = v.getUint32(off + 12, true);
			bits = v.getUint16(off + 22, true);
		} else if (id === 0x64617461) {
			dataOff = off + 8;
			dataLen = Math.min(len, buf.byteLength - dataOff);
			break;
		}
		off += 8 + len + (len % 2);
	}
	if (fmt !== 1 || ch !== 1 || bits !== 16 || dataOff < 0 || rate <= target) return buf;
	const n = Math.floor(dataLen / 2);
	const src = new Int16Array(n);
	for (let i = 0; i < n; i++) src[i] = v.getInt16(dataOff + i * 2, true);
	const ratio = rate / target;
	const outN = Math.floor(n / ratio);
	const out = new ArrayBuffer(44 + outN * 2);
	const o = new DataView(out);
	const w = (p: number, s: string) => {
		for (let i = 0; i < 4; i++) o.setUint8(p + i, s.charCodeAt(i));
	};
	w(0, "RIFF");
	o.setUint32(4, 36 + outN * 2, true);
	w(8, "WAVE");
	w(12, "fmt ");
	o.setUint32(16, 16, true);
	o.setUint16(20, 1, true);
	o.setUint16(22, 1, true);
	o.setUint32(24, target, true);
	o.setUint32(28, target * 2, true);
	o.setUint16(32, 2, true);
	o.setUint16(34, 16, true);
	w(36, "data");
	o.setUint32(40, outN * 2, true);
	for (let i = 0; i < outN; i++) {
		// 對來源區間取平均（簡單的低通），再做線性內插
		const pos = i * ratio;
		const a = Math.floor(pos);
		const b = Math.min(a + 1, n - 1);
		const frac = pos - a;
		let s = src[a] * (1 - frac) + src[b] * frac;
		const c = Math.min(a + 2, n - 1);
		s = (s * 2 + src[c] * 0.5 + src[Math.max(a - 1, 0)] * 0.5) / 3;
		o.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(s))), true);
	}
	return out;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out.buffer;
}

/** 在 Gemini Interactions API 的回應裡找 base64 音訊。 */
export function findAudioData(j: unknown): string | null {
	const steps = (j as { steps?: { type?: string; content?: { type?: string; data?: string }[] }[] })?.steps;
	if (Array.isArray(steps)) {
		for (let i = steps.length - 1; i >= 0; i--) {
			const c = steps[i]?.content;
			if (!Array.isArray(c)) continue;
			for (let k = c.length - 1; k >= 0; k--) if (c[k]?.type === "audio" && typeof c[k].data === "string") return c[k].data as string;
		}
	}
	// 退路：舊的 generateContent 格式
	const parts = (j as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] })?.candidates?.[0]?.content?.parts;
	if (Array.isArray(parts)) for (const p of parts) if (p?.inlineData?.data) return p.inlineData.data;
	return null;
}

export interface PronounceDeps {
	app: App;
	deviceId: string;
	settings: () => PronounceSettings;
	apiKey: () => string | null;
	cloudKey?: () => string | null;
	systemSpeak: (text: string, rate?: number) => Promise<unknown>;
	log: (source: PronounceSource, extra: Record<string, unknown>) => void;
	notice: (msg: string) => void;
	debug: (msg: string) => void;
}

export class Pronouncer {
	private index = new Map<string, string[]>(); // key → 檔案路徑
	private inflight = new Map<string, Promise<PronounceSource>>();
	private warnedExhausted = false;
	private dictDownUntil = 0; // 字典服務暫時掛掉時，一小時內不再嘗試

	readonly cloudUsage: CloudUsage;
	private cloudOffUntil = 0; // Google Cloud 語音出錯（金鑰、權限）：這段時間不再試
	private cloudWarned = false;

	constructor(private d: PronounceDeps) {
		this.cloudUsage = new CloudUsage(d.app);
	}

	// ---- Google Cloud 語音（Chirp 3 HD）----
	/** 能用 Google Cloud 語音就回傳金鑰：有開啟、有金鑰、沒出錯暫停、本月沒到上限（含這段文字）。 */
	private async cloudReady(text: string): Promise<string | null> {
		const s = this.d.settings();
		const key = this.d.cloudKey?.();
		if (!s.cloudTts || !key || Date.now() < this.cloudOffUntil) return null;
		const cap = s.cloudMonthlyCap ?? 800_000;
		if ((await this.cloudUsage.used()) + billedChars(text) > cap) {
			if (!this.cloudWarned) {
				this.cloudWarned = true;
				this.d.notice(`Google Cloud 語音這個月已用到上限（${cap.toLocaleString()} 字），下個月自動恢復；先改用其他語音。`);
			}
			return null;
		}
		return key;
	}

	/** 取得 Google Cloud 語音（MP3）；失敗回傳 null（並視情況暫停）。 */
	private async fetchCloud(text: string, extra: Record<string, unknown> = {}): Promise<ArrayBuffer | null> {
		const key = await this.cloudReady(text);
		if (!key) return null;
		const s = this.d.settings();
		try {
			const mp3 = await synthCloud(key, text, s.cloudVoice || "Kore");
			const chars = billedChars(text);
			this.cloudUsage.add(chars);
			this.d.log("cloud", { text: text.slice(0, 200), chars, month: cloudMonth(), voice: s.cloudVoice || "Kore", bytes: mp3.byteLength, ...extra });
			return mp3;
		} catch (e) {
			const kind = e instanceof AIError ? e.kind : "other";
			// 金鑰或權限問題：這次開著的期間不再試；其他錯誤：暫停 1 分鐘
			this.cloudOffUntil = Date.now() + (kind === "auth" ? 24 * 3600_000 : 60_000);
			this.d.debug(`cloud tts failed: ${(e as Error)?.message ?? e}`);
			if (kind === "auth") this.d.notice(`Google Cloud 語音無法使用：${(e as Error)?.message ?? e}。請到設定檢查金鑰與 API 是否開啟；先改用其他語音。`);
			return null;
		}
	}

	/** 設定頁「試聽」：一定用 Google Cloud 語音，失敗就丟錯誤。 */
	async testCloud(text: string): Promise<void> {
		const s = this.d.settings();
		const key = this.d.cloudKey?.();
		if (!key) throw new Error("還沒設定 Google Cloud 語音的金鑰");
		this.cloudOffUntil = 0;
		const mp3 = await synthCloud(key, text, s.cloudVoice || "Kore");
		const chars = billedChars(text);
		this.cloudUsage.add(chars);
		this.d.log("cloud", { text, chars, month: cloudMonth(), voice: s.cloudVoice || "Kore", bytes: mp3.byteLength, test: true });
		await playBuffer(mp3, "audio/mpeg");
	}

	// ---- 索引 ----
	rebuildIndex() {
		this.index.clear();
		for (const f of this.d.app.vault.getFiles()) this.add(f);
	}

	onCreate(f: TAbstractFile) {
		if (f instanceof TFile) this.add(f);
	}

	onDelete(f: TAbstractFile | string) {
		const path = typeof f === "string" ? f : f.path;
		for (const [k, list] of this.index) {
			const next = list.filter((p) => p !== path);
			if (next.length !== list.length) next.length ? this.index.set(k, next) : this.index.delete(k);
		}
	}

	private add(f: TFile) {
		if (!f.path.startsWith(AUDIO_DIR + "/")) return;
		const key = f.basename;
		if (!/^[0-9a-f]{14}$/.test(key)) return;
		const list = this.index.get(key) ?? [];
		if (!list.includes(f.path)) list.push(f.path);
		// 真人錄音（mp3）優先
		list.sort((a, b) => Number(b.endsWith(".mp3")) - Number(a.endsWith(".mp3")));
		this.index.set(key, list);
	}

	cachedCount(): number {
		return this.index.size;
	}

	// ---- 主流程 ----
	/** 呼叫前請先在 click handler 裡同步呼叫 unlockAudio()。 */
	async pronounce(text: string, opts: { forceGemini?: boolean; rate?: number; noSave?: boolean } = {}): Promise<PronounceSource> {
		const t = normalizeSpeech(text);
		if (!t) return "system";
		const key = audioKey(t);
		const running = this.inflight.get(key);
		if (running && !opts.forceGemini && !opts.rate) return running;
		const job = this.run(t, key, opts).finally(() => this.inflight.delete(key));
		this.inflight.set(key, job);
		return job;
	}

	private fallbackNoticeDay = "";
	/** 自然語音用完、改用系統語音時，一天提醒一次。 */
	private noticeFallbackOnce() {
		const day = quotaDay();
		if (this.fallbackNoticeDay === day) return;
		this.fallbackNoticeDay = day;
		this.d.notice("今天的 Gemini 自然語音（免費版每天 10 段）已用完，改用系統語音（台灣時間下午 3～4 點恢復）。");
	}

	private ttsPauseUntil = 0; // 每分鐘上限：暫停到這個時間
	private interactiveUntil = 0; // 對話正在用語音：背景預先產生先讓路

	/** Gemini 語音收到 429：每日額度用完回傳 true（當天停用）；每分鐘上限只暫停一分鐘。 */
	private hit429(e: AIError): boolean {
		const daily = /per ?day|PerDay|daily/i.test(`${e.body ?? ""} ${e.message}`);
		if (daily) {
			const q = loadQuota(this.d.app);
			q.exhausted = true;
			saveQuota(this.d.app, q);
		} else {
			this.ttsPauseUntil = Date.now() + 60_000;
			this.d.debug("gemini tts: per-minute limit, pausing 60 s");
		}
		return daily;
	}

	private async run(text: string, key: string, opts: { forceGemini?: boolean; rate?: number; noSave?: boolean }): Promise<PronounceSource> {
		const rate = opts.rate ?? 1;
		const s = this.d.settings();
		// 1. 已存的錄音
		if (!opts.forceGemini) {
			for (const path of this.index.get(key) ?? []) {
				const f = this.d.app.vault.getAbstractFileByPath(path);
				if (!(f instanceof TFile)) continue;
				try {
					await playBuffer(await this.d.app.vault.readBinary(f), mimeFor(path), rate);
					return "cache";
				} catch (e) {
					this.d.debug(`play cache failed ${path}: ${(e as Error)?.name ?? e}`);
				}
			}
		}
		// 2. 字典真人錄音（單字）
		if (!opts.forceGemini && s.dictAudio && isSingleWord(text) && !this.dictMissed(text) && Date.now() > this.dictDownUntil) {
			try {
				const got = await this.fetchDict(text);
				if (got) {
					await this.save(key, "mp3", got);
					this.d.log("dict", { text });
					await playBuffer(got, "audio/mpeg", rate);
					return "dict";
				}
				this.markDictMiss(text);
			} catch (e) {
				this.dictDownUntil = Date.now() + 3600_000;
				this.d.debug(`dict failed ${text}: ${(e as Error)?.message ?? e}（一小時內不再嘗試字典）`);
			}
		}
		// 3. Google Cloud 語音（Chirp 3 HD）
		if (!opts.forceGemini) {
			const mp3 = await this.fetchCloud(text, opts.noSave ? { noSave: true } : {});
			if (mp3) {
				const playing = playBuffer(mp3, "audio/mpeg", rate);
				if (!opts.noSave) await this.save(key, "mp3", mp3);
				await playing;
				return "cloud";
			}
		}
		// 4. Gemini 語音
		if (s.geminiTts && this.quotaOk(s)) {
			try {
				const wav = await this.fetchGemini(text, s);
				const q = loadQuota(this.d.app);
				q.count++;
				saveQuota(this.d.app, q);
				// 先播放再存檔，少等一點；對話回覆這類一次性的句子不存（noSave）
				const playing = playBuffer(wav, "audio/wav", rate);
				if (!opts.noSave) await this.save(key, "wav", wav);
				this.d.log("gemini", { text: text.slice(0, 200), model: s.ttsModel, voice: s.ttsVoice, bytes: wav.byteLength, todayCount: q.count, ...(opts.noSave ? { noSave: true } : {}) });
				await playing;
				return "gemini";
			} catch (e) {
				if (e instanceof AIError && e.status === 429) {
					if (this.hit429(e)) this.d.notice("今天的 Gemini 語音免費額度已用完，改用系統語音（台灣時間下午 3～4 點重置）");
					this.d.log("gemini", { ok: false, status: 429 });
				} else {
					this.d.debug(`gemini tts failed: ${(e as Error)?.message ?? e}${e instanceof AIError && e.body ? ` body=${e.body}` : ""}`);
				}
			}
		}
		// 5. 系統語音
		await this.d.systemSpeak(text, opts.rate);
		return "system";
	}

	/**
	 * 預先產生用：確保這段文字有錄音（不播放、不用系統語音）。
	 * 回傳 "cache"（已存在）、"dict"、"gemini"、"quota"（額度或上限用完）或 "none"（無法取得）。
	 */
	async ensure(text: string): Promise<"cache" | "dict" | "cloud" | "gemini" | "quota" | "busy" | "none"> {
		const t = normalizeSpeech(text);
		if (!t) return "none";
		const key = audioKey(t);
		if (this.index.has(key)) return "cache";
		const s = this.d.settings();
		if (s.dictAudio && isSingleWord(t) && !this.dictMissed(t) && Date.now() > this.dictDownUntil) {
			try {
				const got = await this.fetchDict(t);
				if (got) {
					await this.save(key, "mp3", got);
					this.d.log("dict", { text: t, prefetch: true });
					return "dict";
				}
				this.markDictMiss(t);
			} catch (e) {
				this.dictDownUntil = Date.now() + 3600_000;
				this.d.debug(`prefetch dict failed ${t}: ${(e as Error)?.message ?? e}`);
			}
		}
		if ((s.cloudTts || (s.geminiTts && s.prefetchGemini)) && Date.now() < this.interactiveUntil) return "busy"; // 對話正在用語音：先讓路
		if (s.cloudTts) {
			const mp3 = await this.fetchCloud(t, { prefetch: true });
			if (mp3) {
				await this.save(key, "mp3", mp3);
				return "cloud";
			}
		}
		if (!s.geminiTts || !s.prefetchGemini) return "none"; // 免費版每天只有 10 段，留給對話與點播
		const q = loadQuota(this.d.app);
		if (q.exhausted || q.count >= s.ttsDailyCap) return "quota";
		if (Date.now() < this.ttsPauseUntil || Date.now() < this.interactiveUntil) return "busy"; // 每分鐘上限、或對話正在用語音
		try {
			const wav = await this.fetchGemini(t, s);
			const q2 = loadQuota(this.d.app);
			q2.count++;
			saveQuota(this.d.app, q2);
			await this.save(key, "wav", wav);
			this.d.log("gemini", { text: t.slice(0, 200), prefetch: true, bytes: wav.byteLength, todayCount: q2.count });
			return "gemini";
		} catch (e) {
			if (e instanceof AIError && e.status === 429) return this.hit429(e) ? "quota" : "busy";
			this.d.debug(`prefetch gemini failed: ${(e as Error)?.message ?? e}`);
			return "none";
		}
	}

	has(text: string): boolean {
		return this.index.has(audioKey(normalizeSpeech(text)));
	}

	private quotaOk(s: PronounceSettings): boolean {
		const q = loadQuota(this.d.app);
		if (q.exhausted || Date.now() < this.ttsPauseUntil) return false;
		if (q.count >= s.ttsDailyCap) {
			if (!this.warnedExhausted) {
				this.warnedExhausted = true;
				this.d.notice(`今天已產生 ${q.count} 段 Gemini 語音，達到設定的上限，改用系統語音`);
			}
			return false;
		}
		return true;
	}

	// ---- 字典 ----
	private dictMissed(word: string): boolean {
		const list = this.d.app.loadLocalStorage(LS_DICT_MISS);
		return Array.isArray(list) && list.includes(word.toLowerCase());
	}

	private markDictMiss(word: string) {
		const list = this.d.app.loadLocalStorage(LS_DICT_MISS);
		const arr: string[] = Array.isArray(list) ? list : [];
		arr.push(word.toLowerCase());
		this.d.app.saveLocalStorage(LS_DICT_MISS, arr.slice(-2000));
	}

	private async fetchDict(word: string): Promise<ArrayBuffer | null> {
		const res = await requestUrl({
			url: `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`,
			throw: false,
		});
		if (res.status === 404) return null;
		if (res.status !== 200) throw new Error(`dictionary HTTP ${res.status}`);
		const urls: string[] = [];
		for (const entry of Array.isArray(res.json) ? res.json : [])
			for (const ph of entry?.phonetics ?? []) if (typeof ph?.audio === "string" && ph.audio) urls.push(ph.audio);
		if (!urls.length) return null;
		const pick = urls.find((u) => /-us\.mp3$/i.test(u)) ?? urls.find((u) => /\.mp3$/i.test(u)) ?? urls[0];
		const url = pick.startsWith("//") ? `https:${pick}` : pick;
		const audio = await requestUrl({ url, throw: false });
		if (audio.status !== 200 || !audio.arrayBuffer.byteLength) return null;
		return audio.arrayBuffer;
	}

	// ---- Gemini ----
	/**
	 * 一次性的句子（對話回覆）用自然語音唸：切成第一句與其他，同時請 Gemini 產生，依序播放。
	 * 不存檔。拿不到 Gemini 語音（額度用完、失敗）就回傳 false，由呼叫的地方改用系統語音。
	 * 呼叫前請先在點擊事件裡呼叫 unlockAudio()。
	 */
	async speakNatural(text: string, isStopped: () => boolean = () => false): Promise<boolean> {
		const s = this.d.settings();
		// 免費版每天只有 10 段：整段一次產生（切成兩段會用掉兩段額度）；付費後每日上限調高才切開先唸第一句
		const t = normalizeSpeech(text);
		this.interactiveUntil = Date.now() + 5 * 60_000;
		if (!t) return false;
		// Google Cloud 語音：切成第一句與其他，同時產生，第一句先唸
		if (s.cloudTts && (await this.cloudReady(t))) {
			const jobs = splitForSpeech(t).map((part) => this.fetchCloud(part, { noSave: true }));
			let played = false;
			for (const job of jobs) {
				const mp3 = await job;
				if (isStopped()) return true;
				if (!mp3) break; // 失敗：沒唸過就往下試 Gemini，唸過一半就算了
				await playToEnd(mp3, "audio/mpeg");
				played = true;
			}
			if (played) return true;
		}
		const parts = s.ttsDailyCap > 20 ? splitForSpeech(t) : [t];
		if (!s.geminiTts) return false;
		if (!this.quotaOk(s)) {
			this.noticeFallbackOnce();
			return false;
		}
		const jobs = parts.map((t) =>
			this.fetchGemini(t, s).then(
				(wav) => {
					const q = loadQuota(this.d.app);
					q.count++;
					saveQuota(this.d.app, q);
					this.d.log("gemini", { text: t.slice(0, 200), model: s.ttsModel, voice: s.ttsVoice, bytes: wav.byteLength, todayCount: q.count, noSave: true });
					return wav;
				},
				(e) => {
					if (e instanceof AIError && e.status === 429 && this.hit429(e)) this.noticeFallbackOnce();
					this.d.debug(`natural speech failed: ${(e as Error)?.message ?? e}`);
					return null;
				},
			),
		);
		let played = false;
		for (const job of jobs) {
			const wav = await job;
			if (isStopped()) return true;
			if (!wav) return played; // 後半失敗：前半已經唸了就算了
			await playToEnd(wav, "audio/wav");
			played = true;
		}
		return played;
	}

	/** 速度測試：Gemini 語音的網路時間與解碼時間（會計入每日上限，不播放、不存檔）。 */
	async benchTts(text: string): Promise<{ ms: number; decodeMs: number; bytes: number }> {
		const s = this.d.settings();
		const t0 = Date.now();
		const timing = { fetched: 0 };
		const wav = await this.fetchGemini(text, s, timing);
		const q = loadQuota(this.d.app);
		q.count++;
		saveQuota(this.d.app, q);
		const t2 = Date.now();
		return { ms: timing.fetched - t0, decodeMs: t2 - timing.fetched, bytes: wav.byteLength };
	}

	private async fetchGemini(text: string, s: PronounceSettings, timing?: { fetched: number }): Promise<ArrayBuffer> {
		const key = this.d.apiKey();
		if (!key) throw new Error("沒有 API key");
		const res = await requestUrl({
				url: "https://generativelanguage.googleapis.com/v1beta/interactions",
				method: "POST",
				contentType: "application/json",
				headers: { "x-goog-api-key": key },
				body: JSON.stringify({
					model: s.ttsModel,
					input: [{ type: "user_input", content: [{ type: "text", text }] }],
				response_format: { type: "audio" },
				generation_config: { speech_config: [{ voice: s.ttsVoice }] },
			}),
			throw: false,
		});
		if (timing) timing.fetched = Date.now();
		if (res.status < 200 || res.status >= 300) {
			let msg = `TTS HTTP ${res.status}`;
			try {
				if (res.json?.error?.message) msg += `: ${res.json.error.message}`;
			} catch {
				/* ignore */
			}
			throw new AIError(msg, res.status, res.text?.slice(0, 1000));
		}
		const data = findAudioData(res.json);
		if (!data) throw new Error("回應裡沒有音訊");
		// 回傳 24 kHz WAV；存檔前降到 16 kHz 節省空間
		return downsampleWav(base64ToArrayBuffer(data));
	}

	// ---- 存檔 ----
	private async save(key: string, ext: string, data: ArrayBuffer) {
		const folder = normalizePath(`${AUDIO_DIR}/${this.d.deviceId}`);
		const path = normalizePath(`${folder}/${key}.${ext}`);
		try {
			let cur = "";
			for (const p of folder.split("/")) {
				cur = cur ? `${cur}/${p}` : p;
				if (!(await this.d.app.vault.adapter.exists(cur))) await this.d.app.vault.createFolder(cur).catch(() => undefined);
			}
			if (!(await this.d.app.vault.adapter.exists(path))) {
				const f = await this.d.app.vault.createBinary(path, data);
				this.add(f);
			}
		} catch (e) {
			this.d.debug(`save audio failed ${path}: ${(e as Error)?.message ?? e}`);
		}
	}
}
