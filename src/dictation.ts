// 聽力理解（原聽寫）：從題庫裡的英文句子產生聽力項目。逐字比對（diffWords）保留備用。不碰 Vault，方便測試。
import type { Bank, ChoiceQ, Question } from "./generate";
import { audioKey } from "./pronounce";

export const DICT_PREFIX = "listen:";
export const DICT_PASS = 0.9;

export interface DictItem {
	id: string; // "dict:<hash>"
	text: string;
	zh?: string;
	bank: string;
	level: Bank["level"];
}

function clean(s: string): string {
	return s
		.replace(/[​-‍⁠﻿]/g, "")
		.replace(/^\s*(\.\.\.|…)\s*/, "")
		.replace(/\s*(\.\.\.|…)\s*$/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** 一題可以提供的句子（英文＋中文）。 */
function sentencesOf(q: Question): { text: string; zh?: string }[] {
	if (q.type === "vocab") {
		const c = q as ChoiceQ;
		return c.context ? [{ text: c.context, zh: c.contextZh }] : [];
	}
	if (q.type === "cloze") {
		const c = q as ChoiceQ;
		return [{ text: c.prompt.replace("____", c.options[c.answer]), zh: c.promptZh }];
	}
	if (q.type === "translate") return [{ text: q.reference, zh: q.prompt }];
	return [];
}

/** 依程度限制長度：小孩 3～14 字，成人 4～25 字。 */
export function dictationItems(sources: { q: Question; bank: Bank }[]): DictItem[] {
	const out = new Map<string, DictItem>();
	for (const { q, bank } of sources) {
		for (const s of sentencesOf(q)) {
			const text = clean(s.text);
			if (!text || text.includes("____")) continue;
			const n = tokens(text).length;
			const [min, max] = bank.level === "kid" ? [3, 14] : [4, 25];
			if (n < min || n > max) continue;
			const id = DICT_PREFIX + audioKey(text);
			if (!out.has(id)) out.set(id, { id, text, zh: s.zh, bank: bank.sourceId, level: bank.level });
		}
	}
	return [...out.values()];
}

/** 比對用的字：小寫、去標點；連字號視為分隔（high-profile = high profile），撇號忽略（it's = its）。 */
export function tokens(s: string): string[] {
	return s
		.toLowerCase()
		.replace(/[’‘']/g, "")
		.replace(/[“”"]/g, " ")
		.split(/[\s\-–—]+/)
		.map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
		.filter(Boolean);
}

/** 顯示用的字：依空白切開，連字號的字拆成「high-」「profile」，與 tokens 一一對應。 */
function displayWords(s: string): string[] {
	const out: string[] = [];
	for (const w of s.split(/\s+/)) {
		const pieces = w.split("-");
		pieces.forEach((p, i) => {
			const shown = i < pieces.length - 1 ? `${p}-` : p;
			if (tokens(shown).length === 1) out.push(shown);
			else if (out.length && shown) out[out.length - 1] += shown; // 純標點併到前一個字
		});
	}
	return out;
}

export interface DiffPart {
	kind: "ok" | "missing" | "wrong" | "extra";
	expected?: string; // 原句的字（顯示用，保留大小寫）
	typed?: string;
}

/** 逐字比對（LCS）：回傳依原句順序的結果與正確率。 */
export function diffWords(target: string, typed: string): { parts: DiffPart[]; score: number } {
	const shown = displayWords(target);
	const a = shown.map((w) => tokens(w)[0]);
	const b = tokens(typed);
	const n = a.length,
		m = b.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

	const parts: DiffPart[] = [];
	let i = 0,
		j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			parts.push({ kind: "ok", expected: shown[i] });
			i++;
			j++;
		} else if (i < n && j < m && dp[i + 1][j + 1] === dp[i][j]) {
			// 這個位置寫錯了（替換）
			parts.push({ kind: "wrong", expected: shown[i], typed: b[j] });
			i++;
			j++;
		} else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
			parts.push({ kind: "missing", expected: shown[i] });
			i++;
		} else {
			parts.push({ kind: "extra", typed: b[j] });
			j++;
		}
	}
	const ok = parts.filter((p) => p.kind === "ok").length;
	const extra = parts.filter((p) => p.kind === "extra").length;
	const score = n ? Math.max(0, (ok - extra * 0.5) / n) : 0;
	return { parts, score };
}
