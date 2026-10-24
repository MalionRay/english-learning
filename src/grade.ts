// 翻譯題批改（AI）。只負責提示詞與解析，不碰 Vault。
import type { AIBackend } from "./ai";
import type { Level, TranslateQ } from "./generate";

export interface GradeResult {
	score: number; // 0-100
	correct: boolean; // score >= PASS
	feedback: string; // 繁中
	corrected: string; // 依學習者原句最小幅度修改後的英文
}

export const PASS = 70;

function system(level: Level): string {
	return `You are an English teacher grading a Taiwanese learner's Chinese-to-English translation.
Learner level: ${level === "kid" ? "primary-school child (CEFR A1–A2); be encouraging and lenient on small slips such as articles or punctuation" : "adult (CEFR B1–B2)"}.

Grade on: 1) meaning is fully and correctly conveyed (most important), 2) grammar, 3) natural word choice.
Any natural, correct translation deserves full marks even if it differs from the reference.
Ignore capitalization and final punctuation.

Return ONLY JSON:
{"score": <integer 0-100>, "feedback": "<繁體中文（台灣用語），1–3 句：哪裡做得好、哪裡錯、怎麼改>", "corrected": "<the learner's sentence with the minimum edits needed to be correct and natural; if already correct, repeat it unchanged>"}`;
}

export async function gradeTranslation(ai: AIBackend, q: TranslateQ, answer: string, level: Level): Promise<GradeResult> {
	const prompt = `Chinese sentence: ${q.prompt}
Reference translation: ${q.reference}
Learner's translation: ${answer.trim()}`;
	const res = await ai.complete(prompt, { system: system(level), json: true, maxOutputTokens: 512, temperature: 0.2 });
	let j: { score?: unknown; feedback?: unknown; corrected?: unknown };
	try {
		j = JSON.parse(res.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
	} catch {
		throw new Error("批改結果不是有效的 JSON");
	}
	const score = Math.max(0, Math.min(100, Math.round(Number(j.score))));
	if (!Number.isFinite(score)) throw new Error("批改結果沒有分數");
	return {
		score,
		correct: score >= PASS,
		feedback: typeof j.feedback === "string" ? j.feedback.trim() : "",
		corrected: typeof j.corrected === "string" ? j.corrected.trim() : "",
	};
}
