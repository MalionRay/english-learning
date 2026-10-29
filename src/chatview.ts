// 英文對話畫面
import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import type EnglishLearningPlugin from "./main";
import type { Level } from "./generate";
import { stripMarks } from "./generate";
import { listSources, stripFrontmatter } from "./sources";
import { cachedZh, translateMany } from "./translate";
import {
	CONV_DIR,
	ChatReply,
	ConvMessage,
	ConvMeta,
	TOPICS,
	Topic,
	chatSystemPrompt,
	convBlock,
	convHeader,
	historyTurns,
	parseConvMessages,
	parseReply,
	phraseKey,
} from "./chat";

import { VOICE_TURN, parseHeard } from "./chat";
import { WavRecorder, arrayBufferToBase64, recordingSupported } from "./recorder";
import { primeSpeech, speak, stopSpeaking } from "./tts";
import { stopAudio, unlockAudio } from "./pronounce";
import { AIError } from "./ai";
import type { ChatTurn } from "./ai";
import { SpeedTestModal } from "./speedtest";
import { ChatTarget, mentionsWord, parseLearnerUsed, pickTargets, targetsPrompt, usedTargets } from "./chattargets";
import { loadPractice } from "./practice";
import type { AnswerLog } from "./srs";

export const CHAT_VIEW = "english-learning-chat";
const LS_CHAT = "english-learning:chat"; // { [user]: { topic, article, review } }
/** AI 回覆的朗讀方式（每台裝置各自設定）：natural＝Gemini 自然語音（預設）、system＝系統語音、off＝不自動朗讀。 */
export const LS_CHAT_VOICE = "english-learning:chat-voice";
const LS_CHAT_VOICE_LAST = "english-learning:chat-voice-last";
export type ChatVoice = "system" | "natural" | "off";
const HEDGE_MS = 8000; // 超過 8 秒沒回應就再送一次
const TIMEOUT_MS = 45000;

