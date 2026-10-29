// Google Cloud 語音（Text-to-Speech，Chirp 3 HD 聲音）。
// 每月前 100 萬字免費；外掛自己算這個月所有裝置用了多少字（從 log 加總），到上限就不再呼叫。
// 必須用「另一個」有開付費帳戶的 Google Cloud 專案的 API key：同一個專案開了付費，Gemini API 也會變成付費版。
import { App, requestUrl } from "obsidian";
import { AIError, quotaDay } from "./ai";
import { LOG_ROOT, listRecursive } from "./logs";

export const CLOUD_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";
export const CLOUD_FREE_CHARS = 1_000_000;
export const DEFAULT_CLOUD_CAP = 800_000;

/** Chirp 3 HD 的英文聲音（en-US-Chirp3-HD-<名字>）。 */
export const CHIRP_VOICES: { name: string; label: string }[] = [
	{ name: "Kore", label: "Kore（女，沉穩）" },
	{ name: "Aoede", label: "Aoede（女，輕快）" },
	{ name: "Leda", label: "Leda（女，年輕）" },
	{ name: "Zephyr", label: "Zephyr（女，明亮）" },
	{ name: "Autonoe", label: "Autonoe（女）" },
	{ name: "Callirrhoe", label: "Callirrhoe（女）" },
	{ name: "Despina", label: "Despina（女）" },
	{ name: "Sulafat", label: "Sulafat（女，溫暖）" },
	{ name: "Vindemiatrix", label: "Vindemiatrix（女，溫和）" },
	{ name: "Puck", label: "Puck（男，活潑）" },
	{ name: "Charon", label: "Charon（男，低沉）" },
	{ name: "Fenrir", label: "Fenrir（男）" },
	{ name: "Orus", label: "Orus（男，穩重）" },
	{ name: "Achird", label: "Achird（男，友善）" },
	{ name: "Iapetus", label: "Iapetus（男）" },
	{ name: "Umbriel", label: "Umbriel（男）" },
];

export function chirpVoiceId(name: string, lang = "en-US"): string {
	return name.includes("-") ? name : `${lang}-Chirp3-HD-${name}`;
}

/** Google 帳單以太平洋時間的月份計算。 */
export function cloudMonth(d = new Date()): string {
	return quotaDay(d).slice(0, 7);
}

/** 算字數：Google 依字元計費（含空白）。 */
export function billedChars(text: string): number {
	return [...text].length;
}

export async function synthCloud(apiKey: string, text: string, voice: string): Promise<ArrayBuffer> {
	let res;
	try {
		res = await requestUrl({
			url: CLOUD_ENDPOINT,
			method: "POST",
			contentType: "application/json",
			headers: { "x-goog-api-key": apiKey },
			body: JSON.stringify({
				input: { text },
				voice: { languageCode: "en-US", name: chirpVoiceId(voice) },
				audioConfig: { audioEncoding: "MP3" },
			}),
			throw: false,
		});
	} catch (e) {
		throw new AIError("沒有網路連線，或連不到 Google Cloud。", undefined, String((e as Error)?.message ?? e), "network");
	}
	if (res.status < 200 || res.status >= 300) {
		let detail = "";
		try {
			detail = res.json?.error?.message ?? "";
		} catch {
			/* 不是 JSON */
		}
		const kind = res.status === 429 ? "minute" : res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(detail)) ? "auth" : res.status >= 500 ? "server" : "other";
		throw new AIError(`Google Cloud 語音 HTTP ${res.status}${detail ? `：${detail}` : ""}`, res.status, res.text?.slice(0, 1000), kind);
	}
	const b64 = res.json?.audioContent;
	if (typeof b64 !== "string" || !b64) throw new Error("Google Cloud 語音沒有回傳音訊");
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out.buffer;
}

/** 這個月所有裝置用了多少字：從 logs/**.jsonl 的 tts 紀錄（source "cloud"）加總，UUID 去重。 */
export async function readCloudUsage(app: App, month = cloudMonth()): Promise<number> {
	const seen = new Set<string>();
	let total = 0;
	for (const path of await listRecursive(app, LOG_ROOT)) {
		if (!path.endsWith(".jsonl")) continue;
		let text = "";
		try {
			text = await app.vault.adapter.read(path);
		} catch {
			continue;
		}
		if (!text.includes('"cloud"')) continue;
		for (const line of text.split("\n")) {
			if (!line.includes('"cloud"')) continue;
			try {
				const e = JSON.parse(line);
				if (e?.type === "tts" && e.source === "cloud" && e.month === month && typeof e.chars === "number" && e.id && !seen.has(e.id)) {
					seen.add(e.id);
					total += e.chars;
				}
			} catch {
				/* 壞行略過 */
			}
		}
	}
	return total;
}

/** 這台裝置記住的用量（啟動時從 log 讀一次，之後每次使用加上去；每 10 分鐘重讀，把其他裝置同步來的也算進去）。 */
export class CloudUsage {
	private month = "";
	private total = 0;
	private loadedAt = 0;
	private loading: Promise<void> | null = null;

	constructor(private app: App) {}

	async used(): Promise<number> {
		const m = cloudMonth();
		if (m !== this.month || Date.now() - this.loadedAt > 10 * 60_000) {
			this.loading ??= readCloudUsage(this.app, m)
				.then((t) => {
					// 重讀時，這台剛用掉、可能還沒寫進檔的字數不要少算
					this.total = m === this.month ? Math.max(this.total, t) : t;
					this.month = m;
					this.loadedAt = Date.now();
				})
				.finally(() => (this.loading = null));
			await this.loading;
		}
		return this.total;
	}

	add(chars: number) {
		if (cloudMonth() === this.month) this.total += chars;
	}
}
