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

/**
 * 點字「看中文意思」：意思直接顯示在那個字的旁邊（例如 harbor（港口））。
 * 再按一次那個字的中文就收起來。找不到字的位置時改用提示框。
 */
export async function inlineMeaning(app: App, getAi: () => AIBackend, word: string, anchor: HTMLElement | null): Promise<void> {
	if (!anchor || !anchor.parentElement) return noticeMeaning(app, getAi, word);
	const next = anchor.nextElementSibling as HTMLElement | null;
	if (next?.classList.contains("el-w-zh")) {
		next.remove(); // 已經顯示：收起來
		return;
	}
	const tag = document.createElement("span");
	tag.className = "el-w-zh";
	tag.onclick = (e) => {
		e.stopPropagation();
		tag.remove();
	};
	anchor.insertAdjacentElement("afterend", tag);
	const cached = cachedZh(app, word);
	if (cached) {
		tag.textContent = cached;
		return;
	}
	tag.textContent = "查詢中…";
	try {
		if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("沒有網路");
		tag.textContent = (await translateMany(app, getAi(), [word]))[0] || "查不到";
	} catch (e) {
		tag.textContent = `無法翻譯：${(e as Error)?.message ?? e}`;
	}
}

/** 不值得預先查的常見字。 */
const COMMON = new Set(
	"a an the i me my you your he him his she her it its we us our they them their is am are was were be been being do does did have has had will would can could should may might must to of in on at for with from by as and or but so if not no yes this that these those there here what who how why when where which just very really too also about up out oh ok okay".split(" "),
);

/** 一段英文裡值得預先查中文的字（小寫、去重、跳過常見字與已查過的）。 */
export function wordsToPrefetch(app: App, text: string, max = 30): string[] {
	const out: string[] = [];
	for (const m of text.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z][a-z'-]*[a-z]|[a-z]/g) ?? []) {
		const w = m.replace(/'s$/, "");
		if (w.length < 3 || COMMON.has(w) || out.includes(w) || cachedZh(app, w)) continue;
		out.push(w);
		if (out.length >= max) break;
	}
	return out;
}

/** 背景先把這段英文裡的字一次查好（一次呼叫），之後點字就會立刻出現中文。失敗就算了。 */
export async function prefetchMeanings(app: App, ai: AIBackend, text: string): Promise<number> {
	const words = wordsToPrefetch(app, text);
	if (!words.length) return 0;
	if (typeof navigator !== "undefined" && navigator.onLine === false) return 0;
	await translateMany(app, ai, words);
	return words.length;
}
