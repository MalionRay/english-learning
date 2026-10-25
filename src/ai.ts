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
}

export interface ChatTurn {
	role: "user" | "model";
	text: string;
}

export interface AIBackend {
	readonly id: string;
	readonly model: string;
	complete(prompt: string, opts?: AIOptions): Promise<AIResult>;
	/** 多輪對話：turns 依時間順序，最後一個應是 user。 */
	chat(turns: ChatTurn[], opts?: AIOptions): Promise<AIResult>;
}

export class AIError extends Error {
	constructor(message: string, public status?: number, public body?: string) {
		super(message);
	}
}

/** Google Gemini（generateContent）。網路只用 requestUrl()。 */
export class GeminiBackend implements AIBackend {
	readonly id = "gemini";

	constructor(private apiKey: string, readonly model: string) {}

	complete(prompt: string, opts: AIOptions = {}): Promise<AIResult> {
		return this.chat([{ role: "user", text: prompt }], opts);
	}

	async chat(turns: ChatTurn[], opts: AIOptions = {}): Promise<AIResult> {
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
		const generationConfig: Record<string, unknown> = { maxOutputTokens: opts.maxOutputTokens ?? 256 };
		if (opts.json) generationConfig.responseMimeType = "application/json";
		if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
		const body: Record<string, unknown> = {
			contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
			generationConfig,
		};
		if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };

		const res = await requestUrl({
			url,
			method: "POST",
			contentType: "application/json",
			headers: { "x-goog-api-key": this.apiKey },
			body: JSON.stringify(body),
			throw: false,
		});

		if (res.status < 200 || res.status >= 300) {
			let msg = `HTTP ${res.status}`;
			try {
				const j = res.json;
				if (j?.error?.message) msg += `: ${j.error.message}`;
			} catch {
				/* body 不是 JSON */
			}
			throw new AIError(msg, res.status, res.text?.slice(0, 2000));
		}

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