function localDate(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class ChatView extends ItemView {
	private phase: "start" | "chat" = "start";
	private meta: ConvMeta | null = null;
	private file: TFile | null = null;
	private messages: ConvMessage[] = [];
	private article = "";
	private topic: Topic = TOPICS[0];
	private sending = false;
	private listEl: HTMLElement | null = null;
	private targets: ChatTarget[] = []; // 這次對話要複習的生字與句子
	private doneTargets = new Set<string>(); // 已在這次對話中用對的 qid
	private targetsEl: HTMLElement | null = null;
	private recorder: WavRecorder | null = null;
	private speechGen = 0; // 每次停止朗讀就加一，進行中的朗讀看到變了就不再播

	constructor(leaf: WorkspaceLeaf, private plugin: EnglishLearningPlugin) {
		super(leaf);
	}
	getViewType() {
		return CHAT_VIEW;
	}
	getDisplayText() {
		return "英文對話";
	}
	getIcon() {
		return "messages-square";
	}
	async onOpen() {
		this.render();
	}

	render() {
		if (this.phase === "start") this.drawStart();
	}

	private level(): Level {
		return this.plugin.user === "kid" ? "kid" : "adult";
	}

	private root(): HTMLElement {
		const el = this.contentEl;
		el.empty();
		el.addClass("el-verify");
		el.addClass("el-practice");
		el.addClass("el-chat");
		return el;
	}

	// ---- 開始畫面 ----
	private drawStart() {
		const p = this.plugin;
		const el = this.root();
		el.createEl("h3", { text: "英文對話" });
		el.createDiv({
			cls: "el-muted",
			text: "用英文聊天；說錯會即時糾正。不會說的可以直接打中文問「…英文怎麼說」。糾正過的句子和問過的說法會記進「句子本」，之後在練習裡複習。到期的生字和句子會在聊天中自然出現，你用對了就算複習。",
		});
		const prefs = ((this.app.loadLocalStorage(LS_CHAT) ?? {}) as Record<string, { topic?: string; article?: string; review?: boolean }>)[p.user] ?? {};

		el.createDiv({ cls: "el-row" }, (r) => {
			r.createSpan({ text: "使用者" });
			const sel = r.createEl("select", { cls: "dropdown" });
			for (const u of p.settings.users) sel.createEl("option", { text: u, value: u });
			sel.value = p.user;
			sel.onchange = () => {
				p.user = sel.value;
				this.drawStart();
			};
		});
		let topicId = prefs.topic ?? (p.user === "kid" ? "school" : "free");
		let articlePath = prefs.article ?? "";
		const artRow = el.createDiv({ cls: "el-row" });
		el.createDiv({ cls: "el-row" }, (r) => {
			r.createSpan({ text: "情境" });
			const sel = r.createEl("select", { cls: "dropdown" });
			for (const t of TOPICS) sel.createEl("option", { text: t.label, value: t.id });
			sel.value = topicId;
			const drawArt = () => {
				artRow.empty();
				if (topicId !== "article") return;
				artRow.createSpan({ text: "文章" });
				const a = artRow.createEl("select", { cls: "dropdown" });
				const sources = listSources(this.app);
				for (const s of sources) a.createEl("option", { text: s.title, value: s.file.path });
				if (!sources.length) a.createEl("option", { text: "（還沒有文章）", value: "" });
				if (!articlePath && sources[0]) articlePath = sources[0].file.path;
				a.value = articlePath;
				a.onchange = () => (articlePath = a.value);
			};
			sel.onchange = () => {
				topicId = sel.value;
				drawArt();
			};
			drawArt();
		});
		// 讓文章選單出現在情境下面
		el.appendChild(artRow);
		el.createDiv({ cls: "el-row" }, (r) => {
			r.createSpan({ text: "AI 回覆朗讀" });
			const sel = r.createEl("select", { cls: "dropdown" });
			sel.createEl("option", { text: "自然語音（Gemini）", value: "natural" });
			sel.createEl("option", { text: "系統語音（立即、不用額度）", value: "system" });
			sel.createEl("option", { text: "不自動朗讀", value: "off" });
			sel.value = this.voice();
			sel.onchange = () => this.app.saveLocalStorage(LS_CHAT_VOICE, sel.value);
		});
		let review = prefs.review !== false;
		el.createEl("label", { cls: "el-row" }, (r) => {
			const box = r.createEl("input", { type: "checkbox" });
			box.checked = review;
			box.onchange = () => (review = box.checked);
			r.createSpan({ text: "聊天中自然複習到期的生字和句子（用對了就算複習一次）" });
		});

		el.createDiv({ cls: "el-row el-big-buttons" }, (r) => {
			const go = r.createEl("button", { text: "開始對話", cls: "mod-cta" });
			go.onclick = () => {
				this.primeAudio(); // 在點擊裡解鎖朗讀（iOS）
				const all = (this.app.loadLocalStorage(LS_CHAT) ?? {}) as Record<string, unknown>;
				all[p.user] = { topic: topicId, article: articlePath, review };
				this.app.saveLocalStorage(LS_CHAT, all);
				this.startNew(TOPICS.find((t) => t.id === topicId) ?? TOPICS[0], topicId === "article" ? articlePath : undefined, review);
			};
		});

		el.createDiv({ cls: "el-row" }, (r) => {
			const b = r.createEl("button", { text: "AI 速度測試" });
			b.onclick = () => new SpeedTestModal(this.app, p).open();
			r.createSpan({ cls: "el-muted", text: "對話很慢時按這個，量看看是哪裡慢" });
		});

		// 之前的對話
		const convs = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(CONV_DIR + "/"))
			.map((f) => ({ f, fm: this.app.metadataCache.getFileCache(f)?.frontmatter ?? {} }))
			.filter((x) => x.fm.user === p.user)
			.sort((a, b) => (a.f.basename < b.f.basename ? 1 : -1))
			.slice(0, 20);
		if (convs.length) {
			el.createEl("h4", { text: "之前的對話" });
			for (const { f, fm } of convs) {
				const row = el.createDiv({ cls: "el-row el-card" });
				row.createSpan({ cls: "el-title", text: `${fm.topicLabel ?? fm.topic ?? ""}` });
				row.createSpan({ cls: "el-muted", text: f.basename });
				const open = row.createEl("button", { text: "查看" });
				open.onclick = () => this.app.workspace.getLeaf(true).openFile(f);
				if (fm.device === p.deviceId) {
					const cont = row.createEl("button", { text: "繼續聊", cls: "mod-cta" });
					cont.onclick = () => {
						this.primeAudio();
						this.resume(f, fm as unknown as ConvMeta, review);
					};
				}
			}
			el.createDiv({ cls: "el-muted", text: "只能在開始對話的裝置上繼續聊；在別台裝置請開新對話。" });
		}
	}

	// ---- 對話 ----
	private async loadArticle(path?: string): Promise<string> {
		if (!path) return "";
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return "";
		return stripMarks(stripFrontmatter(await this.app.vault.cachedRead(f))).trim().slice(0, 12000);
	}

	/** 挑這次要複習的生字與句子；已在這個對話中用對的標成完成。 */
	private async loadTargets(review: boolean, convPath: string) {
		this.targets = [];
		this.doneTargets = new Set();
		if (!review) return;
		try {
			const d = await loadPractice(this.app, this.plugin.user, this.level());
			for (const e of d.logs) if (e.type === "answer" && (e as AnswerLog).via === "chat" && (e as AnswerLog).session === convPath) this.doneTargets.add((e as AnswerLog).qid);
			this.targets = pickTargets(d.words, d.phrases, d.states);
		} catch (e) {
			this.plugin.debug(`chat targets failed: ${(e as Error)?.message ?? e}`);
		}
	}

	private activeTargets(): ChatTarget[] {
		return this.targets.filter((t) => !this.doneTargets.has(t.qid));
	}

	private async startNew(topic: Topic, articlePath?: string, review = true) {
		const p = this.plugin;
		if (!p.getApiKey()) return new Notice("尚未設定 API key");
		if (navigator.onLine === false) return new Notice("對話需要網路");
		this.topic = topic;
		this.article = await this.loadArticle(articlePath);
		const now = new Date();
		this.meta = { user: p.user, level: this.level(), topic: topic.id, topicLabel: topic.label, article: articlePath, device: p.deviceId, started: now.toISOString() };
		// conversations/<日期>-<裝置>-<序號>.md：由開始的裝置獨佔寫入
		const base = `${localDate(now)}-${p.deviceId}`;
		let n = 1;
		while (this.app.vault.getAbstractFileByPath(normalizePath(`${CONV_DIR}/${base}-${n}.md`))) n++;
		const path = normalizePath(`${CONV_DIR}/${base}-${n}.md`);
		if (!(await this.app.vault.adapter.exists(CONV_DIR))) await this.app.vault.createFolder(CONV_DIR).catch(() => undefined);
		this.file = await this.app.vault.create(path, convHeader(this.meta));
		const t0 = Date.now();
		await this.loadTargets(review, path);
		p.debug(`chat start: ${this.targets.length} review targets in ${Date.now() - t0} ms`);
		this.messages = [];
		this.phase = "chat";
		this.drawChat();
		await this.send(null); // AI 開場
	}

	private async resume(f: TFile, fm: ConvMeta, review = true) {
		this.meta = { ...fm, level: fm.level === "kid" ? "kid" : "adult" };
		this.topic = TOPICS.find((t) => t.id === fm.topic) ?? TOPICS[0];
		this.article = await this.loadArticle(fm.article);
		this.file = f;
		this.messages = parseConvMessages(await this.app.vault.read(f));
		await this.loadTargets(review, f.path);
		this.phase = "chat";
		this.drawChat();
		for (const m of this.messages) this.renderMessage(m);
	}

	private drawChat() {
		const el = this.root();
		const top = el.createDiv({ cls: "el-row el-top" });
		top.createSpan({ cls: "el-user-badge", text: `👤 ${this.plugin.user}` });
		top.createSpan({ cls: "el-badge", text: this.topic.label });
		const vt = top.createEl("button", { cls: "el-zh-btn", text: this.voice() === "off" ? "🔇" : "🔊", attr: { "aria-label": "自動朗讀開關" } });
		vt.onclick = () => {
			const next: ChatVoice = this.voice() === "off" ? this.lastVoiceOn() : "off";
			if (next === "off") {
				this.app.saveLocalStorage(LS_CHAT_VOICE_LAST, this.voice());
				this.stopVoice();
			}
			this.app.saveLocalStorage(LS_CHAT_VOICE, next);
			if (next !== "off") this.primeAudio();
			vt.setText(next === "off" ? "🔇" : "🔊");
			new Notice(next === "off" ? "AI 回覆不自動朗讀" : `AI 回覆自動朗讀（${next === "system" ? "系統語音" : "自然語音"}）`);
		};
		const end = top.createEl("a", { text: "結束對話", cls: "el-quit" });
		end.onclick = () => this.end();
		this.targetsEl = el.createDiv({ cls: "el-chat-targets" });
		this.drawTargets();

		this.listEl = el.createDiv({ cls: "el-chat-list" });
		const bar = el.createDiv({ cls: "el-chat-input" });
		const ta = bar.createEl("textarea", { attr: { rows: "2", placeholder: "用英文說，或打中文問「…怎麼說」" } });
		const mic = bar.createEl("button", { text: "🎤", cls: "el-mic", attr: { "aria-label": "用說的" } });
		const send = bar.createEl("button", { text: "送出", cls: "mod-cta" });
		send.onclick = () => {
			const t = ta.value.trim();
			if (!t || this.sending) return;
			this.primeAudio();
			ta.value = "";
			this.send(t);
		};
		const recInfo = el.createDiv({ cls: "el-muted el-rec-info" });
		let tick: ReturnType<typeof setInterval> | null = null;
		const resetMic = () => {
			if (tick) clearInterval(tick);
			tick = null;
			mic.setText("🎤");
			mic.removeClass("is-recording");
			recInfo.empty();
			ta.disabled = send.disabled = false;
		};
		const finish = async (cancel = false) => {
			const rec = this.recorder;
			if (!rec) return;
			this.recorder = null;
			resetMic();
			if (cancel) return rec.cancel();
			const { wav, seconds } = await rec.stop();
			if (seconds < 0.5) return void new Notice("沒有錄到聲音，再試一次");
			await this.sendVoice(wav);
		};
		mic.onclick = async () => {
			if (this.recorder) {
				this.primeAudio(); // 說完按停止：在點擊裡解鎖朗讀
				return finish();
			}
			if (this.sending) return;
			if (!recordingSupported()) return void new Notice("這台裝置不能錄音，請用打字");
			this.stopVoice();
			const rec = new WavRecorder();
			rec.onAutoStop = () => void finish();
			try {
				await rec.start();
			} catch (e) {
				return void new Notice(`無法使用麥克風：${(e as Error)?.message ?? e}`);
			}
			this.recorder = rec;
			mic.setText("■ 說完了");
			mic.addClass("is-recording");
			ta.disabled = send.disabled = true;
			const t0 = Date.now();
			recInfo.empty();
			const label = recInfo.createSpan({ text: "錄音中… 0 秒（可以英文夾中文；最長 60 秒） " });
			const x = recInfo.createEl("a", { text: "取消" });
			x.onclick = () => void finish(true);
			tick = setInterval(() => label.setText(`錄音中… ${Math.round((Date.now() - t0) / 1000)} 秒（可以英文夾中文；最長 60 秒） `), 1000);
		};
		ta.addEventListener("keydown", (e) => {
			// 電腦上 Enter 送出、Shift+Enter 換行（iPad 的螢幕鍵盤用送出鈕）
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				send.click();
			}
		});
	}

	/** 這次複習的目標：用對的打勾；點一下看中文。 */
	private drawTargets() {
		const el = this.targetsEl;
		if (!el) return;
		el.empty();
		if (!this.targets.length) return;
		el.createSpan({ cls: "el-muted", text: "🎯 這次會複習：" });
		for (const t of this.targets) {
			const done = this.doneTargets.has(t.qid);
			const chip = el.createSpan({ cls: `el-target-chip${done ? " is-done" : ""}${t.kind === "phrase" ? " is-phrase" : ""}`, text: `${done ? "✓ " : ""}${t.kind === "word" ? t.en : t.zh || t.en}` });
			chip.onclick = () => new Notice(`${t.en}${t.zh ? `\n${t.zh}` : ""}${t.forms.length ? `\n（也包含：${t.forms.join("、")}）` : ""}`, 8000);
		}
	}

	/** 學習者在對話中用對了目標：記一筆複習。 */
	private async recordUsed(learnerText: string, rawReply: string, corrected: boolean) {
		const active = this.activeTargets();
		if (!active.length || !this.file) return;
		const used = usedTargets(active, learnerText, parseLearnerUsed(rawReply), corrected);
		if (!used.length) return;
		const p = this.plugin;
		for (const t of used) {
			this.doneTargets.add(t.qid);
			await p.appendLog(
				p.makeEntry("answer", { qid: t.qid, bank: "words", qtype: t.kind === "word" ? "word" : "phrase", session: this.file.path, correct: true, via: "chat" }),
			);
		}
		this.listEl?.createDiv({ cls: "el-chat-reviewed", text: `✓ 複習到：${used.map((t) => (t.kind === "word" ? t.en : t.zh || t.en)).join("、")}` });
		this.drawTargets();
	}

	private async send(text: string | null) {
		const p = this.plugin;
		if (!this.meta || !this.file) return;
		if (text !== null) {
			const um: ConvMessage = { role: "user", text, ts: new Date().toISOString() };
			this.messages.push(um);
			this.renderMessage(um);
			// 寫檔不用等（寫入佇列會照順序），先送給 AI
			p.appendText(this.file, convBlock(um)).catch((e) => p.debug(`chat append failed: ${(e as Error)?.message ?? e}`));
		}
		await this.ask(historyTurns(this.messages), text, null);
	}

	/** 語音訊息：錄音直接送給 AI，AI 聽寫（heard）後照平常回覆，只呼叫一次。 */
	private async sendVoice(wav: ArrayBuffer) {
		if (!this.meta || !this.file || this.sending) return;
		const bubble = this.listEl?.createDiv({ cls: "el-bubble el-bubble-user is-voice", text: "🎤 語音訊息…" }) ?? null;
		bubble?.scrollIntoView({ block: "end" });
		const turns: ChatTurn[] = historyTurns(this.messages);
		const audio = { mimeType: "audio/wav", data: arrayBufferToBase64(wav) };
		const last = turns[turns.length - 1];
		if (last?.role === "user") {
			last.text += `\n${VOICE_TURN}`;
			last.media = [...(last.media ?? []), audio];
		} else turns.push({ role: "user", text: VOICE_TURN, media: [audio] });
		await this.ask(turns, null, bubble, Math.round((wav.byteLength - 44) / 32000));
	}

	private async ask(turns: ChatTurn[], typed: string | null, voiceBubble: HTMLElement | null, voiceSeconds = 0) {
		const p = this.plugin;
		if (!this.meta || !this.file) return;
		const file = this.file;
		this.sending = true;
		const t0 = Date.now();
		const label = voiceBubble ? "AI 聽你說…" : "AI 輸入中…";
		const typing = this.listEl?.createDiv({ cls: "el-chat-typing", text: label });
		typing?.scrollIntoView({ block: "end" });
		const tick = setInterval(() => {
			const sec = Math.round((Date.now() - t0) / 1000);
			if (sec >= 3) typing?.setText(`${label}（${sec} 秒）`);
		}, 1000);
		try {
			const res = await p.fastBackend().chat(turns, {
				system: chatSystemPrompt(this.meta.level, this.topic, this.article || undefined) + targetsPrompt(this.activeTargets(), this.meta.level),
				json: true,
				maxOutputTokens: 1024,
				temperature: 0.9,
				hedgeAfterMs: voiceBubble ? HEDGE_MS + 4000 : HEDGE_MS,
				timeoutMs: TIMEOUT_MS,
			});
			const ms = Date.now() - t0;
			typing?.remove();
			let learnerText = typed;
			if (voiceBubble) {
				const heard = parseHeard(res.text);
				if (!heard) {
					voiceBubble.setText("🎤 沒聽清楚，請再說一次（或改用打字）");
					voiceBubble.addClass("is-failed");
					return;
				}
				voiceBubble.setText(`🎤 ${heard}`);
				const um: ConvMessage = { role: "user", text: heard, ts: new Date(t0).toISOString(), voice: true };
				this.messages.push(um);
				p.appendText(file, convBlock(um)).catch(() => undefined);
				learnerText = heard;
			}
			const mm: ConvMessage = { role: "model", text: res.text, ts: new Date().toISOString() };
			this.messages.push(mm);
			const reply = parseReply(res.text);
			this.renderMessage(mm, reply);
			this.speakReply(reply.reply);
			await p.appendText(file, convBlock(mm));
			await this.savePhrases(reply);
			if (learnerText !== null) await this.recordUsed(learnerText, res.text, !!reply.correction);
			p.appendLog(p.makeEntry("api", { ok: true, purpose: "chat", model: res.model, usage: res.usage, ms, ...(voiceBubble ? { voice: true, seconds: voiceSeconds } : {}) })).catch(() => undefined);
			if (ms > 8000) p.debug(`chat slow: ${ms} ms (in ${res.usage.inputTokens ?? "?"} / out ${res.usage.outputTokens ?? "?"} tokens${voiceBubble ? ", voice" : ""})`);
		} catch (e) {
			typing?.setText(`AI 沒有回應：${(e as Error)?.message ?? e}（${voiceBubble ? "請再說一次" : "可以再送一次"}）`);
			if (voiceBubble) {
				voiceBubble.setText("🎤（沒有送出）");
				voiceBubble.addClass("is-failed");
			}
			const body = e instanceof AIError && e.body ? ` ${e.body.replace(/\s+/g, " ").slice(0, 300)}` : "";
			p.debug(`chat failed after ${Date.now() - t0} ms: ${(e as Error)?.message ?? e}${body}`);
		} finally {
			clearInterval(tick);
			this.sending = false;
		}
	}

	// ---- 朗讀 ----
	private voice(): ChatVoice {
		const v = this.app.loadLocalStorage(LS_CHAT_VOICE);
		return v === "system" || v === "off" ? v : "natural"; // 預設用 Gemini 自然語音
	}

	private lastVoiceOn(): ChatVoice {
		return this.app.loadLocalStorage(LS_CHAT_VOICE_LAST) === "system" ? "system" : "natural";
	}

	/** 必須在點擊事件裡同步呼叫：iOS 之後才允許自動播放。 */
	private primeAudio() {
		if (this.voice() === "off") return;
		this.stopVoice();
		unlockAudio();
		primeSpeech();
	}

	private stopVoice() {
		this.speechGen++;
		stopSpeaking();
		stopAudio();
	}

	/** 唸一句英文（自動朗讀與 🔊 共用）。手動按 🔊 時，即使關了自動朗讀也會用系統語音唸。 */
	private speakText(text: string, manual = false) {
		const v = this.voice();
		const system = () => speak(this.app, text).catch((e) => this.plugin.debug(`chat speak failed: ${(e as Error)?.message ?? e}`));
		if (v === "natural") {
			const gen = this.speechGen;
			const stopped = () => this.speechGen !== gen;
			// 第一句先產生先播；拿不到自然語音（額度、網路）就改用系統語音
			this.plugin.pronouncer
				.speakNatural(text, stopped)
				.then((ok) => {
					if (!ok && !stopped()) void system();
				})
				.catch(() => !stopped() && void system());
		} else if (v === "system" || manual) void system();
	}

	private speakReply(text: string) {
		if (!text || this.voice() === "off") return;
		try {
			this.speakText(text);
		} catch (e) {
			this.plugin.debug(`chat speak failed: ${(e as Error)?.message ?? e}`); // 朗讀失敗不影響對話
		}
	}

	/** 糾正與「怎麼說」都記進句子本（同一句不重複）。 */
	private async savePhrases(r: ChatReply) {
		const p = this.plugin;
		const conv = this.file?.path;
		if (r.correction && r.correction.zh) {
			const c = r.correction;
			await p.addPhrase({ key: phraseKey(c.corrected), zh: c.zh, en: c.corrected, note: c.explanation, source: "correction", original: c.original, conv });
		}
		for (const h of r.howto) await p.addPhrase({ key: phraseKey(h.en), zh: h.zh, en: h.en, alt: h.alt, note: h.note, source: "howto", conv });
	}

	private renderMessage(m: ConvMessage, reply?: ChatReply) {
		const list = this.listEl;
		if (!list) return;
		if (m.role === "user") {
			list.createDiv({ cls: `el-bubble el-bubble-user${m.voice ? " is-voice" : ""}`, text: m.voice ? `🎤 ${m.text}` : m.text });
		} else {
			const r = reply ?? parseReply(m.text);
			if (r.correction) {
				const box = list.createDiv({ cls: "el-chat-box el-chat-fix" });
				box.createDiv({ cls: "el-chat-box-title", text: "✏️ 修正（已記入句子本）" });
				box.createDiv({ cls: "el-d-typed", text: r.correction.original });
				this.englishLine(box, r.correction.corrected);
				if (r.correction.explanation) box.createDiv({ cls: "el-muted", text: r.correction.explanation });
			}
			for (const h of r.howto) {
				const box = list.createDiv({ cls: "el-chat-box el-chat-tip" });
				box.createDiv({ cls: "el-chat-box-title", text: `💡 怎麼說：${h.zh}（已記入句子本）` });
				this.englishLine(box, h.en);
				if (h.alt) this.englishLine(box, h.alt);
				if (h.note) box.createDiv({ cls: "el-muted", text: h.note });
			}
			const b = list.createDiv({ cls: "el-bubble el-bubble-ai" });
			this.englishLine(b, r.reply, r.replyZh, true);
		}
		list.lastElementChild?.scrollIntoView({ block: "end" });
	}

	/** 英文：逐字可點（唸、看中文、加入生字本）、🔊 唸整句、「中」看翻譯。 */
	private englishLine(parent: HTMLElement, text: string, zh?: string, markTargets = false) {
		const targetWords = markTargets ? this.activeTargets().filter((t) => t.kind === "word") : [];
		const wrap = parent.createDiv({ cls: "el-line-wrap" });
		const line = wrap.createDiv({ cls: "el-line" });
		const words = line.createSpan({ cls: "el-words" });
		for (const tok of text.split(/(\s+)/)) {
			const m = tok.match(/^([^A-Za-z]*)([A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z])(.*)$/);
			if (!m) {
				words.appendChild(document.createTextNode(tok));
				continue;
			}
			if (m[1]) words.appendChild(document.createTextNode(m[1]));
			const w = words.createSpan({ cls: "el-w", text: m[2] });
			if (targetWords.some((t) => !t.en.includes(" ") && mentionsWord(m[2], t))) w.addClass("el-target-word"); // AI 用到了複習的字
			w.onclick = (e) => this.wordMenu(e, m[2], text);
			if (m[3]) words.appendChild(document.createTextNode(m[3]));
		}
		const say = line.createEl("button", { cls: "el-zh-btn", text: "🔊" });
		say.onclick = (e) => {
			e.stopPropagation();
			unlockAudio();
			this.stopVoice();
			this.speakText(text, true);
		};
		const zhBtn = line.createEl("button", { cls: "el-zh-btn", text: "中" });
		const box = wrap.createDiv({ cls: "el-zh" });
		box.style.display = "none";
		zhBtn.onclick = async (e) => {
			e.stopPropagation();
			if (box.style.display !== "none") {
				box.style.display = "none";
				return;
			}
			box.style.display = "";
			box.setText(zh ?? cachedZh(this.app, text) ?? "翻譯中…");
			if (!zh && !cachedZh(this.app, text)) {
				try {
					box.setText((await translateMany(this.app, this.plugin.fastBackend(), [text]))[0]);
				} catch (err) {
					box.setText(`無法翻譯：${(err as Error)?.message ?? err}`);
				}
			}
		};
	}

	private wordMenu(evt: MouseEvent, word: string, sentence: string) {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(`🔊 唸 ${word}`).onClick(() => this.plugin.say(word)));
		menu.addItem((i) =>
			i.setTitle("看中文意思").onClick(async () => {
				try {
					new Notice(`${word}：${cachedZh(this.app, word) ?? (await translateMany(this.app, this.plugin.fastBackend(), [word]))[0]}`, 8000);
				} catch (e) {
					new Notice(`無法翻譯：${(e as Error)?.message ?? e}`);
				}
			}),
		);
		menu.addItem((i) => i.setTitle("＋ 加入生字本").onClick(() => this.plugin.addWord(word, sentence)));
		menu.showAtMouseEvent(evt);
	}

	async onClose() {
		this.recorder?.cancel();
		this.recorder = null;
		this.stopVoice();
	}

	private end() {
		this.recorder?.cancel();
		this.recorder = null;
		this.stopVoice();
		const fixes = this.messages.filter((m) => m.role === "model").map((m) => parseReply(m.text));
		const nFix = fixes.filter((r) => r.correction).length;
		const nHow = fixes.reduce((n, r) => n + r.howto.length, 0);
		const nRev = this.targets.filter((t) => this.doneTargets.has(t.qid)).length;
		new Notice(`對話結束：糾正 ${nFix} 句、學了 ${nHow} 個說法，都已記進句子本。${this.targets.length ? `複習到 ${nRev}／${this.targets.length} 個生字和句子。` : ""}`, 6000);
		this.phase = "start";
		this.meta = null;
		this.file = null;
		this.messages = [];
		this.targets = [];
		this.doneTargets = new Set();
		this.drawStart();
		this.plugin.triggerSync(true);
	}
}
