// 生字本（每位使用者一本）。不另外存檔，每次從題庫與 log 推導：
//   - 文章中標記的生字（vocab 題 marked）
//   - 單字題、克漏字答錯過的字
//   - 使用者自己點選加入的字（log type "word-add"；移除是 "word-remove"）
// 生字複習的排程沿用 SRS：qid 為 "word:<key>"。
import type { Bank, ChoiceQ, Question } from "./generate";
import type { AnswerLog, GradeLog, QState } from "./srs";
import { lemmaMap } from "./lemma";

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
	lemma?: string; // AI 查到的原形（例如 went → go）
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
	forms: Set<string>; // 合併進來的其他形態（went、going…）
	baseFilled?: Set<string>; // 建立時暫用
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
	return buildWordBookWithAliases(banks, logs).words;
}

/**
 * 生字本，以及合併時的別名（舊 key → 合併後 key），
 * 讓以前用舊 key 記的複習紀錄（qid "word:went"）算到合併後的字（"word:go"）。
 */
export function buildWordBookWithAliases(banks: Bank[], logs: (AnswerLog | GradeLog | WordLog)[]): { words: WordItem[]; aliases: Map<string, string> } {
	const items = new Map<string, WordItem>();
	const qmap = new Map<string, { q: Question; bank: Bank }>();
	for (const b of banks) for (const q of b.questions) qmap.set(q.id, { q, bank: b });

	const seen = new Set<string>();
	const sorted = [...logs].filter((e) => e?.id && !seen.has(e.id) && seen.add(e.id)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
	const wrongWord = (e: AnswerLog | GradeLog | WordLog) => {
		if (e.type !== "answer" || e.correct !== false || e.relearn || (e.qtype !== "vocab" && e.qtype !== "cloze")) return null;
		const hit = qmap.get(e.qid);
		const w = hit && questionWord(hit.q);
		return w ? { w, bank: hit.bank } : null;
	};

	// 第一輪：收集所有字，決定哪些形態要合併
	const rawKeys = new Set<string>();
	const explicit = new Map<string, string>();
	for (const b of banks)
		for (const q of b.questions)
			if (q.type === "vocab" && (q as ChoiceQ).marked) {
				const w = questionWord(q);
				if (w) rawKeys.add(wordKey(w.word));
			}
	for (const e of sorted) {
		const ww = wrongWord(e);
		if (ww) rawKeys.add(wordKey(ww.w.word));
		else if (e.type === "word-add") {
			const k = wordKey(e.word);
			rawKeys.add(k);
			if (e.lemma) {
				const l = wordKey(e.lemma);
				if (l && l !== k) explicit.set(k, l);
			}
		}
	}
	rawKeys.delete("");
	const canon = lemmaMap(rawKeys, explicit);
	const keyOf = (word: string) => {
		const k = wordKey(word);
		return canon.get(k) ?? k;
	};

	const upsert = (word: string, bank: string | undefined, ts: string, reason: "marked" | "wrong" | "manual", extra: Partial<WordItem> = {}) => {
		const raw = wordKey(word);
		if (!raw) return null;
		const key = keyOf(word);
		const isBase = raw === key;
		let it = items.get(key);
		if (!it) {
			it = { key, word: isBase ? word.trim() : key, banks: new Set(), reasons: new Set(), wrong: 0, addedAt: ts, forms: new Set() };
			items.set(key, it);
		} else if (isBase && it.word === key) {
			it.word = word.trim(); // 保留原形原本的大小寫
		}
		if (!isBase) it.forms.add(word.trim());
		if (bank) it.banks.add(bank);
		it.reasons.add(reason);
		if (ts < it.addedAt) it.addedAt = ts;
		// 原形的資料優先；變化形只補空白欄位
		for (const k of ["meaning", "ipa", "context", "contextZh"] as const)
			if (extra[k] && (isBase || k !== "ipa") && (!it[k] || (isBase && !it.baseFilled?.has(k)))) {
				it[k] = extra[k] as string;
				if (isBase) (it.baseFilled ??= new Set()).add(k);
			}
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
	const removed = new Map<string, string>(); // key → 移除時間
	for (const e of sorted) {
		const ww = wrongWord(e);
		if (ww) {
			const it = upsert(ww.w.word, ww.bank.sourceId, e.ts, "wrong", ww.w);
			if (it) it.wrong++;
		} else if (e.type === "word-add") {
			upsert(e.word, e.bank, e.ts, "manual", { meaning: e.meaning, context: e.context });
			removed.delete(keyOf(e.word));
		} else if (e.type === "word-remove") {
			removed.set(keyOf(e.word), e.ts);
		}
	}
	// 移除之後如果又答錯或又加入，會重新出現
	for (const [key, ts] of removed) {
		const it = items.get(key);
		if (!it) continue;
		const later = sorted.some((e) => {
			if (e.ts <= ts) return false;
			if (e.type === "word-add") return keyOf(e.word) === key;
			const ww = wrongWord(e);
			return !!ww && keyOf(ww.w.word) === key;
		});
		if (!later) items.delete(key);
	}
	const aliases = new Map<string, string>();
	for (const [k, v] of canon) if (k !== v) aliases.set(k, v);
	for (const it of items.values()) delete it.baseFilled;
	return { words: [...items.values()].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1)), aliases };
}

/** 把舊 key 的生字複習紀錄改到合併後的 qid（不改檔案，只在計算時換）。 */
export function aliasWordQids<T extends { qid?: string }>(entries: T[], aliases: Map<string, string>): T[] {
	if (!aliases.size) return entries;
	return entries.map((e) => {
		if (!e.qid?.startsWith(WORD_PREFIX)) return e;
		const to = aliases.get(e.qid.slice(WORD_PREFIX.length));
		return to ? { ...e, qid: WORD_PREFIX + to } : e;
	});
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
