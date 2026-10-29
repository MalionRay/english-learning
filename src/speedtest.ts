// AI 速度測試：在這台裝置上量 Gemini 各種請求花多久，找出對話為什麼慢。
// 量：純網路來回（列出模型）、最短的生成、對話大小的 JSON 生成（連續兩次）、
// 關閉思考的兩種寫法、其他可用的 flash 模型；同時量主執行緒有沒有被卡住。
import { App, Modal, Notice, requestUrl } from "obsidian";
import type EnglishLearningPlugin from "./main";
import { AIBackend, AIOptions, GeminiBackend } from "./ai";
import { OPENING, TOPICS, chatSystemPrompt } from "./chat";

export interface SpeedRow {
	label: string;
	model: string;
	ms: number;
	ok: boolean;
	out?: number; // 輸出 tokens
	thoughts?: number;
	lag: number; // 等待期間主執行緒最長卡住多久（ms）
	error?: string;
}

/** 等待時每 100 ms 檢查一次計時器有沒有準時：延遲很多代表主執行緒被其他工作卡住。 */
async function measure<T>(fn: () => Promise<T>): Promise<{ ms: number; lag: number; value?: T; error?: unknown }> {
	let lag = 0;
	let last = Date.now();
	const timer = setInterval(() => {
		const now = Date.now();
		lag = Math.max(lag, now - last - 100);
		last = now;
	}, 100);
	const t0 = Date.now();
	try {
		const value = await fn();
		return { ms: Date.now() - t0, lag, value };
	} catch (error) {
		return { ms: Date.now() - t0, lag, error };
	} finally {
		clearInterval(timer);
	}
}

const CHAT_OPTS: AIOptions = { system: chatSystemPrompt("adult", TOPICS[0]), json: true, maxOutputTokens: 1024, temperature: 0.7 };
const CHAT_TURNS = [
	{ role: "user" as const, text: OPENING },
	{ role: "model" as const, text: '{"correction":null,"howto":[],"reply":"Hi! How is your day going?","replyZh":"嗨！你今天過得如何？"}' },
	{ role: "user" as const, text: "It is good, I go to the park with my dog yesterday." },
];

