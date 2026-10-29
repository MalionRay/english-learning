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
	/** 超過這個毫秒數還沒回應，就再送一次相同的請求，取先回來的（減少偶發的長時間等待）。 */
	hedgeAfterMs?: number;
	/** 整體逾時（毫秒）。 */
	timeoutMs?: number;
	/** 額外的 generationConfig 欄位（例如 thinkingLevel）。 */
	generationExtra?: Record<string, unknown>;
}

/** 附加在訊息裡的圖片或聲音。 */
export interface InlineImage {
	mimeType: string;
	data: string; // base64（不含 data: 前綴）
}

export interface ChatTurn {
	role: "user" | "model";
	text: string;
	/** 圖片或聲音（放在文字前面）。 */
	media?: InlineImage[];
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

/**
 * 送出請求；超過 hedgeAfterMs 還沒回來就再送一次，取先成功的那個。
 * 兩個都失敗才算失敗；超過 timeoutMs 視為逾時。
 */
export function hedged<T>(fn: () => Promise<T>, hedgeAfterMs?: number, timeoutMs?: number): Promise<T> {
	if (!hedgeAfterMs && !timeoutMs) return fn();
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let running = 0;
		let launched = 0;
		const timers: ReturnType<typeof setTimeout>[] = [];
		const finish = (ok: boolean, v: unknown) => {
			if (settled) return;
			settled = true;
			timers.forEach(clearTimeout);
			if (ok) resolve(v as T);
			else reject(v);
		};
		const launch = () => {
			running++;
			launched++;
			fn().then(
				(v) => finish(true, v),
				(e) => {
					running--;
					// 還有另一個在跑、或還會再送一次：等它
					if (running === 0 && (launched >= 2 || !hedgeAfterMs)) finish(false, e);
					else if (running === 0) {
						timers.forEach(clearTimeout);
						launch();
					}
				},
			);
		};
		launch();
		if (hedgeAfterMs) timers.push(setTimeout(() => !settled && launched < 2 && launch(), hedgeAfterMs));
		if (timeoutMs)
			timers.push(setTimeout(() => finish(false, new AIError(`AI 超過 ${Math.round(timeoutMs / 1000)} 秒沒有回應，請再送一次。`, undefined, "", "network")), timeoutMs));
	});
}

/**
 * 先用快速模型；模型不存在或今天額度用完時，自動改用備用模型（通常是設定裡的主要模型）。
 */
export class FallbackBackend implements AIBackend {
	readonly id = "fallback";
	constructor(
		private primary: AIBackend,
		private backup: AIBackend,
		private onFallback?: (e: AIError) => void,
	) {}
	get model() {
		return this.primary.model;
	}
	private async run(fn: (b: AIBackend) => Promise<AIResult>): Promise<AIResult> {
		try {
			return await fn(this.primary);
		} catch (e) {
			if (e instanceof AIError && (e.kind === "model" || e.kind === "daily")) {
				this.onFallback?.(e);
				return fn(this.backup);
			}
			throw e;
		}
	}
	complete(prompt: string, opts?: AIOptions) {
		return this.run((b) => b.complete(prompt, opts));
	}
	chat(turns: ChatTurn[], opts?: AIOptions) {
		return this.run((b) => b.chat(turns, opts));
	}
}

/** Google Gemini（generateContent）。網路只用 requestUrl()。 */
export class GeminiBackend implements AIBackend {
	readonly id = "gemini";

	constructor(private apiKey: string, readonly model: string) {}

	complete(prompt: string, opts: AIOptions = {}): Promise<AIResult> {
		return this.chat([{ role: "user", text: prompt, media: opts.images }], opts);
	}

	async chat(turns: ChatTurn[], opts: AIOptions = {}): Promise<AIResult> {
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
		const generationConfig: Record<string, unknown> = { maxOutputTokens: opts.maxOutputTokens ?? 256 };
		if (opts.json) generationConfig.responseMimeType = "application/json";
		if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
		if (opts.generationExtra) Object.assign(generationConfig, opts.generationExtra);
		const body: Record<string, unknown> = {
			contents: turns.map((t) => ({
				role: t.role,
				parts: [...(t.media ?? []).map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } })), { text: t.text }],
			})),
			generationConfig,
		};
		if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };

		if (exhausted.get(this.model) === quotaDay()) throw new AIError(DAILY_MSG, 429, "", "daily");
		const payload = JSON.stringify(body);
		const post = async () => {
			try {
				return await requestUrl({ url, method: "POST", contentType: "application/json", headers: { "x-goog-api-key": this.apiKey }, body: payload, throw: false });
			} catch (e) {
				throw new AIError("沒有網路連線，或連不到 Google。", undefined, String((e as Error)?.message ?? e), "network");
			}
		};
		const res = await hedged(post, opts.hedgeAfterMs, opts.timeoutMs);

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
