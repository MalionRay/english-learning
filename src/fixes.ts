// 修正題：使用者回報某題有問題時，請 AI 出一題同類型、考同一重點的替代題。
// 題庫檔是「新建不覆寫」，所以修正題另外 append 到 english/fixes/<deviceId>.jsonl（單一寫入者）。
// 只有在原題「目前被回報」時才用修正題取代；恢復原題後，修正題就不出現。
import { App } from "obsidian";
import type { AIBackend } from "./ai";
import { Bank, ChoiceQ, Question, parseQuestions, stripMarks, systemPrompt } from "./generate";
import { listRecursive, uuid } from "./logs";
import { stripFrontmatter } from "./sources";

export const FIX_DIR = "english/fixes";

export interface FixLog {
	id: string;
	ts: string;
	device: string;
	type: "fix";
	replaces: string; // 原題 qid
	bank: string;
	reason?: string;
	question: Question;
}

/** 原題 qid → 修正題（同一題有多個修正時取最新的；依時間戳＋UUID 排序，所有裝置結果一致）。 */
export async function loadFixes(app: App): Promise<Map<string, FixLog>> {
	const all: FixLog[] = [];
	for (const path of await listRecursive(app, FIX_DIR)) {
		if (!path.endsWith(".jsonl")) continue;
		for (const line of (await app.vault.adapter.read(path)).split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line);
				if (e?.type === "fix" && e.replaces && e.question?.id) all.push(e);
			} catch {
				/* 壞行略過 */
			}
		}
	}
	all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
	const out = new Map<string, FixLog>();
	for (const f of all) out.set(f.replaces, f);
	return out;
}

/**
 * 依回報與修正決定實際要出的題目：
 * 沒被回報 → 原題；被回報且有修正 → 修正題（修正題又被回報時繼續往下找）；被回報但沒有修正 → 不出。
 */
export function resolveQuestion(q: Question, flagged: Set<string>, fixes: Map<string, FixLog>): Question | null {
	let cur: Question = q;
	for (let i = 0; i < 10; i++) {
		if (!flagged.has(cur.id)) return cur;
		const f = fixes.get(cur.id);
		if (!f) return null;
		if (f.question.id === cur.id) return f.question; // 只修中文、保留 UUID 的修正
		cur = f.question;
	}
	return null;
}

function describe(q: Question): string {
	const { id: _id, ...rest } = q as Question & Record<string, unknown>;
	return JSON.stringify(rest);
}

export type FixKind = "wrongAnswer" | "ambiguous" | "unclear" | "translation" | "other";

/** 依回報原因（FLAG_REASONS 的順序）決定處理方式。 */
export function fixKind(reason: string): FixKind {
	if (reason.startsWith("答案標錯")) return "wrongAnswer";
	if (reason.startsWith("有兩個以上")) return "ambiguous";
	if (reason.startsWith("題目或選項看不懂")) return "unclear";
	if (reason.startsWith("翻譯或解釋有錯")) return "translation";
	return "other";
}

export type FixOutcome =
	| { kind: "replaced"; question: Question; sameId: boolean; message?: string }
	| { kind: "originalCorrect"; message: string };

function parseJson(text: string): Record<string, unknown> {
	try {
		return JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
	} catch {
		throw new Error("AI 回傳的不是有效的 JSON");
	}
}

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * 依原因處理被回報的題目：
 * - 答案標錯：重新判斷答案（題目、選項不變）；原答案其實正確時不改
 * - 兩個以上都對：保留正確答案，換掉也算對的錯誤選項
 * - 看不懂：用更清楚的英文重寫，考同一重點
 * - 翻譯或解釋有錯：只修中文與解釋，題目 UUID 不變（保留練習進度）
 * - 其他：依補充說明出一題替代題
 */
