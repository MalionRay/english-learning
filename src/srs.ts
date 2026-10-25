// SRS：狀態不落檔，每次從所有裝置的答題 log 重算。
// 這個檔案不碰 Vault，方便單獨測試。
//
// 重算規則（同一份 log 在每台裝置都會算出一樣的結果）：
// - 先用 UUID 去重（同步可能讓同一筆出現兩次）
// - 依時間戳排序後依序重播；時間相同時用 UUID 排序，確保順序固定
// - 答對：往間隔階梯的下一格；答錯：回到第一格（隔天再出）
// - 同一場練習中答錯後的「重答」（relearn）不改變排程，只算練習
// - 作答前看了中文翻譯（hint）而答對：階梯不動，隔天再出
// - 翻譯題在批改前（pending）視為隔天到期；批改結果是另一筆 grade log，對應 answerId
import type { QType } from "./generate";

export const DAY = 24 * 3600 * 1000;
/** 到期時間提前 4 小時，讓「明天差不多同一時間」練習時一定會出現。 */
const EARLY = 4 * 3600 * 1000;

export const LADDER = [1, 3, 7, 14, 30, 60, 120, 240];
/** 使用者標記的生字：間隔拉長得比較慢。 */
export const MARKED_LADDER = [1, 2, 4, 7, 14, 30, 60, 120];

export interface AnswerLog {
	id: string;
	ts: string;
	device: string;
	user: string;
	type: "answer";
	qid: string;
	bank: string; // sourceId
	qtype: QType | "word" | "dictation" | "listening";
	session: string;
	correct?: boolean; // 選擇題；翻譯題批改後才有
	choice?: number;
	text?: string; // 翻譯題的作答
	score?: number; // 翻譯題分數（當場批改時）
	feedback?: string;
	corrected?: string;
	pending?: boolean; // 翻譯題尚未批改
	relearn?: boolean; // 同一場練習答錯後重答
	hint?: boolean; // 作答前看了中文翻譯：答對也只算練習，不升級
	dontKnow?: boolean; // 按了「我不知道」（視為答錯）
	marked?: boolean;
}

export interface GradeLog {
	id: string;
	ts: string;
	device: string;
	user: string;
	type: "grade";
	answerId: string;
	qid: string;
	score: number;
	correct: boolean;
	feedback?: string;
	corrected?: string;
}

export interface QState {
	qid: string;
	step: number; // 0 = 剛學／答錯；數字越大間隔越長
	due: number; // 到期時間（ms）
	seen: number;
	right: number;
	wrong: number;
	last: number;
	lastCorrect?: boolean;
	pending?: boolean;
}

export function intervalDays(step: number, marked: boolean): number {
	const l = marked ? MARKED_LADDER : LADDER;
	return l[Math.min(Math.max(step - 1, 0), l.length - 1)];
}

export function computeStates(entries: (AnswerLog | GradeLog)[], markedQids: Set<string> = new Set()): Map<string, QState> {
	const seen = new Set<string>();
	const answers: AnswerLog[] = [];
	const grades = new Map<string, GradeLog>();
	for (const e of entries) {
		if (!e?.id || seen.has(e.id)) continue;
		seen.add(e.id);
		if (e.type === "answer" && e.qid) answers.push(e);
		else if (e.type === "grade" && e.answerId) {
			const prev = grades.get(e.answerId);
			if (!prev || prev.ts < e.ts) grades.set(e.answerId, e);
		}
	}
	answers.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));

	const states = new Map<string, QState>();
	for (const a of answers) {
		const t = Date.parse(a.ts);
		if (!Number.isFinite(t)) continue;
		const st = states.get(a.qid) ?? { qid: a.qid, step: 0, due: 0, seen: 0, right: 0, wrong: 0, last: 0 };
		states.set(a.qid, st);
		st.seen++;
		st.last = t;

		const g = grades.get(a.id);
		const correct = a.correct ?? g?.correct;
		if (correct === undefined) {
			// 翻譯題還沒批改：明天再出，不動階梯
			st.pending = true;
			st.due = Math.max(st.due, t + DAY - EARLY);
			continue;
		}
		st.pending = false;
		if (correct) st.right++;
		else st.wrong++;
		if (a.relearn) continue; // 同場重答不改排程，也不覆蓋「上次排程時答對與否」
		st.lastCorrect = correct;
		if (correct && a.hint) {
			// 看了提示才答對：階梯不動，明天再確認一次
			st.due = t + DAY - EARLY;
			continue;
		}

		const marked = a.marked || markedQids.has(a.qid);
		if (correct) {
			st.step = Math.min(st.step + 1, LADDER.length);
			st.due = t + intervalDays(st.step, marked) * DAY - EARLY;
		} else {
			st.step = 0;
			st.due = t + DAY - EARLY;
		}
	}
	return states;
}

export interface PlannableQuestion {
	id: string;
	marked?: boolean;
}

/**
 * 選出這次要練的題目：到期的優先（最久沒練的先），不夠再補新題。
 * questions 的順序就是新題的出題順序。
 */
export function pickSession<Q extends PlannableQuestion>(
	questions: Q[],
	states: Map<string, QState>,
	limit: number,
	now = Date.now(),
): { due: Q[]; fresh: Q[]; dueTotal: number; freshTotal: number } {
	const due: { q: Q; st: QState }[] = [];
	const fresh: Q[] = [];
	for (const q of questions) {
		const st = states.get(q.id);
		if (!st) fresh.push(q);
		else if (st.due <= now) due.push({ q, st });
	}
	// 答錯的、標記的生字優先，再來是到期最久的
	due.sort((a, b) => {
		const wa = a.st.lastCorrect === false ? 0 : 1;
		const wb = b.st.lastCorrect === false ? 0 : 1;
		if (wa !== wb) return wa - wb;
		const ma = a.q.marked ? 0 : 1;
		const mb = b.q.marked ? 0 : 1;
		if (ma !== mb) return ma - mb;
		return a.st.due - b.st.due;
	});
	const pickedDue = due.slice(0, limit).map((x) => x.q);
	const pickedFresh = fresh.slice(0, Math.max(0, limit - pickedDue.length));
	return { due: pickedDue, fresh: pickedFresh, dueTotal: due.length, freshTotal: fresh.length };
}
