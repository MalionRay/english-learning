// 修正題：使用者回報某題有問題時，請 AI 出一題同類型、考同一重點的替代題。
// 題庫檔是「新建不覆寫」，所以修正題另外 append 到 english/fixes/<deviceId>.jsonl（單一寫入者）。
// 只有在原題「目前被回報」時才用修正題取代；恢復原題後，修正題就不出現。
import { App } from "obsidian";
import type { AIBackend } from "./ai";
import { Bank, ChoiceQ, Question, parseQuestions, stripMarks, systemPrompt } from "./generate";
import { listRecursive } from "./logs";
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

/** 原題 qid → 修正題（同一題有多個修正時取最早的，所有裝置結果一致）。 */
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
	for (const f of all) if (!out.has(f.replaces)) out.set(f.replaces, f);
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
		cur = f.question;
	}
	return null;
}

function describe(q: Question): string {
	const { id: _id, ...rest } = q as Question & Record<string, unknown>;
	return JSON.stringify(rest);
}

/** 請 AI 出一題替代題。回傳已驗證、指派新 UUID 的題目。 */
export async function makeFix(app: App, ai: AIBackend, bank: Bank, old: Question, reason: string): Promise<Question> {
	let article = "";
	const f = app.vault.getAbstractFileByPath(bank.sourcePath);
	if (f && "extension" in f) article = stripMarks(stripFrontmatter(await app.vault.cachedRead(f as never))).trim();

	const prompt = `A learner reported a problem with this ${old.type} question.
Reported problem: ${reason}
Original question (JSON): ${describe(old)}

Write exactly ONE replacement question of type "${old.type}" that fixes the problem.
Test the same word or point if it is valid; otherwise pick another point from the article.
Double-check that exactly one option is correct and the answer index points to it.
Return {"questions": [ <the one question> ]}.
${article ? `\n<article>\n${article}\n</article>` : ""}`;

	const res = await ai.complete(prompt, { system: systemPrompt(bank.level), json: true, maxOutputTokens: 2048, temperature: 0.4 });
	const parsed = parseQuestions(res.text);
	const q = parsed.questions.find((x) => x.type === old.type);
	if (!q) throw new Error(`AI 沒有產生可用的替代題${parsed.dropped[0] ? `（${parsed.dropped[0].reason}）` : ""}`);
	if (old.type !== "translate" && (old as ChoiceQ).marked && q.type !== "translate") (q as ChoiceQ).marked = true;
	return q;
}