export async function makeFix(app: App, ai: AIBackend, bank: Bank, old: Question, reason: string): Promise<FixOutcome> {
	let article = "";
	const f = app.vault.getAbstractFileByPath(bank.sourcePath);
	if (f && "extension" in f) article = stripMarks(stripFrontmatter(await app.vault.cachedRead(f as never))).trim();
	const art = article ? `\n<article>\n${article}\n</article>` : "";
	const sys = systemPrompt(bank.level);
	let kind = fixKind(reason);
	if (old.type === "translate" && kind === "ambiguous") kind = "other"; // 翻譯題本來就接受多種答案

	// ---- 答案標錯 ----
	if (kind === "wrongAnswer") {
		if (old.type === "translate") {
			const j = parseJson(
				(
					await ai.complete(
						`The learner says the reference English translation of this question is wrong.
Chinese sentence: ${old.prompt}
Reference translation: ${old.reference}
Decide whether the reference is a correct, natural translation.
Return ONLY JSON {"verdict":"fixed"|"original_correct","reference":"<corrected reference, or the original if correct>","explanation":"<繁中：關鍵字詞與文法重點>","message":"<繁中 1-2 句：給學習者的說明>"}`,
						{ system: sys, json: true, maxOutputTokens: 1024, temperature: 0.2 },
					)
				).text,
			);
			if (s(j.verdict) === "original_correct") return { kind: "originalCorrect", message: s(j.message) || "AI 判斷原本的參考答案是正確的。" };
			const ref = s(j.reference);
			if (!ref) throw new Error("AI 沒有提供修正後的參考答案");
			return { kind: "replaced", sameId: false, message: s(j.message), question: { ...old, id: uuid(), reference: ref, explanation: s(j.explanation) || old.explanation } };
		}
		const cq = old as ChoiceQ;
		const j = parseJson(
			(
				await ai.complete(
					`The learner says the marked answer of this ${cq.type} question is wrong.
Question: ${cq.prompt}${cq.context ? `\nContext sentence: ${cq.context}` : ""}
Options (index: text): ${cq.options.map((o, i) => `${i}: ${o}`).join(" | ")}
Marked answer index: ${cq.answer}
Decide, based on the article, which option is actually correct.
Return ONLY JSON {"verdict":"fixed"|"original_correct","answer":<0-3>,"explanation":"<繁中：為什麼這個答案正確>","message":"<繁中 1-2 句：給學習者的說明>"}${art}`,
					{ system: sys, json: true, maxOutputTokens: 1024, temperature: 0.2 },
				)
			).text,
		);
		const ans = Number(j.answer);
		if (s(j.verdict) === "original_correct" || ans === cq.answer)
			return { kind: "originalCorrect", message: s(j.message) || "AI 判斷原本標示的答案是正確的。" };
		if (!Number.isInteger(ans) || ans < 0 || ans > 3) throw new Error("AI 回傳的答案編號不正確");
		return { kind: "replaced", sameId: false, message: s(j.message), question: { ...cq, id: uuid(), answer: ans, explanation: s(j.explanation) || cq.explanation } };
	}

	// ---- 翻譯或解釋有錯：題目不變、保留 UUID ----
	if (kind === "translation") {
		const fields =
			old.type === "translate"
				? `{"explanation":"<繁中>"}`
				: `{${old.type === "vocab" && old.context ? `"contextZh":"<繁中翻譯 of the context sentence>",` : ""}${old.type !== "vocab" ? `"promptZh":"<繁中翻譯 of the ${old.type === "cloze" ? "complete sentence with the answer filled in" : "question"}>",` : ""}${old.type !== "vocab" || old.direction === "zh2en" ? `"optionsZh":["<繁中 meaning of each option, SAME order>"],` : ""}"explanation":"<繁中>"}`;
		const j = parseJson(
			(
				await ai.complete(
					`The learner says the Chinese translation or explanation of this question is wrong: ${reason}
Question (JSON): ${describe(old)}
Rewrite ONLY the Chinese parts correctly in natural Taiwanese Traditional Chinese. Do not change the English or the answer.
Return ONLY JSON ${fields}`,
					{ system: sys, json: true, maxOutputTokens: 1500, temperature: 0.2 },
				)
			).text,
		);
		const q = { ...old } as Question & Record<string, unknown>;
		if (s(j.explanation)) q.explanation = s(j.explanation);
		if (q.type !== "translate") {
			const cq = q as ChoiceQ;
			if (s(j.contextZh)) cq.contextZh = s(j.contextZh);
			if (s(j.promptZh)) cq.promptZh = s(j.promptZh);
			if (Array.isArray(j.optionsZh) && j.optionsZh.length === 4 && j.optionsZh.every((x) => s(x))) cq.optionsZh = j.optionsZh.map(s);
		}
		return { kind: "replaced", sameId: true, question: q };
	}

	// ---- 兩個以上都對／看不懂／其他：出一題新題 ----
	const task =
		kind === "ambiguous"
			? `More than one option can be considered correct. Keep the same question and the same correct answer ("${(old as ChoiceQ).options?.[(old as ChoiceQ).answer] ?? ""}"), but replace the other options so that they are clearly wrong in this context.`
			: kind === "unclear"
				? "The learner could not understand the question or options. Rewrite it in clearer, simpler English that still tests the same word or point."
				: "Fix the reported problem. Test the same word or point if it is valid; otherwise pick another point from the article.";
	const prompt = `A learner reported a problem with this ${old.type} question.
Reported problem: ${reason}
Original question (JSON): ${describe(old)}

${task}
Write exactly ONE replacement question of type "${old.type}" following all the rules, including the Chinese fields.
Double-check that exactly one option is correct and the answer index points to it.
Return {"questions": [ <the one question> ]}.${art}`;
	const res = await ai.complete(prompt, { system: sys, json: true, maxOutputTokens: 2048, temperature: 0.4 });
	const parsed = parseQuestions(res.text);
	const q = parsed.questions.find((x) => x.type === old.type);
	if (!q) throw new Error(`AI 沒有產生可用的替代題${parsed.dropped[0] ? `（${parsed.dropped[0].reason}）` : ""}`);
	if (old.type !== "translate" && (old as ChoiceQ).marked && q.type !== "translate") (q as ChoiceQ).marked = true;
	return { kind: "replaced", sameId: false, question: q };
}
