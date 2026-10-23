// AI 出題：提示詞、題目格式驗證、選項洗牌、題庫檔輸出。
// 這個檔案不碰 Vault，方便單獨測試。
import { uuid } from "./logs";

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
	word?: string; // 單字題：英文單字（之後進單字庫）
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
	model: string;
	generatedAt: string;
	device: string;
	questions: Question[];
}

export type Plan = Record<QType, number>;

export function wordCount(text: string): number {
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

export function planTotal(p: Plan): number {
	return p.vocab + p.cloze + p.reading + p.translate;
}

const LEVEL_GUIDE: Record<Level, string> = {
	adult:
		"Learner: a Taiwanese adult at roughly CEFR B1–B2 aiming for C1. Prefer useful, high-value vocabulary, collocations, phrasal verbs and idioms from the article over trivial words. Reading questions may test inference and the author's intent.",
	kid:
		"Learner: a Taiwanese primary-school child at roughly CEFR A1–A2. Choose common, concrete words. Keep every English sentence you write short and simple. Reading questions should test literal understanding of the text. Translation prompts must be short everyday sentences.",
};

/** 固定的系統指示（放前面以利快取）。 */
export function systemPrompt(level: Level): string {
	return `You are an experienced English teacher who writes practice questions for Taiwanese learners.
${LEVEL_GUIDE[level]}

All Chinese text MUST be Traditional Chinese as used in Taiwan (繁體中文，台灣用語). Never use Simplified Chinese or Mainland-specific terms.

Return ONLY a JSON object of this shape:
{"questions": [ ...question objects... ]}

Question object shapes:
1. Vocabulary (type "vocab"): a word or phrase that appears in the article.
   {"type":"vocab","direction":"en2zh","word":"<English word/phrase>","context":"<the exact sentence from the article containing it>","prompt":"<the English word/phrase>","options":["<4 Traditional Chinese meanings>"],"answer":<0-3>,"explanation":"<繁中：在此句中的意思、詞性、常見搭配或另一個例句>"}
   or with "direction":"zh2en": "prompt" is a Traditional Chinese meaning and "options" are 4 English words/phrases.
   Wrong options must be plausible but clearly wrong in this context.
2. Cloze (type "cloze"): take a sentence from the article and replace ONE word or short phrase with "____".
   {"type":"cloze","prompt":"<sentence with ____>","options":["<4 English candidates>"],"answer":<0-3>,"explanation":"<繁中：為什麼這個答案正確，其他選項為什麼不對>"}
3. Reading comprehension (type "reading"):
   {"type":"reading","prompt":"<question in English>","options":["<4 English answers>"],"answer":<0-3>,"explanation":"<繁中：根據文章哪一段/哪一句>"}
4. Translation (type "translate"): a Traditional Chinese sentence for the learner to translate into English, reusing vocabulary or grammar from the article.
   {"type":"translate","prompt":"<繁中句子>","reference":"<a natural English translation>","explanation":"<繁中：關鍵字詞與文法重點>"}

Rules:
- Every multiple-choice question has exactly 4 distinct options and exactly one correct answer.
- Every article sentence may be used by AT MOST ONE question across ALL types. A vocab "context" sentence must not reappear as a cloze sentence, and a cloze must not blank out a word that is also a vocab question. Otherwise one question gives away another's answer.
- Translation prompts must be NEW sentences that reuse the article's vocabulary or grammar; do not simply translate a sentence from the article back.
- Vocabulary items must be worth learning at the learner's level; skip words the learner surely already knows.
- Base everything on the article; do not invent facts about it.
- Explanations are concise (1–3 sentences), written entirely in Traditional Chinese except for the English words being explained. Refer to the article as「文章」, never as "article".`;
}

export function userPrompt(article: string, plan: Plan): string {
	return `Write exactly ${plan.vocab} vocab, ${plan.cloze} cloze, ${plan.reading} reading and ${plan.translate} translate questions (${planTotal(plan)} total) for this article.

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
	return { ...q, options: idx.map((i) => q.options[i]), answer: idx.indexOf(q.answer) };
}

/** 把句子轉成單字集合，用來判斷兩題是不是用了同一句。 */
function sentenceWords(s: string): Set<string> {
	return new Set((s.toLowerCase().match(/[a-z][a-z'’-]*/g) ?? []).filter((w) => w.length > 2));
}

function overlap(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	let n = 0;
	for (const w of a) if (b.has(w)) n++;
	return n / Math.min(a.size, b.size);
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
export function parseQuestions(text: string, rand: () => number = Math.random): ParseResult {
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
		const w = sentenceWords(s);
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
			prompt = prompt.replace(/_{2,}/g, "____");
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
		if (type === "vocab") {
			const word = str(r.word);
			const context = str(r.context);
			if (word) q.word = word;
			if (context) q.context = context;
			q.direction = str(r.direction) === "zh2en" ? "zh2en" : "en2zh";
		}
		out.push(shuffleChoice(q, rand));
		seen.add(key);
		if (type === "vocab") {
			if (q.context) usedSentences.push(sentenceWords(q.context));
			if (q.word) usedWords.add(q.word.toLowerCase());
		} else if (type === "cloze") {
			usedSentences.push(sentenceWords(prompt));
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

export function renderBank(bank: Bank, sourceLinkTarget: string): string {
	const fm = [
		"---",
		`sourceId: ${bank.sourceId}`,
		`source: "[[${sourceLinkTarget}]]"`,
		`title: ${JSON.stringify(bank.title)}`,
		`level: ${bank.level}`,
		`count: ${bank.questions.length}`,
		`model: ${bank.model}`,
		`generatedAt: ${bank.generatedAt}`,
		`device: ${bank.device}`,
		"---",
	].join("\n");

	const parts: string[] = [fm, "", `# 題庫：${bank.title}`, "", `程度：${LEVEL_LABEL[bank.level]}　題數：${bank.questions.length}　來源：[[${sourceLinkTarget}|${bank.title}]]`, ""];
	const order: QType[] = ["vocab", "cloze", "reading", "translate"];
	let n = 0;
	for (const t of order) {
		const qs = bank.questions.filter((q) => q.type === t);
		if (!qs.length) continue;
		parts.push(`## ${TYPE_LABEL[t]}`, "");
		for (const q of qs) {
			n++;
			if (q.type === "translate") {
				parts.push(`**${n}.** 翻成英文：${q.prompt}`, "");
				parts.push("> [!success]- 參考答案", quoteLines(`${q.reference}\n\n${q.explanation}`), "");
			} else {
				parts.push(`**${n}.** ${q.prompt}`);
				if (q.context) parts.push(`*${q.context}*`);
				parts.push("");
				q.options.forEach((o, i) => parts.push(`- ${LETTERS[i]}. ${o}`));
				parts.push("");
				parts.push("> [!success]- 答案", quoteLines(`${LETTERS[q.answer]}. ${q.options[q.answer]}\n\n${q.explanation}`), "");
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
