// 錯誤模式分析：把最近的錯誤（對話中的修正、翻譯／句子題批改、克漏字打錯）交給 AI，
// 找出反覆出現的問題，產生報告與練習句（可加入句子本）。
// 純函式（收集、提示詞、解析、報告）不碰 Vault，方便測試；loadConversationErrors 讀對話檔。
import { App, TFile, normalizePath } from "obsidian";
import type { AIBackend } from "./ai";
import type { Bank, ChoiceQ, Level, Question, TranslateQ } from "./generate";
import { CONV_DIR, parseConvMessages, parseReply } from "./chat";
import type { AnswerLog, GradeLog } from "./srs";
import { safeName } from "./logs";

export const REPORT_DIR = "english/reports";

export interface ErrorItem {
	kind: "chat" | "translate" | "phrase" | "cloze";
	ts: string;
	prompt?: string; // 中文題目或克漏字句子
	wrong: string; // 學習者寫的
	right: string; // 正確／修正後
	note?: string; // 批改說明
}

export interface Drill {
	zh: string;
	en: string;
	note?: string;
}

export interface Pattern {
	title: string;
	explanation: string;
	examples: { wrong: string; right: string }[];
	tip: string;
	drills: Drill[];
}

export interface PatternReport {
	summary: string;
	patterns: Pattern[];
	count: number; // 分析了幾筆錯誤
	from: string;
	to: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']+/g, " ").trim();

/** 從答題 log 收集錯誤（翻譯、句子、克漏字）。 */
export function collectAnswerErrors(logs: (AnswerLog | GradeLog | { type: string; id: string; ts: string })[], banks: Bank[], sinceMs: number): ErrorItem[] {
	const qmap = new Map<string, Question>();
	for (const b of banks) for (const q of b.questions) qmap.set(q.id, q);
	const seen = new Set<string>();
	const uniq = logs.filter((e) => e.id && !seen.has(e.id) && !!seen.add(e.id));
	const grades = new Map<string, GradeLog>();
	for (const e of uniq) if (e.type === "grade") grades.set((e as GradeLog).answerId, e as GradeLog);
	const out: ErrorItem[] = [];
	for (const e of uniq) {
		if (e.type !== "answer") continue;
		const a = e as AnswerLog;
		if (Date.parse(a.ts) < sinceMs || a.dontKnow || !a.text?.trim()) continue;
		if (a.qtype === "translate" || a.qtype === "phrase") {
			const g = grades.get(a.id);
			const score = g?.score ?? a.score;
			const corrected = (g?.corrected ?? a.corrected ?? "").trim();
			if (score === undefined || score >= 90 || !corrected || norm(corrected) === norm(a.text)) continue;
			const q = qmap.get(a.qid) as TranslateQ | undefined;
			out.push({ kind: a.qtype, ts: a.ts, prompt: q?.prompt, wrong: a.text.trim(), right: corrected, note: g?.feedback ?? a.feedback });
		} else if (a.qtype === "cloze" && a.correct === false) {
			const q = qmap.get(a.qid) as ChoiceQ | undefined;
			if (!q) continue;
			out.push({ kind: "cloze", ts: a.ts, prompt: q.prompt, wrong: a.text.trim(), right: q.options[q.answer] });
		}
	}
	return out;
}

/** 從對話訊息收集 AI 的修正。 */
export function collectChatErrors(messages: { role: string; text: string; ts: string }[], sinceMs: number): ErrorItem[] {
	const out: ErrorItem[] = [];
	for (const m of messages) {
		if (m.role !== "model" || Date.parse(m.ts) < sinceMs) continue;
		const c = parseReply(m.text).correction;
		if (c) out.push({ kind: "chat", ts: m.ts, wrong: c.original, right: c.corrected, note: c.explanation });
	}
	return out;
}

/** 讀這位使用者的對話檔。 */
export async function loadConversationErrors(app: App, user: string, sinceMs: number): Promise<ErrorItem[]> {
	const out: ErrorItem[] = [];
	for (const f of app.vault.getMarkdownFiles()) {
		if (!f.path.startsWith(CONV_DIR + "/")) continue;
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (fm && fm.user !== undefined && String(fm.user) !== user) continue;
		const text = await app.vault.cachedRead(f);
		if (!fm && !new RegExp(`^user: ${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(text)) continue;
		out.push(...collectChatErrors(parseConvMessages(text), sinceMs));
	}
	return out;
}

/** 最近的錯誤優先，最多 max 筆；同一句只留一次。 */
export function pickErrors(items: ErrorItem[], max = 80): ErrorItem[] {
	const seen = new Set<string>();
	return [...items]
		.sort((a, b) => (a.ts < b.ts ? 1 : -1))
		.filter((e) => {
			const k = norm(e.wrong) + "|" + norm(e.right);
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		})
		.slice(0, max);
}

export const MIN_ERRORS = 5;

function system(level: Level): string {
	return `You are an experienced English teacher for Taiwanese learners (${level === "kid" ? "a primary-school child, CEFR A1–A2" : "an adult, CEFR B1–B2"}).
You receive a list of the learner's recent mistakes (what they wrote → the correct version). Find the RECURRING patterns — the same kind of mistake appearing more than once (e.g. verb tense, articles, prepositions, word order, singular/plural, Chinese-influenced phrasing, spelling of certain endings). Ignore one-off slips and capitalization/punctuation.

Return ONLY JSON:
{
 "summary": "<繁體中文（台灣用語）2–3 句：整體觀察與最值得先改的一點>",
 "patterns": [
  {
   "title": "<繁中短標題，例如「過去式忘了變化」>",
   "explanation": "<繁中 1–3 句：規則是什麼、為什麼會錯（可提中文母語的影響）>",
   "examples": [{"wrong": "<copied from the list>", "right": "<copied from the list>"}],
   "tip": "<繁中一句：下次寫的時候可以怎麼檢查>",
   "drills": [{"zh": "<繁中句子>", "en": "<natural English answer that uses the rule>", "note": "<繁中：重點提示>"}]
  }
 ]
}
Rules: 1–5 patterns, most frequent first; 1–3 examples each taken from the list; exactly 3 NEW drill sentences per pattern (not copied from the list), short and ${level === "kid" ? "very simple" : "everyday"}. All Chinese must be Traditional Chinese as used in Taiwan.`;
}

export function patternPrompt(items: ErrorItem[]): string {
	const label: Record<ErrorItem["kind"], string> = { chat: "conversation", translate: "translation", phrase: "translation", cloze: "fill-in spelling" };
	return items
		.map((e, i) => `${i + 1}. [${label[e.kind]}] ${e.prompt ? `(${e.prompt}) ` : ""}${e.wrong} → ${e.right}${e.note ? `  // ${e.note}` : ""}`)
		.join("\n");
}

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function parsePatterns(text: string): { summary: string; patterns: Pattern[] } {
	let j: Record<string, unknown>;
	try {
		j = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
	} catch {
		throw new Error("分析結果不是有效的 JSON");
	}
	const patterns = (Array.isArray(j.patterns) ? j.patterns : [])
		.map((p: Record<string, unknown>) => ({
			title: s(p?.title),
			explanation: s(p?.explanation),
			tip: s(p?.tip),
			examples: (Array.isArray(p?.examples) ? p.examples : [])
				.map((x: Record<string, unknown>) => ({ wrong: s(x?.wrong), right: s(x?.right) }))
				.filter((x) => x.wrong && x.right),
			drills: (Array.isArray(p?.drills) ? p.drills : [])
				.map((x: Record<string, unknown>) => ({ zh: s(x?.zh), en: s(x?.en), note: s(x?.note) || undefined }))
				.filter((x) => x.zh && x.en),
		}))
		.filter((p) => p.title);
	return { summary: s(j.summary), patterns };
}

export async function analyzePatterns(ai: AIBackend, items: ErrorItem[], level: Level): Promise<PatternReport> {
	const res = await ai.complete(patternPrompt(items), { system: system(level), json: true, maxOutputTokens: 4096, temperature: 0.3 });
	const r = parsePatterns(res.text);
	const ts = items.map((e) => e.ts).sort();
	return { ...r, count: items.length, from: ts[0] ?? "", to: ts[ts.length - 1] ?? "" };
}

export function reportMarkdown(r: PatternReport, user: string, generatedAt: string): string {
	const day = (t: string) => t.slice(0, 10);
	const lines = [
		"---",
		`user: ${user}`,
		`generated: ${generatedAt}`,
		`errors: ${r.count}`,
		"---",
		"",
		`# 常見錯誤分析（${day(generatedAt)}）`,
		"",
		`分析了 ${r.count} 筆錯誤（${day(r.from)} ～ ${day(r.to)}）。`,
		"",
		r.summary,
		"",
	];
	r.patterns.forEach((p, i) => {
		lines.push(`## ${i + 1}. ${p.title}`, "", p.explanation, "");
		for (const x of p.examples) lines.push(`- ~~${x.wrong}~~ → **${x.right}**`);
		if (p.examples.length) lines.push("");
		if (p.tip) lines.push(`> [!tip] ${p.tip}`, "");
		if (p.drills.length) {
			lines.push("練習句：", "");
			for (const d of p.drills) lines.push(`- ${d.zh} → ${d.en}${d.note ? `（${d.note}）` : ""}`);
			lines.push("");
		}
	});
	return lines.join("\n");
}

/** 報告存在 english/reports/<user>/<日期時間>-<deviceId>.md（單一寫入者）。 */
export async function saveReport(app: App, user: string, deviceId: string, md: string, now = new Date()): Promise<TFile> {
	const p = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
	const dir = normalizePath(`${REPORT_DIR}/${safeName(user)}`);
	for (const d of [REPORT_DIR, dir]) if (!(await app.vault.adapter.exists(d))) await app.vault.createFolder(d).catch(() => undefined);
	let path = normalizePath(`${dir}/${stamp}-${deviceId}.md`);
	for (let n = 2; app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${dir}/${stamp}-${deviceId}-${n}.md`);
	return app.vault.create(path, md);
}
