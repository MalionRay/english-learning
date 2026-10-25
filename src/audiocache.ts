// 錄音快取管理：預先產生、空間用量、清除已熟練與不再使用的錄音。
// 錄音是可重建的快取（english/audio/<deviceId>/<hash>），所以清除時可以刪任何裝置資料夾裡的檔案。
import { App, TFile } from "obsidian";
import type { Bank, ChoiceQ, Question } from "./generate";
import { AUDIO_DIR, Pronouncer, audioKey, normalizeSpeech } from "./pronounce";
import { DICT_PREFIX } from "./dictation";
import { WORD_PREFIX, wordKey } from "./words";
import type { QState } from "./srs";

/** 一段要唸的文字，以及會用到它的題目 qid（用來判斷是否已熟練）。 */
export interface AudioText {
	text: string;
	qids: string[];
}

function cleanSentence(s: string): string {
	return s
		.replace(/^\s*(\.\.\.|…)\s*/, "")
		.replace(/\s*(\.\.\.|…)\s*$/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** 一題會唸到的文字：單字（含克漏字答案）與句子（原句、完整句、參考譯文）。 */
export function audioTextsOf(q: Question): AudioText[] {
	const out: AudioText[] = [];
	const sentence = (s: string | undefined) => {
		if (!s) return;
		const c = cleanSentence(s);
		if (c) out.push({ text: c, qids: [q.id, DICT_PREFIX + audioKey(c)] });
	};
	const word = (w: string | undefined) => {
		if (w) out.push({ text: w, qids: [q.id, WORD_PREFIX + wordKey(w)] });
	};
	if (q.type === "vocab") {
		const c = q as ChoiceQ;
		word(c.word || (c.direction !== "zh2en" ? c.prompt : c.options[c.answer]));
		sentence(c.context);
	} else if (q.type === "cloze") {
		const c = q as ChoiceQ;
		word(c.options[c.answer]);
		sentence(c.prompt.replace("____", c.options[c.answer]));
	} else if (q.type === "translate") {
		sentence(q.reference);
	}
	return out;
}

export function audioTextsOfBanks(banks: Bank[]): AudioText[] {
	const map = new Map<string, AudioText>();
	for (const b of banks)
		for (const q of b.questions)
			for (const t of audioTextsOf(q)) {
				const k = audioKey(normalizeSpeech(t.text));
				const prev = map.get(k);
				if (prev) prev.qids.push(...t.qids);
				else map.set(k, { text: t.text, qids: [...t.qids] });
			}
	return [...map.values()];
}

export interface PrefetchResult {
	total: number;
	already: number;
	made: number;
	stoppedByQuota: boolean;
}

/** 依序補齊錄音；額度用完就停（明天再繼續）。 */
export async function prefetchAudio(
	pron: Pronouncer,
	texts: AudioText[],
	onProgress?: (done: number, total: number) => void,
	shouldStop?: () => boolean,
): Promise<PrefetchResult> {
	const todo = texts.filter((t) => !pron.has(t.text));
	const res: PrefetchResult = { total: texts.length, already: texts.length - todo.length, made: 0, stoppedByQuota: false };
	for (let i = 0; i < todo.length; i++) {
		if (shouldStop?.()) break;
		if (typeof navigator !== "undefined" && navigator.onLine === false) break;
		const r = await pron.ensure(todo[i].text);
		if (r === "dict" || r === "gemini") res.made++;
		if (r === "quota") {
			res.stoppedByQuota = true;
			break;
		}
		onProgress?.(i + 1, todo.length);
		await new Promise((ok) => setTimeout(ok, 300)); // 不要連續打太快
	}
	return res;
}

// ---------------------------------------------------------------------

export interface AudioUsage {
	files: number;
	bytes: number;
	mineFiles: number;
	mineBytes: number;
}

export function audioUsage(app: App, deviceId: string): AudioUsage {
	const u: AudioUsage = { files: 0, bytes: 0, mineFiles: 0, mineBytes: 0 };
	for (const f of app.vault.getFiles()) {
		if (!f.path.startsWith(AUDIO_DIR + "/")) continue;
		u.files++;
		u.bytes += f.stat.size;
		if (f.path.startsWith(`${AUDIO_DIR}/${deviceId}/`)) {
			u.mineFiles++;
			u.mineBytes += f.stat.size;
		}
	}
	return u;
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface CleanupPlan {
	files: TFile[];
	bytes: number;
	mastered: number;
	unused: number;
}

/**
 * 可以清掉的錄音：
 * - 已熟練：用到這段文字的題目，凡是有人練過的都已熟練（間隔 7 天以上），而且至少有一題練過
 * - 不再使用：不屬於任何題庫，也不是任何人的生字（例如練習時隨手點來聽的字）
 */
export function planCleanup(app: App, banks: Bank[], statesByUser: Map<string, QState>[], extraWords: string[]): CleanupPlan {
	const texts = audioTextsOfBanks(banks);
	const byKey = new Map(texts.map((t) => [audioKey(normalizeSpeech(t.text)), t]));
	const keep = new Set(extraWords.map((w) => audioKey(normalizeSpeech(w))));
	const plan: CleanupPlan = { files: [], bytes: 0, mastered: 0, unused: 0 };
	for (const f of app.vault.getFiles()) {
		if (!f.path.startsWith(AUDIO_DIR + "/")) continue;
		const key = f.basename;
		const t = byKey.get(key);
		let remove = false;
		if (!t) {
			if (!keep.has(key)) {
				remove = true;
				plan.unused++;
			}
		} else {
			let practiced = false;
			let allMastered = true;
			for (const states of statesByUser)
				for (const qid of t.qids) {
					const st = states.get(qid);
					if (!st) continue;
					practiced = true;
					if (st.step < 3) allMastered = false;
				}
			if (practiced && allMastered) {
				remove = true;
				plan.mastered++;
			}
		}
		if (remove) {
			plan.files.push(f);
			plan.bytes += f.stat.size;
		}
	}
	return plan;
}
