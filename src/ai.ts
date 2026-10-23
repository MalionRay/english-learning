import { requestUrl } from "obsidian";

/** 可替換的 AI 後端介面。換供應商只需新增一個實作並在設定中切換。 */
export interface AIUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

export interface AIResult {
	text: string;
	usage: AIUsage;
	model: string;
	raw?: unknown;
}

export interface AIBackend {
	readonly id: string;
	complete(prompt: string, opts?: { maxOutputTokens?: number }): Promise<AIResult>;
}

export class AIError extends Error {
	constructor(message: string, public status?: number, public body?: string) {
		super(message);
	}
}

/** Google Gemini（generateContent）。網路只用 requestUrl()。 */
export class GeminiBackend implements AIBackend {
	readonly id = "gemini";

	constructor(private apiKey: string, private model: string) {}

	async complete(prompt: string, opts: { maxOutputTokens?: number } = {}): Promise<AIResult> {
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
		const res = await requestUrl({
			url,
			method: "POST",
			contentType: "application/json",
			headers: { "x-goog-api-key": this.apiKey },
			body: JSON.stringify({
				contents: [{ role: "user", parts: [{ text: prompt }] }],
				generationConfig: { maxOutputTokens: opts.maxOutputTokens ?? 256 },
			}),
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
			.map((p: { text?: string }) => p.text ?? "")
			.join("")
			.trim();
		const um = j?.usageMetadata ?? {};
		return {
			text: text || `（沒有文字回覆，finishReason=${cand?.finishReason ?? "?"}）`,
			model: j?.modelVersion ?? this.model,
			usage: {
				inputTokens: um.promptTokenCount,
				outputTokens: um.candidatesTokenCount,
				totalTokens: um.totalTokenCount,
			},
			raw: j,
		};
	}
}
