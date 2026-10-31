// 即時中文翻譯（舊題庫沒有預先產生翻譯、或文章段落時使用）。
// 結果快取在這台裝置的 localStorage，翻過一次就不用再呼叫 API。
import { App, Notice } from "obsidian";
import type { AIBackend } from "./ai";
import { audioKey } from "./pronounce";
import { LANG, Lang, normWord, tokenize } from "./lang";

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

function systemFor(lang: Lang): string {
	if (lang === "en") return SYSTEM;
	const word =
		lang === "ja"
			? "For a single word or short phrase, give its hiragana reading, romaji, part of speech and common meanings briefly, e.g. 「てんき（tenki）(n.) 天氣」; for a conjugated verb or adjective also give the dictionary form, e.g. 「いきました（ikimashita）← 行く 去（過去式）」."
			: "For a single word or short phrase, give its part of speech and common meanings briefly, e.g. 「(n.) 房子」; for a conjugated verb also give the infinitive and the form, e.g. 「fui ← ir 去（過去式，我）」.";
	return `You translate ${LANG[lang].english} for a Taiwanese learner into Traditional Chinese as used in Taiwan (繁體中文，台灣用語).
${word}
For a sentence or paragraph, translate it naturally and completely.
Return ONLY JSON: {"zh": ["<translation of item 1>", "<translation of item 2>", ...]} with exactly one entry per input item, in order.`;
}

/** 快取 key：英文沿用舊的；其他語言前面加語言。 */
function zhKey(text: string, lang: Lang): string {
	return audioKey(text, lang);
}

export function cachedZh(app: App, text: string, lang: Lang = "en"): string | undefined {
	return load(app)[zhKey(text, lang)];
}

/** 一次翻譯多段文字（一個 API 呼叫）；已快取的不再送出。 */
export async function translateMany(app: App, ai: AIBackend, texts: string[], lang: Lang = "en"): Promise<string[]> {
	const cache = load(app);
	const out: string[] = texts.map((t) => cache[zhKey(t, lang)] ?? "");
	const todo = texts.map((t, i) => ({ t, i })).filter((x) => !out[x.i]);
	if (todo.length) {
		const prompt = todo.map((x, k) => `${k + 1}. ${x.t}`).join("\n");
		const res = await ai.complete(prompt, { system: systemFor(lang), json: true, maxOutputTokens: 4096, temperature: 0.2, hedgeAfterMs: 6000, timeoutMs: 25000 });
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
				cache[zhKey(x.t, lang)] = zh;
			}
		});
		save(app, cache);
	}
	return out;
}

