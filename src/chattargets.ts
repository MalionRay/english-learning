// 對話中的 SRS 複習：開始對話時挑出到期的生字與句子，請 AI 在聊天中自然用到，
// 並製造機會讓學習者使用。學習者在對話中用對了，就記一筆複習（answer log，via "chat"）。
// 這個檔案不碰 Vault，方便測試。
import type { PhraseItem } from "./chat";
import { phraseQid } from "./chat";
import type { QState } from "./srs";
import { IRREGULAR, suffixCandidates } from "./lemma";
import { WordItem, wordKey, wordQid } from "./words";
import { Lang, LANG, normWord, wordsOf } from "./lang";

export interface ChatTarget {
	n: number; // 給 AI 看的編號（1 起）
	kind: "word" | "phrase";
	qid: string;
	en: string; // 單字或英文句子
	zh?: string;
	forms: string[]; // 單字的其他形態（went、going…）
	wasWrong: boolean;
}

export const TARGET_WORDS = 5;
export const TARGET_PHRASES = 2;

function rank<T>(items: T[], qidOf: (x: T) => string, states: Map<string, QState>, now: number, max: number, newMax: number): T[] {
	const due: { x: T; st: QState }[] = [];
	const fresh: T[] = [];
	for (const x of items) {
		const st = states.get(qidOf(x));
		if (!st) fresh.push(x);
		else if (st.due <= now && !st.pending) due.push({ x, st });
	}
	// 上次答錯優先，其次是到期最久的
	due.sort((a, b) => Number(a.st.lastCorrect !== false) - Number(b.st.lastCorrect !== false) || a.st.due - b.st.due);
	const out = due.slice(0, max).map((d) => d.x);
	// 到期的不夠時，補幾個還沒複習過的（items 已經是新加入的在前）
	for (const x of fresh) {
		if (out.length >= max || newMax <= 0) break;
		out.push(x);
		newMax--;
	}
	return out;
}

/** 挑這次對話要複習的生字與句子。 */
export function pickTargets(words: WordItem[], phrases: PhraseItem[], states: Map<string, QState>, now = Date.now(), nWords = TARGET_WORDS, nPhrases = TARGET_PHRASES): ChatTarget[] {
	const ws = rank(words.filter((w) => !w.word.includes(" ") || w.word.split(" ").length <= 4), (w) => wordQid(w.key), states, now, nWords, 2);
	const ps = rank(phrases.filter((p) => p.en.split(/\s+/).length <= 20 && p.en.length <= 120), (p) => phraseQid(p.key), states, now, nPhrases, 1);
	const out: ChatTarget[] = [];
	for (const w of ws)
		out.push({ n: out.length + 1, kind: "word", qid: wordQid(w.key), en: w.word, zh: w.meaning, forms: [...w.forms], wasWrong: states.get(wordQid(w.key))?.lastCorrect === false });
	for (const p of ps)
		out.push({ n: out.length + 1, kind: "phrase", qid: phraseQid(p.key), en: p.en, zh: p.zh || undefined, forms: [], wasWrong: states.get(phraseQid(p.key))?.lastCorrect === false });
	return out;
}

/** 加在對話系統提示後面的複習說明。 */
export function targetsPrompt(targets: ChatTarget[], level: "adult" | "kid", lang: Lang = "en"): string {
	if (!targets.length) return "";
	const lines = targets.map((t) => `${t.n}. ${t.kind === "word" ? "word" : "sentence"}: ${t.en}${t.zh ? `  (${t.zh})` : ""}`);
	return `

Review targets — words and sentences this learner is studying and is due to review:
${lines.join("\n")}

How to use them:
- Over the conversation, naturally use these targets in YOUR replies (at most 1–2 per reply), in a context that makes the meaning clear${level === "kid" ? " and simple" : ""}.
- Steer the conversation (e.g. ask a question) so the learner has a natural chance to use them. For a sentence target, the learner can use the same idea in their own words.
- Never list the targets, never say they are review targets, and do not force several into one reply.
- Add "learnerUsed": [numbers] to your JSON — the targets the learner used CORRECTLY and with the right meaning in their LAST message (a word in any form counts${lang === "en" ? ", e.g. went for go" : lang === "es" ? ", e.g. fui for ir" : ", e.g. 行きました for 行く; kana or romaji spelling also counts"}). Use [] if none.${lang === "en" ? "" : ` All targets are ${LANG[lang].english}.`}`;
}

/** AI 回報的 learnerUsed（數字陣列）。 */
export function parseLearnerUsed(text: string): number[] {
	try {
		const j = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
		return Array.isArray(j.learnerUsed) ? j.learnerUsed.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [];
	} catch {
		return [];
	}
}

/** 一句話的字（小寫）。 */
export function tokens(text: string): string[] {
	return (text.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z][a-z'-]*/g) ?? []).map((t) => t.replace(/'s$/, ""));
}

/** 這個字（或它的變化形）有沒有出現在句子裡。片語要整段出現。 */
export function mentionsWord(text: string, t: Pick<ChatTarget, "en" | "forms">, lang: Lang = "en"): boolean {
	if (lang === "ja") {
		// 日文：直接找字（變化形靠 AI 判斷）
		const hay = normWord(text, "ja");
		return [t.en, ...t.forms].map((f) => normWord(f, "ja")).some((k) => k && hay.includes(k));
	}
	if (lang === "es") {
		const hay = ` ${wordsOf(text, "es").join(" ")} `;
		return [t.en, ...t.forms].map((f) => normWord(f, "es")).some((k) => k && hay.includes(` ${k} `));
	}
	const key = wordKey(t.en);
	if (!key) return false;
	if (key.includes(" ")) {
		const hay = ` ${tokens(text).join(" ")} `;
		return [key, ...t.forms.map((f) => wordKey(f))].some((k) => k && hay.includes(` ${k} `));
	}
	const forms = new Set([key, ...t.forms.map((f) => wordKey(f))]);
	return tokens(text).some((tok) => forms.has(tok) || IRREGULAR[tok] === key || suffixCandidates(tok).includes(key));
}

/**
 * 學習者這則訊息用對了哪些目標。
 * - 以 AI 的判斷（learnerUsed）為主；單字另外確認訊息裡真的有這個字（避免 AI 亂報）
 * - AI 沒報、但單字出現在訊息裡而且這則沒有被糾正，也算
 */
export function usedTargets(targets: ChatTarget[], learnerText: string, learnerUsed: number[], corrected: boolean, lang: Lang = "en"): ChatTarget[] {
	const said = new Set(learnerUsed);
	return targets.filter((t) => {
		// 日文的字可能用假名或羅馬拼音寫，找不到原字時以 AI 的判斷為準（但被糾正就不算）
		if (t.kind === "word" && lang === "ja") return said.has(t.n) || (mentionsWord(learnerText, t, lang) && !corrected);
		if (t.kind === "word") return mentionsWord(learnerText, t, lang) && (said.has(t.n) || !corrected);
		return said.has(t.n);
	});
}
