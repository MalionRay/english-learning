// AI 出題：提示詞、題目格式驗證、選項洗牌、題庫檔輸出。
// 這個檔案不碰 Vault，方便單獨測試。
import { uuid } from "./logs";
import { LANG, Lang, countWords, langOf, wordsOf } from "./lang";

export type Level = "adult" | "kid";
export type QType = "vocab" | "cloze" | "reading" | "translate";

export const LEVEL_LABEL: Record<Level, string> = { adult: "成人", kid: "小孩" };
export const TYPE_LABEL: Record<QType, string> = {
	vocab: "單字",
	cloze: "克漏字",
	reading: "閱讀理解",
	translate: "句子翻譯",
};

interface BaseQ {
	id: string; // 題目 UUID；答題 log 以此對應，不依賴題目在檔案中的位置
	type: QType;
	prompt: string;
	explanation: string;
}
export interface ChoiceQ extends BaseQ {
	type: "vocab" | "cloze" | "reading";
	options: string[]; // 4 個
	answer: number; // 正確選項的 index
	context?: string; // 單字題：文章中的原句
	contextZh?: string; // 原句的中文翻譯
	promptZh?: string; // 題目（克漏字為完整句、閱讀為問題）的中文翻譯
	optionsZh?: string[]; // 英文選項的中文意思（與 options 同順序）
	word?: string; // 單字題：英文單字（之後進單字庫）
	ipa?: string; // 單字題：IPA 音標（美式）
	reading?: string; // 日文單字題：平假名讀音
	romaji?: string; // 日文單字題：羅馬拼音
	answerReading?: string; // 日文克漏字：答案的平假名
	answerRomaji?: string; // 日文克漏字：答案的羅馬拼音
	marked?: boolean; // 使用者標記的生字
	direction?: "en2zh" | "zh2en";
}
export interface TranslateQ extends BaseQ {
	type: "translate";
	reference: string; // 參考英文答案；練習時由 AI 批改
}
export type Question = ChoiceQ | TranslateQ;

export interface Bank {
	version: 1;
	sourceId: string;
	sourcePath: string;
	title: string;
	level: Level;
	lang?: Lang; // 沒有＝英文（舊題庫）
	model: string;
	generatedAt: string;
	device: string;
	questions: Question[];
}

export type Plan = Record<QType, number>;

export function wordCount(text: string, lang: Lang = "en"): number {
	if (lang !== "en") return countWords(text, lang);
	return (text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length;
}

export const MAX_WORDS = 5000;

/** 依文章長度決定題數：短文約 8 題，長文最多 20 題。 */
export function planFor(words: number): Plan {
	const total = words < 150 ? 8 : words < 350 ? 12 : words < 700 ? 16 : 20;
	const translate = Math.max(1, Math.round(total * 0.15));
	const reading = Math.max(1, Math.round(total * 0.25));
	const cloze = Math.round(total * 0.3);
	const vocab = total - translate - reading - cloze;
	return { vocab, cloze, reading, translate };
}

/** 使用者標記的生字較多時，增加單字題的數量（總數最多 30 題）。 */
export function planWithMarked(words: number, marked: number): Plan {
	const p = planFor(words);
	const slots = p.vocab + p.cloze;
	if (marked > slots) p.vocab += Math.min(marked - slots, 30 - planTotal(p));
	return p;
}

/** 文章中用 ==螢光筆== 標記的生字（去重、保留原順序）。 */
export function extractMarked(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const re = /==([^=\n]{1,60})==/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const w = m[1].trim();
		if (w && !seen.has(w.toLowerCase())) {
			seen.add(w.toLowerCase());
			out.push(w);
		}
	}
	return out;
}

