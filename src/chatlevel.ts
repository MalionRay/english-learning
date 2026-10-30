// 對話自適應程度：依學習者最近的訊息（被糾正多少、用了多少中文、句子多長）估一個 1～5 的程度，
// 每次呼叫 AI 時把對應的說話方式加進系統提示。答得亂 → 句子變短變簡單；越來越少錯 → 越來越像自然對話。
// 自然 ≠ 困難：最高級也只是「朋友間正常聊天」，不刻意用難字難句。
// 這個檔案不碰 Vault，方便測試。
import type { Level } from "./generate";
import { ConvMessage, parseReply } from "./chat";

export type ChatLevel = 1 | 2 | 3 | 4 | 5;

export const LEVEL_LABEL: Record<ChatLevel, string> = {
	1: "很簡單",
	2: "簡單",
	3: "日常",
	4: "自然",
	5: "道地",
};

/** 沒有紀錄時的起點。 */
export function defaultChatLevel(level: Level): ChatLevel {
	return level === "kid" ? 2 : 3;
}

/** 小孩最高到 4（自然但仍是小孩的用語）。 */
export function maxChatLevel(level: Level): ChatLevel {
	return level === "kid" ? 4 : 5;
}

function words(text: string): string[] {
	return text.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z][a-z'-]*/g) ?? [];
}

/** 中文字數。 */
function cjkCount(text: string): number {
	return (text.match(/[㐀-鿿]/g) ?? []).length;
}

/** 兩句英文差多少（以字為單位的編輯距離 ÷ 較長那句的字數，0～1）。 */
export function editRatio(a: string, b: string): number {
	const x = words(a);
	const y = words(b);
	const n = Math.max(x.length, y.length);
	if (!n) return 0;
	let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
	for (let i = 1; i <= x.length; i++) {
		const cur = [i];
		for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
		prev = cur;
	}
	return Math.min(1, prev[y.length] / n);
}

/**
 * 一則學習者訊息的表現（0～1）。
 * - 全中文（問怎麼說）：0.15
 * - 被糾正：依改動多寡，小錯 0.75、整句重寫 0.1
 * - 英文夾中文：最多 0.5
 * - 沒錯：1；但只有 1～2 個字的回答看不出程度，算 0.6
 */
export function messageScore(learner: string, reply: string | null): number {
	const en = words(learner);
	const zh = cjkCount(learner);
	if (!en.length || zh > en.length * 2) return 0.15;
	let s = 1;
	const r = reply ? parseReply(reply) : null;
	if (r?.correction) {
		const ratio = editRatio(r.correction.original, r.correction.corrected);
		s = ratio < 0.15 ? 0.75 : Math.max(0.1, Math.min(0.75, 1 - ratio * 1.5));
	} else if (en.length <= 2) s = 0.6;
	if (zh) s = Math.min(s, 0.5);
	return s;
}

export interface LevelEstimate {
	level: ChatLevel;
	fluency: number; // 0～1
	samples: number;
	avgWords: number;
}

/** 最近幾則訊息的權重較高；樣本少時往起點靠（不會一兩句就跳很多級）。 */
export function estimateChatLevel(messages: ConvMessage[], level: Level, recent = 10): LevelEstimate {
	const pairs: { score: number; n: number }[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== "user") continue;
		// 還沒有 AI 回覆的訊息（剛送出）不算：還不知道有沒有被糾正
		const next = messages[i + 1];
		if (next?.role !== "model") continue;
		pairs.push({ score: messageScore(m.text, next.text), n: words(m.text).length });
	}
	const use = pairs.slice(-recent);
	const start = defaultChatLevel(level);
	const prior = (start - 0.5) / 5; // 起點等級的中間值
	const PRIOR_WEIGHT = 3;
	let sum = prior * PRIOR_WEIGHT;
	let wsum = PRIOR_WEIGHT;
	use.forEach((p, i) => {
		const w = 1 + i / Math.max(1, use.length - 1); // 1 → 2：越新越重
		sum += p.score * w;
		wsum += w;
	});
	const fluency = sum / wsum;
	const en = use.filter((p) => p.n > 0);
	const avgWords = en.length ? en.reduce((a, p) => a + p.n, 0) / en.length : 0;
	let lv = Math.max(1, Math.min(5, Math.floor(fluency * 5) + 1));
	// 一直只回很短的句子：最多到「日常」，先讓對方多說
	if (en.length >= 3 && avgWords < 4) lv = Math.min(lv, 3);
	lv = Math.min(lv, maxChatLevel(level));
	return { level: lv as ChatLevel, fluency, samples: use.length, avgWords };
}

const STYLE: Record<ChatLevel, string> = {
	1: "The learner is struggling. Use very short, simple sentences (about 5–8 words each), only the most common everyday words, simple present and past tense. One idea per reply, at most 2 sentences. If you ask something, make it easy to answer (yes/no or \"A or B?\"). No idioms or phrasal verbs.",
	2: "Use short, simple sentences (up to about 10 words), common everyday words, 1–2 sentences. Avoid idioms and slang. Ask simple, concrete questions.",
	3: "Use clear everyday English, 1–3 sentences, mostly common words. Common phrasal verbs are fine; avoid idioms or slang whose meaning is hard to guess.",
	4: "Talk naturally, like chatting with a friend: normal contractions, common phrasal verbs and everyday expressions where they fit, natural sentence length.",
	5: "The learner is doing well. Talk exactly as you would with a native-speaker friend: natural rhythm, everyday idioms and expressions when they fit naturally, varied sentence length.",
};

/** 加在系統提示後面的程度說明。 */
export function levelPrompt(est: LevelEstimate, level: Level): string {
	return `

Learner's current level in this chat: ${est.level} of ${maxChatLevel(level)} (measured from their recent messages; this overrides the CEFR guess above).
${STYLE[est.level]}${level === "kid" ? " Keep it suitable for a child." : ""}
Natural is not the same as difficult: never pick rare words or complex sentence structures just to make it harder. Adjust gradually — do not change style abruptly from one reply to the next.`;
}
