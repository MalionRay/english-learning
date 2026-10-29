// 即時中文翻譯（舊題庫沒有預先產生翻譯、或文章段落時使用）。
// 結果快取在這台裝置的 localStorage，翻過一次就不用再呼叫 API。
import { App, Notice } from "obsidian";
import type { AIBackend } from "./ai";
import { audioKey } from "./pronounce";

const LS_ZH = "english-learning:zh-cache";
const MAX_ENTRIES = 1500;

type Cache = Record<string, string>;

function load(app: App): Cache {
	const c = app.loadLocalStorage(LS_ZH);
	return c && typeof c === "object" ? (c as Cache) : {};
}

function save(app: App, c: Cache) {
	const keys = Object.keys(c);
	if (keys.length > MAX_ENTRIES) for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete c[k];
	app.saveLocalStorage(LS_ZH, c);
}

const SYSTEM = `You translate English for a Taiwanese learner into Traditional Chinese as used in Taiwan (繁體中文，台灣用語).
For a single word or short phrase, give its part of speech and common meanings briefly, e.g. 「(n.) 間諜活動」.
For a sentence or paragraph, translate it naturally and completely.
Return ONLY JSON: {"zh": ["<translation of item 1>", "<translation of item 2>", ...]} with exactly one entry per input item, in order.`;

export function cachedZh(app: App, text: string): string | undefined {
	return load(app)[audioKey(text)];
}

/** 一次翻譯多段文字（一個 API 呼叫）；已快取的不再送出。 */
export async function translateMany(app: App, ai: AIBackend, texts: string[]): Promise<string[]> {
	const cache = load(app);
	const out: string[] = texts.map((t) => cache[audioKey(t)] ?? "");
	const todo = texts.map((t, i) => ({ t, i })).filter((x) => !out[x.i]);
	if (todo.length) {
		const prompt = todo.map((x, k) => `${k + 1}. ${x.t}`).join("\n");
		const res = await ai.complete(prompt, { system: SYSTEM, json: true, maxOutputTokens: 4096, temperature: 0.2, hedgeAfterMs: 6000, timeoutMs: 25000 });
		let arr: unknown;
		try {
			arr = JSON.parse(res.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")).zh;
		} catch {
			throw new Error("翻譯結果格式不對");
		}
		if (!Array.isArray(arr)) throw new Error("翻譯結果格式不對");
		todo.forEach((x, k) => {
			const zh = typeof arr[k] === "string" ? (arr[k] as string).trim() : "";
			if (zh) {
				out[x.i] = zh;
				cache[audioKey(x.t)] = zh;
			}
		});
		save(app, cache);
	}
	return out;
}

/** 點字「看中文意思」：馬上顯示「查詢中…」，查到後更新同一個提示（iPad 上等待時才不會像沒反應）。 */
export async function noticeMeaning(app: App, getAi: () => AIBackend, word: string): Promise<void> {
	const cached = cachedZh(app, word);
	if (cached) {
		new Notice(`${word}：${cached}`, 8000);
		return;
	}
	const n = new Notice(`${word}：查詢中…`, 0);
	try {
		if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("沒有網路");
		const zh = (await translateMany(app, getAi(), [word]))[0];
		n.setMessage(`${word}：${zh || "（查不到）"}`);
	} catch (e) {
		n.setMessage(`${word}：無法翻譯（${(e as Error)?.message ?? e}）`);
	}
	setTimeout(() => n.hide(), 8000);
}