/** 送給 AI 前拿掉螢光筆記號。 */
export function stripMarks(text: string): string {
	return text.replace(/==([^=\n]{1,60})==/g, "$1");
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把指定的生字在文章中第一次出現的地方標成 ==螢光筆==。回傳找不到的字。 */
export function markWords(text: string, words: string[], lang: Lang = "en"): { text: string; notFound: string[] } {
	const notFound: string[] = [];
	let t = text;
	if (lang === "ja") {
		// 日文沒有空白：直接找第一個還沒標記的地方
		for (const w of words.map((x) => x.trim()).filter(Boolean)) {
			if (t.includes(`==${w}==`)) continue;
			// 只在還沒標記的部分找（不要標到 ==天気予報== 裡面）
			const parts = t.split(/(==[^=\n]{1,60}==)/);
			const k = parts.findIndex((p, j) => j % 2 === 0 && p.includes(w));
			if (k < 0) {
				if (!t.includes(w)) notFound.push(w); // 已經在別的標記裡的不算找不到
				continue;
			}
			const i = parts[k].indexOf(w);
			parts[k] = `${parts[k].slice(0, i)}==${w}==${parts[k].slice(i + w.length)}`;
			t = parts.join("");
		}
		return { text: t, notFound };
	}
	const L = lang === "es" ? "A-Za-zÀ-ÖØ-öø-ÿ" : "A-Za-z";
	const suffix = lang === "es" ? "(?:s|es)?" : "(?:s|es|d|ed|ing)?";
	for (const w of words.map((x) => x.trim()).filter(Boolean)) {
		// 不用 lookbehind（舊版 iOS 不支援），改用前一個字元的群組
		// 每個字允許常見字尾變化：lodge a protest 也能對到 lodged a protest
		const pattern = w
			.split(/\s+/)
			.map((x) => `${escapeRe(x)}${suffix}`)
			.join("\\s+");
		const re = new RegExp(`(^|[^${L}=])(${pattern})(?![${L}=])`, "i");
		if (re.test(t)) t = t.replace(re, "$1==$2==");
		else if (!new RegExp(pattern, "i").test(t)) notFound.push(w); // 已經被標記過的不算找不到
	}
	return { text: t, notFound };
}

/** 有哪些標記的生字沒有出現在任何單字題或克漏字答案中。 */
export function missingMarked(qs: Question[], marked: string[]): string[] {
	const covered = new Set<string>();
	for (const q of qs) {
		if (q.type === "vocab") {
			if (q.word) covered.add(q.word.toLowerCase());
			covered.add(q.prompt.toLowerCase());
			covered.add(q.options[q.answer].toLowerCase());
		} else if (q.type === "cloze") covered.add(q.options[q.answer].toLowerCase());
	}
	const hit = (m: string) => [...covered].some((c) => c === m || c.includes(m) || m.includes(c));
	return marked.filter((m) => !hit(m.toLowerCase()));
}

export function planTotal(p: Plan): number {
	return p.vocab + p.cloze + p.reading + p.translate;
}

const LEVEL_GUIDE: Record<Level, string> = {
	adult:
		"Learner: a Taiwanese adult at roughly CEFR B1–B2 aiming for C1. Prefer vocabulary that is useful at this level: collocations, phrasal verbs, idioms, and common words used in a less common sense are all good choices. Reading questions may test inference and the author's intent.",
	kid:
		"Learner: a Taiwanese primary-school child at roughly CEFR A1–A2. Choose common, concrete words. Keep every English sentence you write short and simple. Reading questions should test literal understanding of the text. Translation prompts must be short everyday sentences.",
};

const LEVEL_GUIDE_ES: Record<Level, string> = {
	adult:
		"Learner: a Taiwanese adult learning Latin American Spanish (as spoken in Mexico) at roughly CEFR A2–B1. Prefer high-frequency, useful vocabulary, common expressions and verb forms. Use Mexican Spanish usage and vocabulary (tú/ustedes, never vosotros). When useful, mention the verb's infinitive and conjugation (person, tense) in explanations.",
	kid: "Learner: a Taiwanese primary-school child who is a beginner in Spanish (CEFR A1). Choose common, concrete words. Keep every Spanish sentence you write short and simple. Reading questions test literal understanding. Translation prompts must be short everyday sentences.",
};

const LEVEL_GUIDE_JA: Record<Level, string> = {
	adult:
		"Learner: a Taiwanese adult who is a COMPLETE BEGINNER in Japanese (aiming for JLPT N5, still learning kana). Choose very common, basic words. Keep every Japanese sentence YOU write short and simple, in polite です／ます form. Reading questions test literal understanding and must be in very simple Japanese. Translation prompts must be very short everyday sentences.",
	kid: "Learner: a Taiwanese primary-school child who is a COMPLETE BEGINNER in Japanese (still learning kana). Choose very common, concrete words. Keep every Japanese sentence YOU write very short and simple. Reading questions test literal understanding. Translation prompts must be very short everyday sentences.",
};

/** 固定的系統指示（放前面以利快取）。 */
export function systemPrompt(level: Level, lang: Lang = "en"): string {
	if (lang !== "en") return foreignSystemPrompt(level, lang);
	return `You are an experienced English teacher who writes practice questions for Taiwanese learners.
${LEVEL_GUIDE[level]}

All Chinese text MUST be Traditional Chinese as used in Taiwan (繁體中文，台灣用語). Never use Simplified Chinese or Mainland-specific terms.

Return ONLY a JSON object of this shape:
{"questions": [ ...question objects... ]}

Question object shapes:
1. Vocabulary (type "vocab"): a word or phrase that appears in the article.
   {"type":"vocab","direction":"en2zh","word":"<English word/phrase>","ipa":"<American IPA between slashes, e.g. /ˈɛspiəˌnɑʒ/>","context":"<the exact sentence from the article containing it>","contextZh":"<繁中翻譯 of the context sentence>","prompt":"<the English word/phrase>","options":["<4 Traditional Chinese meanings>"],"answer":<0-3>,"explanation":"<繁中：在此句中的意思、詞性、常見搭配或另一個例句>"}
   or with "direction":"zh2en": "prompt" is a Traditional Chinese meaning, "options" are 4 English words/phrases, and add "optionsZh":["<繁中 meaning of each English option, same order>"].
   Wrong options must be plausible but clearly wrong in this context.
2. Cloze (type "cloze"): take a sentence from the article and replace ONE word or short phrase with "____". The learner will TYPE the answer, so the blank must be a word or short phrase worth spelling that can be inferred from the sentence and article; never blank out names, numbers or dates. The 3 wrong options are still required (used as data).
   {"type":"cloze","prompt":"<sentence with ____>","promptZh":"<繁中翻譯 of the COMPLETE sentence with the answer filled in>","options":["<4 English candidates>"],"optionsZh":["<繁中 meaning of each option, same order>"],"answer":<0-3>,"explanation":"<繁中：為什麼這個答案正確，其他選項為什麼不對>"}
3. Reading comprehension (type "reading"):
   {"type":"reading","prompt":"<question in English>","promptZh":"<繁中翻譯 of the question>","options":["<4 English answers>"],"optionsZh":["<繁中翻譯 of each option, same order>"],"answer":<0-3>,"explanation":"<繁中：根據文章哪一段/哪一句>"}
4. Translation (type "translate"): a Traditional Chinese sentence for the learner to translate into English, reusing vocabulary or grammar from the article.
   {"type":"translate","prompt":"<繁中句子>","reference":"<a natural English translation>","explanation":"<繁中：關鍵字詞與文法重點>"}

Rules:
- Every multiple-choice question has exactly 4 distinct options and exactly one correct answer.
- Every article sentence may be used by AT MOST ONE question across ALL types. A vocab "context" sentence must not reappear as a cloze sentence, and a cloze must not blank out a word that is also a vocab question. Otherwise one question gives away another's answer.
- Translation prompts must be NEW sentences that reuse the article's vocabulary or grammar; do not simply translate a sentence from the article back.
- Vocabulary should be useful at the learner's level. Do not skip a word just because it looks common; its meaning or usage in this article may still be new.
- Base everything on the article; do not invent facts about it.
- Explanations are concise (1–3 sentences), written entirely in Traditional Chinese except for the English words being explained. Refer to the article as「文章」, never as "article".`;
}

/** 西班牙文、日文的出題指示（格式和英文相同，只多了讀音欄位）。 */
function foreignSystemPrompt(level: Level, lang: Lang): string {
	const T = LANG[lang].english;
	const W = lang === "ja" ? "Japanese" : "Spanish";
	const guide = lang === "ja" ? LEVEL_GUIDE_JA[level] : LEVEL_GUIDE_ES[level];
	const pron = lang === "ja" ? `"reading":"<hiragana reading of the word>","romaji":"<Hepburn romaji of the word, e.g. tenki>",` : "";
	const clozePron = lang === "ja" ? `"answerReading":"<hiragana reading of the answer>","answerRomaji":"<Hepburn romaji of the answer>",` : "";
	const jaNote =
		lang === "ja"
			? `
- Japanese in explanations: after any kanji word, add its hiragana reading in parentheses, e.g. 天気（てんき）.
- The learner may answer cloze questions in kanji, kana or romaji, so "answerReading" and "answerRomaji" are REQUIRED for every cloze.`
			: "";
	return `You are an experienced ${T} teacher who writes practice questions for Taiwanese learners.
${guide}

All Chinese text MUST be Traditional Chinese as used in Taiwan (繁體中文，台灣用語). Never use Simplified Chinese or Mainland-specific terms.

Return ONLY a JSON object of this shape:
{"questions": [ ...question objects... ]}

Question object shapes:
1. Vocabulary (type "vocab"): a word or phrase that appears in the article.
   {"type":"vocab","direction":"en2zh","word":"<${W} word/phrase>",${pron}"context":"<the exact sentence from the article containing it>","contextZh":"<繁中翻譯 of the context sentence>","prompt":"<the ${W} word/phrase>","options":["<4 Traditional Chinese meanings>"],"answer":<0-3>,"explanation":"<繁中：在此句中的意思、詞性、常見用法或另一個例句>"}
   or with "direction":"zh2en": "prompt" is a Traditional Chinese meaning, "options" are 4 ${W} words/phrases, and add "optionsZh":["<繁中 meaning of each ${W} option, same order>"].
   Wrong options must be plausible but clearly wrong in this context.
2. Cloze (type "cloze"): take a sentence from the article and replace ONE word or short phrase with "____". The learner will TYPE the answer, so the blank must be a word or short phrase worth learning that can be inferred from the sentence and article; never blank out names, numbers or dates. The 3 wrong options are still required (used as data).
   {"type":"cloze","prompt":"<sentence with ____>","promptZh":"<繁中翻譯 of the COMPLETE sentence with the answer filled in>","options":["<4 ${W} candidates>"],"optionsZh":["<繁中 meaning of each option, same order>"],"answer":<0-3>,${clozePron}"explanation":"<繁中：為什麼這個答案正確，其他選項為什麼不對>"}
3. Reading comprehension (type "reading"):
   {"type":"reading","prompt":"<question in ${lang === "ja" ? "very simple Japanese" : "simple Spanish"}>","promptZh":"<繁中翻譯 of the question>","options":["<4 ${W} answers>"],"optionsZh":["<繁中翻譯 of each option, same order>"],"answer":<0-3>,"explanation":"<繁中：根據文章哪一段/哪一句>"}
4. Translation (type "translate"): a Traditional Chinese sentence for the learner to translate into ${W}, reusing vocabulary or grammar from the article.
   {"type":"translate","prompt":"<繁中句子>","reference":"<a natural ${T} translation>","explanation":"<繁中：關鍵字詞與文法重點>"}

Rules:
- Every multiple-choice question has exactly 4 distinct options and exactly one correct answer.
- Every article sentence may be used by AT MOST ONE question across ALL types. A vocab "context" sentence must not reappear as a cloze sentence, and a cloze must not blank out a word that is also a vocab question.
- Translation prompts must be NEW sentences that reuse the article's vocabulary or grammar; do not simply translate a sentence from the article back.
- Base everything on the article; do not invent facts about it.
- Explanations are concise (1–3 sentences), written entirely in Traditional Chinese except for the ${W} words being explained. Refer to the article as「文章」.${jaNote}`;
}

export function userPrompt(article: string, plan: Plan, marked: string[] = []): string {
	const must = marked.length
		? `The learner marked these words/phrases as unknown: ${marked.map((m) => JSON.stringify(m)).join(", ")}.
EVERY marked item MUST be tested in a vocab question (use cloze only if vocab slots run out). Fill the remaining slots with other useful items.

`
		: "";
	return `${must}Write exactly ${plan.vocab} vocab, ${plan.cloze} cloze, ${plan.reading} reading and ${plan.translate} translate questions (${planTotal(plan)} total) for this article.

<article>
${article.trim()}
</article>`;
}

// ---------------------------------------------------------------------
// 驗證與正規化

function str(v: unknown): string {
	return typeof v === "string" ? v.trim() : "";
}

function shuffleChoice(q: ChoiceQ, rand: () => number): ChoiceQ {
	const idx = q.options.map((_, i) => i);
	for (let i = idx.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[idx[i], idx[j]] = [idx[j], idx[i]];
	}
	const out: ChoiceQ = { ...q, options: idx.map((i) => q.options[i]), answer: idx.indexOf(q.answer) };
	if (q.optionsZh) out.optionsZh = idx.map((i) => q.optionsZh![i]);
	return out;
}

/** 把句子轉成單字集合，用來判斷兩題是不是用了同一句。 */
function sentenceWords(s: string, lang: Lang = "en"): Set<string> {
	if (lang === "ja") return new Set(wordsOf(s, lang).filter((w) => w.length > 1));
	if (lang === "es") return new Set(wordsOf(s, lang).filter((w) => w.length > 2));
	return new Set((s.toLowerCase().match(/[a-z][a-z'’-]*/g) ?? []).filter((w) => w.length > 2));
}

function overlap(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	let n = 0;
	for (const w of a) if (b.has(w)) n++;
	return n / Math.min(a.size, b.size);
}

/**
 * 把克漏字的空格換成答案。用函式當替換值：答案裡有 $（例如 "$5"、"$&"）時，
 * 字串替換會把它當成特殊記號。
 */
export function fillBlank(prompt: string, answer: string): string {
	return prompt.replace("____", () => answer);
}

/** 去掉從網頁複製時夾帶的零寬字元。 */
export function cleanText(s: string): string {
	return s.replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "");
}

export interface ParseResult {
	questions: Question[];
	dropped: { reason: string; raw: unknown }[];
}

/** 解析 AI 回傳的 JSON，丟掉格式不對的題目，指派 UUID，並把選項洗牌（AI 常把答案放在固定位置）。 */
export function parseQuestions(text: string, rand: () => number = Math.random, lang: Lang = "en"): ParseResult {
	let data: unknown;
	const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	try {
		data = JSON.parse(cleaned);
	} catch {
		throw new Error("AI 回傳的不是有效的 JSON");
	}
	const arr = Array.isArray(data) ? data : (data as { questions?: unknown })?.questions;
	if (!Array.isArray(arr)) throw new Error("AI 回傳的 JSON 裡沒有 questions 陣列");

	const out: Question[] = [];
	const dropped: ParseResult["dropped"] = [];
	const seen = new Set<string>();
	const usedSentences: Set<string>[] = []; // 單字題的原句與克漏字句子
	const usedWords = new Set<string>(); // 已經考過的單字／克漏字答案
	const drop = (reason: string, raw: unknown) => dropped.push({ reason, raw });
	const sameSentence = (s: string) => {
		const w = sentenceWords(s, lang);
		return w.size >= 4 && usedSentences.some((u) => overlap(w, u) >= 0.7);
	};

	for (const raw of arr) {
		const r = (raw ?? {}) as Record<string, unknown>;
		const type = str(r.type) as QType;
		let prompt = str(r.prompt);
		const explanation = str(r.explanation);
		if (!prompt) {
			drop("沒有題目", raw);
			continue;
		}
		const key = `${type}|${prompt.toLowerCase()}`;
		if (seen.has(key)) {
			drop("重複", raw);
			continue;
		}

		if (type === "translate") {
			const reference = str(r.reference);
			if (!reference) {
				drop("翻譯題沒有參考答案", raw);
				continue;
			}
			out.push({ id: uuid(), type, prompt, reference, explanation });
			seen.add(key);
			continue;
		}

		if (type !== "vocab" && type !== "cloze" && type !== "reading") {
			drop(`未知題型 ${type}`, raw);
			continue;
		}
		const options = Array.isArray(r.options) ? r.options.map(str) : [];
		const answer = typeof r.answer === "number" ? r.answer : Number(r.answer);
		if (options.length !== 4 || options.some((o) => !o)) {
			drop("選項不是 4 個", raw);
			continue;
		}
		if (new Set(options.map((o) => o.toLowerCase())).size !== 4) {
			drop("選項重複", raw);
			continue;
		}
		if (!Number.isInteger(answer) || answer < 0 || answer > 3) {
			drop("答案 index 不正確", raw);
			continue;
		}
		if (type === "cloze") {
			if (!/_{2,}/.test(prompt)) {
				drop("克漏字沒有空格", raw);
				continue;
			}
			// 兩個字的答案 AI 有時寫成「____ ____」：相鄰的空格併成一個
			prompt = prompt.replace(/_{2,}(?:\s+_{2,})*/g, "____");
			if (prompt.split("____").length > 2) {
				drop("克漏字有兩個以上的空格", raw);
				continue;
			}
			if (sameSentence(prompt)) {
				drop("和其他題用同一句", raw);
				continue;
			}
			const ans = options[answer]?.toLowerCase();
			if (ans && usedWords.has(ans)) {
				drop("答案已在單字題考過", raw);
				continue;
			}
		}
		if (type === "vocab") {
			const ctx = str(r.context);
			const w = str(r.word).toLowerCase();
			if (ctx && sameSentence(ctx)) {
				drop("和其他題用同一句", raw);
				continue;
			}
			if (w && usedWords.has(w)) {
				drop("單字重複", raw);
				continue;
			}
		}
		const q: ChoiceQ = { id: uuid(), type, prompt, options, answer, explanation };
		const promptZh = str(r.promptZh);
		if (promptZh) q.promptZh = promptZh;
		const optionsZh = Array.isArray(r.optionsZh) ? r.optionsZh.map(str) : [];
		if (optionsZh.length === 4 && optionsZh.every(Boolean)) q.optionsZh = optionsZh;
		if (type === "vocab") {
			const word = str(r.word);
			const context = str(r.context);
			if (word) q.word = word;
			if (context) q.context = context;
			const contextZh = str(r.contextZh);
			if (contextZh) q.contextZh = contextZh;
			let ipa = str(r.ipa);
			if (ipa) {
				ipa = ipa.replace(/^[/[]|[/\]]$/g, "");
				q.ipa = `/${ipa}/`;
			}
			q.direction = str(r.direction) === "zh2en" ? "zh2en" : "en2zh";
			const reading = str(r.reading);
			const romaji = str(r.romaji);
			if (reading) q.reading = reading;
			if (romaji) q.romaji = romaji;
		}
		if (type === "cloze") {
			const ar = str(r.answerReading);
			const ro = str(r.answerRomaji);
			if (ar) q.answerReading = ar;
			if (ro) q.answerRomaji = ro;
		}
		out.push(shuffleChoice(q, rand));
		seen.add(key);
		if (type === "vocab") {
			if (q.context) usedSentences.push(sentenceWords(q.context, lang));
			if (q.word) usedWords.add(q.word.toLowerCase());
		} else if (type === "cloze") {
			usedSentences.push(sentenceWords(prompt, lang));
			usedWords.add(options[answer].toLowerCase());
		}
	}
	return { questions: out, dropped };
}

// ---------------------------------------------------------------------
// 題庫檔（Markdown：上半部給人看，最後的 JSON 區塊給程式讀）

export const BANK_JSON_START = "<!-- english-learning:bank -->";
const LETTERS = ["A", "B", "C", "D"];

function quoteLines(s: string): string {
	return s
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 可點擊朗讀的外語（點一下就唸；lang 讓朗讀用對的語言）。 */
let sayLang: Lang = "en";
function say(text: string, sentence = false): string {
	const attr = sayLang === "en" ? "" : ` lang="${sayLang}"`;
	return `<span class="el-say${sentence ? " el-sentence" : ""}"${attr}>${escapeHtml(text)}</span>`;
}

/** 單字題的讀音標示：英文 IPA；日文「よみ（romaji）」。 */
export function pronLabel(q: Pick<ChoiceQ, "ipa" | "reading" | "romaji">): string {
	if (q.reading || q.romaji) return [q.reading, q.romaji ? `（${q.romaji}）` : ""].filter(Boolean).join("");
	return q.ipa ?? "";
}

export function renderBank(bank: Bank, sourceLinkTarget: string): string {
	sayLang = langOf(bank.lang);
	const fm = [
		"---",
		`sourceId: ${bank.sourceId}`,
		`source: "[[${sourceLinkTarget}]]"`,
		`title: ${JSON.stringify(bank.title)}`,
		`level: ${bank.level}`,
		...(bank.lang && bank.lang !== "en" ? [`lang: ${bank.lang}`] : []),
		`count: ${bank.questions.length}`,
		`model: ${bank.model}`,
		`generatedAt: ${bank.generatedAt}`,
		`device: ${bank.device}`,
		"---",
	].join("\n");

	const langName = LANG[langOf(bank.lang)].name;
	const parts: string[] = [fm, "", `# 題庫：${bank.title}`, "", `${langName}　程度：${LEVEL_LABEL[bank.level]}　題數：${bank.questions.length}　來源：[[${sourceLinkTarget}|${bank.title}]]`, ""];
	const order: QType[] = ["vocab", "cloze", "reading", "translate"];
	let n = 0;
	for (const t of order) {
		const qs = bank.questions.filter((q) => q.type === t);
		if (!qs.length) continue;
		parts.push(`## ${TYPE_LABEL[t]}`, "");
		for (const q of qs) {
			n++;
			if (q.type === "translate") {
				parts.push(`**${n}.** 翻成${langName}：${q.prompt}`, "");
				parts.push("> [!success]- 參考答案", quoteLines(`${say(q.reference)}\n\n${q.explanation}`), "");
			} else {
				const star = q.marked ? "　⭐生字" : "";
				const zh2en = q.type === "vocab" && q.direction === "zh2en";
				let reveal = "";
				if (q.type === "vocab" && !zh2en) {
					parts.push(`**${n}.** ${say(q.prompt)}${pronLabel(q) ? `　${pronLabel(q)}` : ""}${star}`);
					if (q.context) parts.push(say(q.context, true));
				} else {
					parts.push(`**${n}.** ${q.prompt}${star}`);
					if (zh2en) reveal = `${q.word ? say(q.word) : ""}${pronLabel(q) ? `　${pronLabel(q)}` : ""}${q.context ? `\n\n${say(q.context, true)}` : ""}\n\n`;
				}
				parts.push("");
				q.options.forEach((o, i) => parts.push(`- ${LETTERS[i]}. ${o}`));
				parts.push("");
				const clozeRead = q.type === "cloze" && (q.answerReading || q.answerRomaji) ? `（${[q.answerReading, q.answerRomaji].filter(Boolean).join("，")}）` : "";
				const ans = q.type === "cloze" ? say(fillBlank(q.prompt, q.options[q.answer]), true) : `${LETTERS[q.answer]}. ${q.options[q.answer]}`;
				const zh = [q.contextZh, q.promptZh].filter(Boolean).map((z) => `（中）${z}`).join("\n");
				parts.push("> [!success]- 答案", quoteLines(`${q.type === "cloze" ? `${LETTERS[q.answer]}. ${q.options[q.answer]}${clozeRead}\n\n` : ""}${reveal}${ans}\n\n${zh ? `${zh}\n\n` : ""}${q.explanation}`), "");
			}
		}
	}
	parts.push("---", "", "以下是程式讀取用的資料，請勿修改。", "", BANK_JSON_START, "```json", JSON.stringify(bank, null, 1), "```", "");
	return parts.join("\n");
}

export function parseBank(md: string): Bank | null {
	const i = md.lastIndexOf(BANK_JSON_START);
	if (i < 0) return null;
	const m = md.slice(i).match(/```json\s*([\s\S]*?)```/);
	if (!m) return null;
	try {
		return JSON.parse(m[1]) as Bank;
	} catch {
		return null;
	}
}
