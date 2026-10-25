// 「這題有問題」：回報後所有使用者、所有裝置都不再出這題；可以在主畫面恢復。
// 紀錄寫在回報者自己的 log（type "flag" / "unflag"），依時間重播決定目前狀態。
import { App } from "obsidian";
import { LOG_ROOT, listRecursive } from "./logs";

export interface FlagLog {
	id: string;
	ts: string;
	device: string;
	user: string;
	type: "flag" | "unflag";
	qid: string;
	bank: string;
	reason?: string;
}

export const FLAG_REASONS = ["答案標錯了", "有兩個以上的答案都對", "題目或選項看不懂", "翻譯或解釋有錯", "其他"];

/** 目前被回報（且沒被恢復）的題目：qid → 最後一筆 flag。 */
export function activeFlags(entries: FlagLog[]): Map<string, FlagLog> {
	const seen = new Set<string>();
	const list = entries.filter((e) => e?.id && (e.type === "flag" || e.type === "unflag") && !seen.has(e.id) && seen.add(e.id));
	list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
	const out = new Map<string, FlagLog>();
	for (const e of list) {
		if (e.type === "flag") out.set(e.qid, e);
		else out.delete(e.qid);
	}
	return out;
}

/** 讀所有使用者的 log（題目有錯對每個人都一樣）。 */
export async function loadFlags(app: App): Promise<Map<string, FlagLog>> {
	const entries: FlagLog[] = [];
	for (const path of await listRecursive(app, LOG_ROOT)) {
		if (!path.endsWith(".jsonl")) continue;
		const text = await app.vault.adapter.read(path);
		if (!text.includes('"flag"')) continue; // 快速略過沒有回報的檔案
		for (const line of text.split("\n")) {
			if (!line.includes('flag"')) continue;
			try {
				const e = JSON.parse(line);
				if (e?.type === "flag" || e?.type === "unflag") entries.push(e);
			} catch {
				/* 壞行略過 */
			}
		}
	}
	return activeFlags(entries);
}