/** 點字「看中文意思」：馬上顯示「查詢中…」，查到後更新同一個提示（iPad 上等待時才不會像沒反應）。 */
export async function noticeMeaning(app: App, getAi: () => AIBackend, word: string, lang: Lang = "en"): Promise<void> {
	const cached = cachedZh(app, word, lang);
	if (cached) {
		new Notice(`${word}：${cached}`, 8000);
		return;
	}
	const n = new Notice(`${word}：查詢中…`, 0);
	try {
		if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("沒有網路");
		const zh = (await translateMany(app, getAi(), [word], lang))[0];
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
export async function inlineMeaning(app: App, getAi: () => AIBackend, word: string, anchor: HTMLElement | null, lang: Lang = "en"): Promise<void> {
	if (!anchor || !anchor.parentElement) return noticeMeaning(app, getAi, word, lang);
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
	const cached = cachedZh(app, word, lang);
	if (cached) {
		tag.textContent = cached;
		return;
	}
	tag.textContent = "查詢中…";
	try {
		if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("沒有網路");
		tag.textContent = (await translateMany(app, getAi(), [word], lang))[0] || "查不到";
	} catch (e) {
		tag.textContent = `無法翻譯：${(e as Error)?.message ?? e}`;
	}
}

/** 不值得預先查的常見字。 */
const COMMON = new Set(
	"a an the i me my you your he him his she her it its we us our they them their is am are was were be been being do does did have has had will would can could should may might must to of in on at for with from by as and or but so if not no yes this that these those there here what who how why when where which just very really too also about up out oh ok okay".split(" "),
);

const COMMON_ES = new Set(
	"el la los las un una unos unas y o pero que de del a al en con por para es son está están ser estar yo tú él ella nosotros ustedes ellos me te se le lo nos mi tu su sí no muy más bien hola qué cómo cuándo dónde porque también".split(" "),
);

/** 日文裡不值得查的：標點、只有一兩個平假名的（助詞、です的一部分）。 */
function trivialJa(w: string): boolean {
	return !w || /^[\u3040-\u309f]{1,2}$/.test(w) || /^[\p{P}\s]+$/u.test(w);
}

/** 一段外語裡值得預先查中文的字（去重、跳過常見字與已查過的）。 */
export function wordsToPrefetch(app: App, text: string, max = 30, lang: Lang = "en"): string[] {
	const out: string[] = [];
	if (lang !== "en") {
		for (const t of tokenize(text, lang)) {
			if (!t.word) continue;
			const w = lang === "ja" ? t.text.trim() : normWord(t.text, lang);
			if (lang === "ja" ? trivialJa(w) : w.length < 3 || COMMON_ES.has(w)) continue;
			// 點字時查的是畫面上的原字，快取也用原字
			if (out.includes(t.text) || cachedZh(app, t.text, lang)) continue;
			out.push(t.text);
			if (out.length >= max) break;
		}
		return out;
	}
	for (const m of text.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z][a-z'-]*[a-z]|[a-z]/g) ?? []) {
		const w = m.replace(/'s$/, "");
		if (w.length < 3 || COMMON.has(w) || out.includes(w) || cachedZh(app, w)) continue;
		out.push(w);
		if (out.length >= max) break;
	}
	return out;
}

/** 背景先把這段英文裡的字一次查好（一次呼叫），之後點字就會立刻出現中文。失敗就算了。 */
export async function prefetchMeanings(app: App, ai: AIBackend, text: string, lang: Lang = "en"): Promise<number> {
	const words = wordsToPrefetch(app, text, 30, lang);
	if (!words.length) return 0;
	if (typeof navigator !== "undefined" && navigator.onLine === false) return 0;
	await translateMany(app, ai, words, lang);
	return words.length;
}

// ---------------------------------------------------------------------
// 日文讀音：整句轉成平假名與羅馬拼音（從零開始的學習者看不懂漢字的讀法）

const LS_READING = "english-learning:ja-reading-cache";

export interface Reading {
	kana: string;
	romaji: string;
}

const READING_SYSTEM = `For each Japanese text, give its reading for a beginner:
- "kana": the whole text in hiragana (convert every kanji to hiragana; keep katakana words as katakana; keep punctuation).
- "romaji": Hepburn romaji with spaces between words (particles は／へ／を written wa／e／o).
Return ONLY JSON: {"items": [{"kana": "...", "romaji": "..."}, ...]} with exactly one entry per input item, in order.`;

export function cachedReading(app: App, text: string): Reading | undefined {
	const c = app.loadLocalStorage(LS_READING) as Record<string, Reading> | null;
	return c?.[audioKey(text, "ja")];
}

function loadReadings(app: App): Record<string, Reading> {
	const raw = app.loadLocalStorage(LS_READING);
	return raw && typeof raw === "object" ? (raw as Record<string, Reading>) : {};
}

/** 一批最多幾句、幾個字（太長的話 AI 的回覆會被截斷）。 */
export const READING_BATCH = { items: 8, chars: 600 };

/** 把要查的句子分批：每批不超過 READING_BATCH。 */
export function readingBatches<T extends { t: string }>(todo: T[]): T[][] {
	const out: T[][] = [];
	let cur: T[] = [];
	let chars = 0;
	for (const x of todo) {
		if (cur.length && (cur.length >= READING_BATCH.items || chars + x.t.length > READING_BATCH.chars)) {
			out.push(cur);
			cur = [];
			chars = 0;
		}
		cur.push(x);
		chars += x.t.length;
	}
	if (cur.length) out.push(cur);
	return out;
}

/** 查多句的讀音（分批呼叫，避免回覆被截斷）；已快取的不再送出。 */
export async function readingMany(app: App, ai: AIBackend, texts: string[]): Promise<Reading[]> {
	const cache = loadReadings(app);
	const out: (Reading | undefined)[] = texts.map((t) => cache[audioKey(t, "ja")]);
	const todo = texts.map((t, i) => ({ t, i })).filter((x) => !out[x.i] && x.t.trim());
	for (const batch of readingBatches(todo)) {
		const prompt = batch.map((x, k) => `${k + 1}. ${x.t.replace(/\s*\n\s*/g, " ")}`).join("\n");
		const res = await ai.complete(prompt, { system: READING_SYSTEM, json: true, maxOutputTokens: 4096, temperature: 0, hedgeAfterMs: 6000, timeoutMs: 25000 });
		let arr: unknown;
		try {
			arr = JSON.parse(res.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")).items;
		} catch {
			throw new Error("讀音結果格式不對");
		}
		if (!Array.isArray(arr)) throw new Error("讀音結果格式不對");
		// 重新讀快取再寫回：同時有兩批在查時，才不會互相蓋掉
		const latest = loadReadings(app);
		batch.forEach((x, k) => {
			const r = arr[k] as Record<string, unknown> | undefined;
			const kana = typeof r?.kana === "string" ? r.kana.trim() : "";
			const romaji = typeof r?.romaji === "string" ? r.romaji.trim() : "";
			if (kana || romaji) {
				out[x.i] = { kana, romaji };
				latest[audioKey(x.t, "ja")] = { kana, romaji };
			}
		});
		const keys = Object.keys(latest);
		if (keys.length > MAX_ENTRIES) for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete latest[k];
		app.saveLocalStorage(LS_READING, latest);
	}
	return out.map((r) => r ?? { kana: "", romaji: "" });
}