/** 從模型清單挑幾個可以拿來比較的文字模型（flash 系列，不含語音、圖片等特殊用途）。 */
export function pickCompareModels(names: string[], current: string, max = 3): string[] {
	const ok = names
		.map((n) => n.replace(/^models\//, ""))
		.filter((n) => /flash/.test(n) && !/tts|image|live|audio|embed|vision|thinking|exp|preview-0|computer|robotics|native/.test(n) && n !== current);
	// 新版本在前（數字大的先），lite 與非 lite 各留一些
	ok.sort((a, b) => (a < b ? 1 : -1));
	const lite = ok.filter((n) => n.includes("lite"));
	const full = ok.filter((n) => !n.includes("lite"));
	const out: string[] = [];
	for (let i = 0; out.length < max && (i < lite.length || i < full.length); i++) {
		if (lite[i]) out.push(lite[i]);
		if (out.length < max && full[i]) out.push(full[i]);
	}
	return out.slice(0, max);
}

export async function runSpeedTest(
	apiKey: string,
	model: string,
	onRow: (r: SpeedRow) => void,
	makeBackend: (m: string) => AIBackend = (m) => new GeminiBackend(apiKey, m),
	tts?: { model: string; bench: (text: string) => Promise<{ ms: number; decodeMs: number; bytes: number }> },
): Promise<SpeedRow[]> {
	const rows: SpeedRow[] = [];
	const push = (r: SpeedRow) => {
		rows.push(r);
		onRow(r);
	};
	const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 160);

	// 1. 純網路：列出模型（不需要 AI 生成）
	let names: string[] = [];
	const net = await measure(() =>
		requestUrl({ url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", headers: { "x-goog-api-key": apiKey }, throw: false }),
	);
	const status = net.value?.status;
	if (net.value && status === 200) names = (net.value.json?.models ?? []).map((m: { name: string }) => m.name);
	push({ label: "網路來回（列出模型）", model: "-", ms: net.ms, lag: net.lag, ok: status === 200, error: net.error ? errText(net.error) : status !== 200 ? `HTTP ${status}` : undefined });

	const gen = async (label: string, m: string, short: boolean, extra?: Record<string, unknown>) => {
		const ai = makeBackend(m);
		const r = await measure(() =>
			short ? ai.complete("Reply with: OK", { maxOutputTokens: 16, generationExtra: extra }) : ai.chat(CHAT_TURNS, { ...CHAT_OPTS, generationExtra: extra }),
		);
		push({
			label,
			model: m,
			ms: r.ms,
			lag: r.lag,
			ok: !r.error,
			out: r.value?.usage.outputTokens,
			thoughts: r.value?.usage.thoughtTokens,
			error: r.error ? errText(r.error) : undefined,
		});
	};

	// 2. 目前的模型
	await gen("最短的生成", model, true);
	await gen("對話大小（第 1 次）", model, false);
	await gen("對話大小（第 2 次）", model, false);
	// 3. 明確關閉思考（兩種欄位寫法，看哪個有效）
	await gen("對話＋thinkingLevel minimal", model, false, { thinkingLevel: "minimal" });
	await gen("對話＋thinkingConfig minimal", model, false, { thinkingConfig: { thinkingLevel: "minimal" } });
	// 4. 其他模型
	for (const m of pickCompareModels(names, model)) await gen("對話大小", m, false);
	// 5. 自然語音（一句對話長度）：網路與解碼分開量
	if (tts) {
		let decode = 0;
		const r = await measure(async () => {
			const b = await tts.bench("That sounds great! What did you and your dog do at the park yesterday?");
			decode = b.decodeMs;
			return b;
		});
		push({ label: `自然語音（解碼 ${(decode / 1000).toFixed(1)} 秒）`, model: tts.model, ms: r.ms, lag: r.lag, ok: !r.error, error: r.error ? errText(r.error) : undefined });
	}
	return rows;
}

export function formatSpeedRows(rows: SpeedRow[]): string {
	return rows
		.map(
			(r) =>
				`${r.ok ? "✓" : "✗"} ${r.label}｜${r.model}｜${(r.ms / 1000).toFixed(1)} 秒` +
				`${r.out !== undefined ? `｜輸出 ${r.out}` : ""}${r.thoughts ? `｜思考 ${r.thoughts}` : ""}${r.lag > 300 ? `｜主執行緒卡 ${(r.lag / 1000).toFixed(1)} 秒` : ""}${r.error ? `｜${r.error}` : ""}`,
		)
		.join("\n");
}

// ---------------------------------------------------------------------
// 畫面

export class SpeedTestModal extends Modal {
	constructor(app: App, private plugin: EnglishLearningPlugin) {
		super(app);
	}

	onOpen() {
		this.setTitle("AI 速度測試");
		void this.run();
	}

	onClose() {
		this.contentEl.empty();
	}

	private async run() {
		const p = this.plugin;
		const el = this.contentEl;
		el.addClass("el-practice");
		const key = p.getApiKey();
		if (!key) return void el.createDiv({ text: "尚未設定 API key" });
		el.createDiv({ cls: "el-muted", text: "量這台裝置呼叫 Gemini 各要多久（約 10 次呼叫、1 段語音，大概 1～3 分鐘）。結果會寫進除錯紀錄。" });
		const list = el.createDiv({ cls: "el-speed-list" });
		const status = el.createDiv({ cls: "el-muted", text: "測試中…" });
		const rows = await runSpeedTest(
			key,
			p.settings.geminiModel,
			(r) => {
				const line = list.createDiv({ cls: `el-speed-row${r.ok ? "" : " is-bad"}` });
				line.setText(formatSpeedRows([r]));
			},
			undefined,
			p.settings.geminiTts ? { model: p.settings.ttsModel, bench: (t) => p.pronouncer.benchTts(t) } : undefined,
		);
		const text = formatSpeedRows(rows);
		p.debug(`speed test (${navigator.userAgent.slice(0, 80)}):\n${text}`);
		status.setText("完成，已寫進除錯紀錄並開始同步。");
		p.triggerSync(true);
		new Notice("AI 速度測試完成");
	}
}
