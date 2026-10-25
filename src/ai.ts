import { requestUrl } from "obsidian";

/** 可替換的 AI 後端介面。換供應商只需新增一個實作並在設定中切換。 */
export interface AIUsage {
	inputTokens?: number;
	outputTokens?: number;
	thoughtTokens?: number;
	totalTokens?: number;
}

export interface AIResult {
	text: string;
	usage: AIUsage;
	model: string;
	finishReason?: string;
}

export interface AIOptions {
	/** 固定的指示放這裡（放在前面，利於快取）。 */
	system?: string;
	/** 要求回傳 JSON。 */
	json?: boolean;
	maxOutputTokens?: number;
	temperature?: number;
	/** 附加圖片（complete 用；放在提示文字前面）。 */
	images?: InlineImage[];
}

export interface InlineImage {
	mimeType: string;
	data: string; // base64（不含 data: 前綴）
}

export interface ChatTurn {
	role: "user" | "model";
	text: string;
	images?: InlineImage[];
}

export interface AIBackend {
	readonly id: string;
	readonly model: string;
	complete(prompt: string, opts?: AIOptions): Promise<AIResult>;
	/** 多輪對話：turns 依時間順序，最後一個應是 user。 */
	chat(turns: ChatTurn[], opts?: AIOptions): Promise<AIResult>;
}

export type AIErrorKind = "daily" | "minute" | "auth" | "model" | "server" | "network" | "other";

export class AIError extends Error {
	constructor(message: string, public status?: number, public body?: string, public kind: AIErrorKind = "other") {
		super(message);
	}
}

/** Google 免費額度的「一天」：以美國太平洋時間為準。 */
export function quotaDay(d = new Date()): string {
	try {
		return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
	} catch {
		return new Date(d.getTime() - 8 * 3600_000).toISOString().slice(0, 10);
	}
}

/** 各模型當天的每日額度是否已用完（記在記憶體，避免一直撞牆）。 */
const exhausted = new Map<string, string>();

export const DAILY_MSG = "今天的 AI 免費額度用完了，台灣時間下午 3～4 點後恢復。離線也能做的練習（選擇題、克漏字、生字複習、自己判斷）照常可以用。";

/** 把 HTTP 錯誤轉成看得懂的中文。 */
export function classifyError(status: number, body: string, model: string): AIError {
	const b = body || "";
	if (status === 429) {
		const daily = /per ?day|PerDay|daily/i.test(b);
		if (daily) exhausted.set(model, quotaDay());
		return daily ? new AIError(DAILY_MSG, 429, b, "daily") : new AIError("AI 使用太頻繁，請等一分鐘再試。", 429, b, "minute");
	}
	if (status === 400 && /api key/i.test(b)) return new AIError("API key 無效，請到「設定 → English Learning」重新輸入。", 400, b, "auth");
	if (status === 401 || status === 403) return new AIError("API key 沒有權限或已停用，請到 Google AI Studio 確認。", status, b, "auth");
	if (status === 404) return new AIError(`找不到模型「${model}」，請到設定確認模型名稱。`, 404, b, "model");
	if (status >= 500) return new AIError("Google AI 暫時無法使用，請稍後再試。", status, b, "server");
	let msg = `AI 回應錯誤（HTTP ${status}）`;
	try {
		const m = JSON.parse(b)?.error?.message;
		if (m) msg += `：${m}`;
	} catch {
		/* 不是 JSON */
	}
	return new AIError(msg, status, b, "other");
}

/** Google Gemini（generateContent）。網路只用 requestUrl()。 */
export class GeminiBackend implements AIBackend {
	readonly id = "gemini";

	constructor(private apiKey: string, readonly model: string) {}

	complete(prompt: string, opts: AIOptions = {}): Promise<AIResult> {
		return this.chat([{ role: "user", text: prompt, images: opts.images }], opts);
	}

	async chat(turns: ChatTurn[], opts: AIOptions = {}): Promise<AIResult> {
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
		const generationConfig: Record<string, unknown> = { maxOutputTokens: opts.maxOutputTokens ?? 256 };
		if (opts.json) generationConfig.responseMimeType = "application/json";
		if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
		const body: Record<string, unknown> = {
			contents: turns.map((t) => ({
				role: t.role,
				parts: [...(t.images ?? []).map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } })), { text: t.text }],
			})),
			generationConfig,
		};
		if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };

		if (exhausted.get(this.model) === quotaDay()) throw new AIError(DAILY_MSG, 429, "", "daily");
		let res;
		try {
			res = await requestUrl({
				url,
				method: "POST",
				contentType: "application/json",
				headers: { "x-goog-api-key": this.apiKey },
				body: JSON.stringify(body),
				throw: false,
			});
		} catch (e) {
			throw new AIError("沒有網路連線，或連不到 Google。", undefined, String((e as Error)?.message ?? e), "network");
		}

		if (res.status < 200 || res.status >= 300) throw classifyError(res.status, res.text?.slice(0, 2000) ?? "", this.model);

		const j = res.json;
		const cand = j?.candidates?.[0];
		const text: string = (cand?.content?.parts ?? [])
			.filter((p: { thought?: boolean }) => !p.thought)
			.map((p: { text?: string }) => p.text ?? "")
			.join("")
			.trim();
		const um = j?.usageMetadata ?? {};
		return {
			text,
			finishReason: cand?.finishReason,
			model: j?.modelVersion ?? this.model,
			usage: {
				inputTokens: um.promptTokenCount,
				outputTokens: um.candidatesTokenCount,
				thoughtTokens: um.thoughtsTokenCount,
				totalTokens: um.totalTokenCount,
			},
		};
	}
}
