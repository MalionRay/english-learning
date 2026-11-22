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
	/** 同一個請求送了幾份（hedged；伺服器忙重試的也算），用的是第幾份的回應（從 1 算）。 */
	copies?: number;
	winner?: number;
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
	/**
	 * 還沒回應就再送一份相同的請求，取先回來、而且能用的那份（減少免費版偶發的長時間等待）。
	 * 一個數字＝第幾毫秒送第二份；陣列＝第二、三…份各在第幾毫秒送（都從第一份送出時算）。
	 */
	hedgeAfterMs?: number | readonly number[];
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

/** 5xx 時等多久再重試（測試時可改小）。 */
export let RETRY_5XX_MS = 1000;
export function setRetryDelay(ms: number) {
	RETRY_5XX_MS = ms;
}

export const DAILY_MSG = "今天的 AI 免費額度用完了，台灣時間下午 3～4 點後恢復。離線也能做的練習（選擇題、克漏字、生字複習、自己判斷）照常可以用。";

/** 把 HTTP 錯誤轉成看得懂的中文。 */
export function classifyError(status: number, body: string, model: string): AIError {
	const b = body || "";
	if (status === 429) {
		const daily = /per ?day|PerDay|daily/i.test(b);
		if (daily) exhausted.set(model, quotaDay());
		return daily ? new AIError(DAILY_MSG, 429, b, "daily") : new AIError("AI 使用太頻繁，請等一分鐘再試。", 429, b, "minute");
	}
	if (status === 400 && /api key/i.test(b)) return new AIError("API key 無效，請到「設定 → Language Learning」重新輸入。", 400, b, "auth");
	if (status === 401 || status === 403) return new AIError("API key 沒有權限或已停用，請到 Google AI Studio 確認。", status, b, "auth");
	if (status === 404) return new AIError(`找不到模型「${model}」，請到設定確認模型名稱。`, 404, b, "model");
	if (status >= 500) return new AIError("Google AI 現在太忙（伺服器暫時無法使用），請過幾秒再送一次。", status, b, "server");
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
 * hedged 怎麼看一份回應：ok＝用它；retry＝不能用，但還在跑的、還沒送的照舊（伺服器忙）；
 * stop＝不能用，也不要再多送（超過上限、請求本身有錯）。
 */
export type HedgeVerdict = "ok" | "retry" | "stop";

/** hedged 送了幾份、用的是第幾份（從 1 算；都沒用到是 0）。 */
export interface HedgeStats {
	sent: number;
	winner: number;
}

/**
 * 送出請求；到了 hedgeAfterMs 還沒回來就再送一份，取先回來而且能用的那份（judge；沒給＝回來的都能用）。
 * 一份回了不能用的結果（例如另一份還在跑時，這份很快回了「伺服器忙」「超過每分鐘上限」）：不能讓它贏過
 * 還在跑的那份——都沒有在跑了，才把它交回去，讓呼叫的地方照它處理（重試、換模型、提示）。
 * 很快就失敗（連不上）、還沒到下一份的時間：馬上送下一份。全部失敗才算失敗；超過 timeoutMs 視為逾時。
 */
export function hedged<T>(
	fn: () => Promise<T>,
	hedgeAfterMs?: number | readonly number[],
	timeoutMs?: number,
	judge?: (v: T) => HedgeVerdict,
	stats?: HedgeStats,
): Promise<T> {
	const delays = (typeof hedgeAfterMs === "number" ? [hedgeAfterMs] : hedgeAfterMs ?? []).filter((d) => d > 0);
	if (!delays.length && !timeoutMs) {
		if (stats) Object.assign(stats, { sent: 1, winner: 1 });
		return fn();
	}
	const max = 1 + delays.length;
	return new Promise<T>((resolve, reject) => {
		const t0 = Date.now();
		let settled = false;
		let running = 0;
		let launched = 0;
		let stopped = false; // 有一份說不要再送了
		let unusable: { v: T; n: number; stop: boolean } | null = null;
		let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
		let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
		const clearHedge = () => {
			if (hedgeTimer) clearTimeout(hedgeTimer);
			hedgeTimer = null;
		};
		const finish = (ok: boolean, v: unknown, n = 0) => {
			if (settled) return;
			settled = true;
			clearHedge();
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (stats) Object.assign(stats, { sent: launched, winner: n });
			if (ok) resolve(v as T);
			else reject(v);
		};
		const giveBack = () => finish(true, unusable!.v, unusable!.n);
		// 下一份在第幾毫秒送（從第一份算）；已經過了就馬上送
		const schedule = () => {
			clearHedge();
			if (settled || stopped || launched >= max) return;
			hedgeTimer = setTimeout(
				() => {
					hedgeTimer = null;
					if (!settled && !stopped && launched < max) launch();
				},
				Math.max(0, delays[launched - 1] - (Date.now() - t0)),
			);
		};
		const launch = () => {
			running++;
			const n = ++launched;
			schedule();
			fn().then(
				(v) => {
					running--;
					const verdict = judge ? judge(v) : "ok";
					if (verdict === "ok") return finish(true, v, n);
					if (verdict === "stop") {
						stopped = true;
						clearHedge();
					}
					// 留著交回去用；「不要再送」的比「伺服器忙」重要（例如今天額度用完要換模型）
					if (!unusable || (verdict === "stop" && !unusable.stop)) unusable = { v, n, stop: verdict === "stop" };
					if (running === 0) giveBack();
				},
				(e) => {
					running--;
					if (running > 0) return; // 另一份還在跑：等它
					if (unusable) return giveBack();
					if (stopped || launched >= max) return finish(false, e);
					// 很快就失敗、還沒到下一份的時間：馬上送下一份。
					// 只是提早送；整體逾時要留著，不然下一份卡住時會永遠等下去
					launch();
				},
			);
		};
		launch();
		if (timeoutMs)
			timeoutTimer = setTimeout(() => {
				if (unusable) return giveBack(); // 已經有一份回了不能用的結果：交回去，比「逾時」清楚
				finish(false, new AIError(`AI 超過 ${Math.round(timeoutMs / 1000)} 秒沒有回應，請再送一次。`, undefined, "", "network"));
			}, timeoutMs);
	});
}

/** Gemini 的回應能不能用：2xx 可以；5xx（伺服器忙）不能用但可以再試；其他（429 超過上限、400…）不要再多送。 */
export function geminiVerdict(r: { status: number }): HedgeVerdict {
	return r.status >= 200 && r.status < 300 ? "ok" : r.status >= 500 ? "retry" : "stop";
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
			// 模型不存在、今天額度用完、Google 伺服器忙：改用備用模型
			if (e instanceof AIError && (e.kind === "model" || e.kind === "daily" || e.kind === "server")) {
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
		const first: HedgeStats = { sent: 0, winner: 0 };
		let res = await hedged(post, opts.hedgeAfterMs, opts.timeoutMs, geminiVerdict, first);
		let copies = first.sent;
		let winner = first.winner;
		// Google 伺服器忙（5xx）：等一下自動重試一次
		if (res.status >= 500) {
			await new Promise((ok) => setTimeout(ok, RETRY_5XX_MS));
			const again: HedgeStats = { sent: 0, winner: 0 };
			res = await hedged(post, opts.hedgeAfterMs, opts.timeoutMs, geminiVerdict, again);
			winner = copies + again.winner;
			copies += again.sent;
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
			copies,
			winner,
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
