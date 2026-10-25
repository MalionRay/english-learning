// 生字本（每位使用者一本）。不另外存檔，每次從題庫與 log 推導：
//   - 文章中標記的生字（vocab 題 marked）
//   - 單字題、克漏字答錯過的字
//   - 使用者自己點選加入的字（log type "word-add"；移除是 "word-remove"）
// 生字複習的排程沿用 SRS：qid 為 "word:<key>"。
import type { Bank, ChoiceQ, Question } from "./generate";
import type { AnswerLog, GradeLog, QState } from "./srs";

export const WORD_PREFIX = "word:";

export interface WordLog {
	id: string;
	ts: string;
	device: string;
	user: string;
	type: "word-add" | "word-remove";
	word: string;
	meaning?: string;
	context?: string;
	bank?: string;
}

export interface WordItem {
	key: string;
	word: string;
	meaning?: string;
	ipa?: string;
	context?: string;
	contextZh?: string;
	banks: Set<string>;
	reasons: Set<"marked" | "wrong" | "manual">;
	wrong: number;
	addedAt: string;
}

export function wordKey(w: string): string {
	return w
		.toLowerCase()
		.replace(/[’‘]/g, "'")
		.replace(/[^a-z'\- ]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function wordQid(key: string): string {
	return WORD_PREFIX + key;
}

/** 題目對應的「字」：單字題的 word、克漏字的答案；其他題型沒有。 */
export function questionWord(q: Question): { word: string; meaning?: string; ipa?: string; context?: string; contextZh?: string } | null {
	if (q.type === "vocab") {
		const cq = q as ChoiceQ;
		const word = cq.word || (cq.direction !== "zh2en" ? cq.prompt : cq.options[cq.answer]);
		if (!word) return null;
		const meaning = cq.direction === "zh2en" ? cq.prompt : cq.options[cq.answer];
		return { word, meaning, ipa: cq.ipa, context: cq.context, contextZh: cq.contextZh };
	}
	if (q.type === "cloze") {
		const cq = q as ChoiceQ;
		const word = cq.options[cq.answer];
		return { word, meaning: cq.optionsZh?.[cq.answer], context: cq.prompt.replace("____", word), contextZh: cq.promptZh };
	}
	return null;
}

export function buildWordBook(banks: Bank[], logs: (AnswerLog | GradeLog | WordLog)[]): WordItem[] {
	const items = new Map<string, WordItem>();
	const qmap = new Map<string, { q: Question; bank: Bank }>();
	for (const b of banks) for (const q of b.questions) qmap.set(q.id, { q, bank: b });

	const upsert = (word: string, bank: string | undefined, ts: string, reason: "marked" | "wrong" | "manual", extra: Partial<WordItem> = {}) => {
		const key = wordKey(word);
		if (!key) return null;
		let it = items.get(key);
		if (!it) {
			it = { key, word: word.trim(), banks: new Set(), reasons: new Set(), wrong: 0, addedAt: ts };
			items.set(key, it);
		}
		if (bank) it.banks.add(bank);
		it.reasons.add(reason);
		if (ts < it.addedAt) it.addedAt = ts;
		for (const k of ["meaning", "ipa", "context", "contextZh"] as const) if (!it[k] && extra[k]) it[k] = extra[k] as string;
		return it;
	};

	// 1. 標記的生字
	for (const b of banks)
		for (const q of b.questions)
			if (q.type === "vocab" && (q as ChoiceQ).marked) {
				const w = questionWord(q);
				if (w) upsert(w.word, b.sourceId, b.generatedAt, "marked", w);
			}

	// 2. 答錯的字、3. 手動加入／移除（依時間重播）
	const seen = new Set<string>();
	const sorted = [...logs].filter((e) => e?.id && !seen.has(e.id) && seen.add(e.id)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
	const removed = new Map<string, string>(); // key → 移除時間
	for (const e of sorted) {
		if (e.type === "answer" && e.correct === false && !e.relearn && (e.qtype === "vocab" || e.qtype === "cloze")) {
			const hit = qmap.get(e.qid);
			const w = hit && questionWord(hit.q);
			if (w) {
				const it = upsert(w.word, hit.bank.sourceId, e.ts, "wrong", w);
				if (it) it.wrong++;
			}
		} else if (e.type === "word-add") {
			upsert(e.word, e.bank, e.ts, "manual", { meaning: e.meaning, context: e.context });
			removed.delete(wordKey(e.word));
		} else if (e.type === "word-remove") {
			removed.set(wordKey(e.word), e.ts);
		}
	}
	// 移除之後如果又答錯或又加入，會重新出現
	for (const [key, ts] of removed) {
		const it = items.get(key);
		if (!it) continue;
		const later = sorted.some(
			(e) =>
				e.ts > ts &&
				((e.type === "word-add" && wordKey(e.word) === key) ||
					(e.type === "answer" && e.correct === false && (() => {
						const hit = qmap.get(e.qid);
						const w = hit && questionWord(hit.q);
						return !!w && wordKey(w.word) === key;
					})())),
		);
		if (!later) items.delete(key);
	}
	return [...items.values()].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
}

// ---------------------------------------------------------------------
// 統計

export interface Stats {
	today: number;
	streak: number;
	days: { date: string; count: number }[]; // 最近 30 天
	byType: Record<string, { total: number; right: number }>; // 最近 30 天
	mastered: number; // 間隔已到 7 天以上的題目
	learning: number;
	dueTomorrow: number;
}

function localDate(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function computeStats(logs: (AnswerLog | GradeLog)[], states: Map<string, QState>, now = Date.now()): Stats {
	const seen = new Set<string>();
	const answers = logs.filter((e): e is AnswerLog => e.type === "answer" && !!e.id && !seen.has(e.id) && !!seen.add(e.id));
	const perDay = new Map<string, number>();
	const byType: Stats["byType"] = {};
	const since = now - 30 * 864e5;
	for (const a of answers) {
		const t = Date.parse(a.ts);
		if (!Number.isFinite(t)) continue;
		const d = localDate(t);
		perDay.set(d, (perDay.get(d) ?? 0) + 1);
		if (t >= since && a.correct !== undefined && !a.relearn) {
			const k = a.qtype;
			byType[k] ??= { total: 0, right: 0 };
			byType[k].total++;
			if (a.correct) byType[k].right++;
		}
	}
	const days: Stats["days"] = [];
	for (let i = 29; i >= 0; i--) {
		const d = localDate(now - i * 864e5);
		days.push({ date: d, count: perDay.get(d) ?? 0 });
	}
	// 連續天數：今天還沒練不算中斷，從昨天往回數
	let streak = 0;
	for (let i = perDay.has(localDate(now)) ? 0 : 1; ; i++) {
		if (perDay.has(localDate(now - i * 864e5))) streak++;
		else break;
	}
	let mastered = 0,
		learning = 0,
		dueTomorrow = 0;
	for (const st of states.values()) {
		if (st.step >= 3) mastered++;
		else learning++;
		if (st.due <= now + 864e5) dueTomorrow++;
	}
	return { today: perDay.get(localDate(now)) ?? 0, streak, days, byType, mastered, learning, dueTomorrow };
}
