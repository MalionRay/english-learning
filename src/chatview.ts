// 對話畫面（英文、西班牙文、日文）
import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import type EnglishLearningPlugin from "./main";
import type { Level } from "./generate";
import { stripMarks } from "./generate";
import { listSources, stripFrontmatter } from "./sources";
import { cachedZh, inlineMeaning, prefetchMeanings, translateMany } from "./translate";
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

import { parseHeard, voiceTurn } from "./chat";
import { LANG, Lang, langOf, personaName, tokenize } from "./lang";
import { langSelect } from "./langview";
import { WavRecorder, arrayBufferToBase64, recordingSupported } from "./recorder";
import { primeSpeech, speak, stopSpeaking, voicePicker } from "./tts";
import { stopAudio, unlockAudio } from "./pronounce";
import { AIError } from "./ai";
import type { ChatTurn } from "./ai";
import { SpeedTestModal } from "./speedtest";
import { ChatTarget, mentionsWord, parseLearnerUsed, pickTargets, targetsPrompt, usedTargets } from "./chattargets";
import { loadPractice } from "./practice";
import { ChatLevel, LEVEL_LABEL, estimateChatLevel, levelPrompt } from "./chatlevel";
import type { AnswerLog } from "./srs";
import { MEMORY_DIR, MEMORY_MAX, MemItem, memDay, memoryPrompt } from "./memory";

export const CHAT_VIEW = "english-learning-chat";
const LS_CHAT = "english-learning:chat"; // { [user]: { topic, article, review } }
/** AI 回覆的朗讀方式（每台裝置各自設定）：natural＝Gemini 自然語音（預設）、system＝系統語音、off＝不自動朗讀。 */
export const LS_CHAT_VOICE = "english-learning:chat-voice";
const LS_CHAT_VOICE_LAST = "english-learning:chat-voice-last";
export type ChatVoice = "system" | "natural" | "off";
const HEDGE_MS = 8000; // 超過 8 秒沒回應就再送一次
const TIMEOUT_MS = 45000;
/** 開新對話時，上一個對話的記憶還在整理：最多等這麼久（等得到的話這次就用得上）。 */
export const MEMORY_WAIT_MS = 8000;
/** 結束對話後等記憶整理完再同步，最多等這麼久（超過就先同步，記憶下次同步再上傳）。 */
export const MEMORY_SYNC_WAIT_MS = 15000;

/** 輸入法正在選字（注音、日文）：這時候的 Enter 是「確定選字」，不是送出。Safari 選字的 Enter 沒有 isComposing，但 keyCode 是 229。 */
export function composing(e: KeyboardEvent): boolean {
	return e.isComposing || e.keyCode === 229;
}

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
	private pastMessages: ConvMessage[] = []; // 這位使用者最近幾次對話的訊息（估程度用）
	private levelEl: HTMLElement | null = null;
	private lastLevel: ChatLevel | null = null;
	private starting = false; // 正在開新對話（防止連點）
	private reqSeq = 0; // 送給 AI 的請求編號（結束對話時加一，還沒回來的回覆就作廢）
	private memItems: MemItem[] = []; // 這次對話帶著的記憶（開始或續聊時讀一次，聊到一半不換）
	private memEl: HTMLElement | null = null; // 開始畫面的「記得的事」
	private memOpen = false; // 清單有沒有展開（重畫時留著）
	private memTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: EnglishLearningPlugin) {
		super(leaf);
	}
	getViewType() {
		return CHAT_VIEW;
	}
	getDisplayText() {
		return "外語對話";
	}
	getIcon() {
		return "messages-square";
	}
	async onOpen() {
		// 記憶整理完、或別台裝置的記憶同步過來：開始畫面的「記得的事」重畫
		this.register(this.plugin.memory.onChange(() => void this.drawMemory()));
		const changed = (f: { path: string }) => {
			if (!f.path.startsWith(MEMORY_DIR + "/") || this.phase !== "start") return;
			if (this.memTimer) window.clearTimeout(this.memTimer);
			this.memTimer = window.setTimeout(() => void this.drawMemory(), 500);
		};
		this.registerEvent(this.app.vault.on("create", changed));
		this.registerEvent(this.app.vault.on("modify", changed));
		this.register(() => this.memTimer && window.clearTimeout(this.memTimer));
		this.render();
	}

	render() {
		if (this.phase === "start") this.drawStart();
	}

	private level(): Level {
		return this.plugin.levelOf(this.plugin.user);
	}

	/**
	 * 這個對話是誰的（開始時記在對話檔）。聊到一半在別的分頁換了使用者，
	 * 複習紀錄、加入句子本、生字本還是要記在開始對話的那個人身上。
	 */
	private cuser(): string {
		return this.meta?.user || this.plugin.user;
	}

	/** 這次對話的語言：續聊用對話檔記的語言，新對話用目前選的語言。 */
	private clang(): Lang {
		return this.meta ? langOf(this.meta.lang) : this.plugin.lang;
	}

	private root(): HTMLElement {
		const el = this.contentEl;
		el.empty();
		this.memEl = null; // 「記得的事」跟著畫面一起清掉（開始畫面會再建立）
		el.addClass("el-verify");
		el.addClass("el-practice");
		el.addClass("el-chat");
		return el;
	}

	// ---- 開始畫面 ----
	private drawStart() {
		const p = this.plugin;
		const el = this.root();
		const L = LANG[p.lang].name;
		el.createEl("h3", { text: `${L}對話` });
		el.createDiv({
			cls: "el-muted",
			text: `和 ${personaName(p.lang, this.level())} 用${L}聊天；說錯會即時糾正。不會說的可以直接打中文問「…${L}怎麼說」。${p.lang === "ja" ? "可以打假名、漢字或羅馬拼音；AI 的回覆下面會有平假名和羅馬拼音。" : ""}糾正過的句子和問過的說法會記進「句子本」，之後在練習裡複習。到期的生字和句子會在聊天中自然出現，你用對了就算複習。`,
		});
		const prefs = ((this.app.loadLocalStorage(LS_CHAT) ?? {}) as Record<string, { topic?: string; article?: string; review?: boolean }>)[p.user] ?? {};

		el.createDiv({ cls: "el-row" }, (r) => {
			r.createSpan({ text: "使用者" });
			const sel = r.createEl("select", { cls: "dropdown" });
			for (const u of p.userNames()) sel.createEl("option", { text: u, value: u });
			sel.value = p.user;
			sel.onchange = () => {
				p.user = sel.value;
				this.drawStart();
			};
			langSelect(r, p);
		});
		let topicId = prefs.topic ?? (p.levelOf(p.user) === "kid" ? "school" : "free");
		let articlePath = prefs.article ?? "";
		let review = prefs.review !== false;
		// 選的情境、文章、要不要複習：一改就存（這個畫面會因為同步、換設定而重畫，選好的不能跳回去）
		const user = p.user;
		const save = () => {
			const all = (this.app.loadLocalStorage(LS_CHAT) ?? {}) as Record<string, unknown>;
			all[user] = { topic: topicId, article: articlePath, review };
			this.app.saveLocalStorage(LS_CHAT, all);
		};
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
				a.onchange = () => {
					articlePath = a.value;
					save();
				};
			};
			sel.onchange = () => {
				topicId = sel.value;
				drawArt();
				save();
			};
			drawArt();
		});
		// 讓文章選單出現在情境下面
		el.appendChild(artRow);
		el.createDiv({ cls: "el-row" }, (r) => {
			r.createSpan({ text: "AI 回覆朗讀" });
			const sel = r.createEl("select", { cls: "dropdown" });
			sel.createEl("option", { text: "自然語音（Google Cloud／Gemini）", value: "natural" });
			sel.createEl("option", { text: "系統語音（立即、不用額度）", value: "system" });
			sel.createEl("option", { text: "不自動朗讀", value: "off" });
			sel.value = this.voice();
			sel.onchange = () => this.app.saveLocalStorage(LS_CHAT_VOICE, sel.value);
		});
		el.createDiv({ cls: "el-row" }, (r) => {
			r.createSpan({ text: "系統語音" });
			voicePicker(this.app, r, undefined, p.lang);
			r.createSpan({ cls: "el-muted", text: "自然語音用完或選「系統語音」時用這個聲音" });
		});
		el.createEl("label", { cls: "el-row" }, (r) => {
			const box = r.createEl("input", { type: "checkbox" });
			box.checked = review;
			box.onchange = () => {
				review = box.checked;
				save();
			};
			r.createSpan({ text: "聊天中自然複習到期的生字和句子（用對了就算複習一次）" });
		});
		// 跨對話記憶：開關、記得的事（可以一條一條刪）；沒按「結束對話」就離開的在這裡補整理
		this.memEl = el.createDiv({ cls: "el-memory" });
		void this.drawMemory();
		if (p.remembers(p.user)) void p.memory.catchUp(p.user, p.lang);

		el.createDiv({ cls: "el-row el-big-buttons" }, (r) => {
			const go = r.createEl("button", { text: "開始對話", cls: "mod-cta" });
			go.onclick = () => {
				this.primeAudio(); // 在點擊裡解鎖朗讀（iOS）
				save();
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
			.filter((x) => String(x.fm.user ?? "") === p.user && langOf(x.fm.lang) === p.lang)
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

	// ---- 跨對話記憶 ----
	/** 開始畫面的「記得的事」：開關、清單（可以一條一條刪）、全部忘記。 */
	private async drawMemory() {
		const box = this.memEl;
		const p = this.plugin;
		if (!box || this.phase !== "start") return;
		const user = p.user;
		const lang = p.lang;
		let items: MemItem[] = [];
		try {
			items = await p.memory.list(user, lang);
		} catch (e) {
			p.debug(`chat memory list failed: ${(e as Error)?.message ?? e}`);
		}
		// 讀的時候畫面已經換了（開始對話、換了使用者或語言）：不畫
		if (this.memEl !== box || this.phase !== "start" || p.user !== user || p.lang !== lang) return;
		box.empty();
		const who = personaName(lang, p.levelOf(user));
		const on = p.remembers(user);
		box.createEl("label", { cls: "el-row" }, (r) => {
			const c = r.createEl("input", { type: "checkbox" });
			c.checked = on;
			c.onchange = async () => {
				c.disabled = true;
				try {
					await p.setRemember(user, c.checked);
					new Notice(c.checked ? `${who} 會記得之後聊過的事` : `${who} 不會再記新的事，聊天時也不會用到以前記的`, 6000);
				} catch (e) {
					new Notice(`沒存到：${(e as Error)?.message ?? e}`);
				}
				void this.drawMemory();
			};
			r.createSpan({ text: `讓 ${who} 記得以前聊過的事（聊完把重點整理成幾條，下次自然提起）` });
		});
		if (!on && !items.length) return;
		const det = box.createEl("details", { cls: "el-mem" });
		det.open = this.memOpen;
		det.addEventListener("toggle", () => (this.memOpen = det.open));
		det.createEl("summary", { text: `🧠 ${who} 記得的事（${items.length}）${on && p.memory.busy ? "・整理中…" : ""}` });
		if (!items.length)
			det.createDiv({ cls: "el-muted", text: `還沒有。聊完按「結束對話」，${who} 會把這次聊到的重點記下來；沒按就離開的，下次打開這個畫面時會補整理。` });
		for (const m of items) {
			det.createDiv({ cls: "el-mem-item" }, (row) => {
				row.createSpan({ cls: "el-mem-text", text: m.text });
				row.createSpan({ cls: "el-muted el-mem-day", text: memDay(m.at).slice(5).replace("-", "/") });
				const x = row.createEl("button", { cls: "el-zh-btn", text: "✕", attr: { "aria-label": "忘記這一條" } });
				x.onclick = () => {
					x.disabled = true;
					void this.forget(user, lang, [m.key]);
				};
			});
		}
		if (items.length > 1) {
			det.createDiv({ cls: "el-row" }, (r) => {
				const all = r.createEl("button", { text: "全部忘記" });
				let armed = 0;
				all.onclick = () => {
					if (!armed) {
						// 第一下只是確認，4 秒內再按一次才真的刪
						all.setText(`確定忘記這 ${items.length} 條？再按一次`);
						all.addClass("mod-warning");
						armed = window.setTimeout(() => {
							armed = 0;
							all.setText("全部忘記");
							all.removeClass("mod-warning");
						}, 4000);
						return;
					}
					window.clearTimeout(armed);
					all.disabled = true;
					void this.forget(
						user,
						lang,
						items.map((m) => m.key),
					);
				};
			});
		}
		det.createDiv({
			cls: "el-muted",
			text: on
				? `這是${LANG[lang].name}對話的記憶（每種語言各記各的），最多 ${MEMORY_MAX} 條；過時或重複的，之後整理時會自己更新。`
				: "已關閉：不會再記新的，聊天時也不會用到。上面是以前記下來的，不想留可以刪掉。",
		});
	}

	private async forget(user: string, lang: Lang, keys: string[]) {
		try {
			await this.plugin.memory.forget(user, lang, keys);
		} catch (e) {
			new Notice(`沒刪到：${(e as Error)?.message ?? e}`);
		}
		void this.drawMemory();
	}

	/**
	 * 這次對話要帶著的記憶（這位使用者、這個語言的）。
	 * wait：上一個對話還在整理時先等一下（最多 MEMORY_WAIT_MS），整理好的重點這次就用得上。
	 */
	private async loadMemories(wait: boolean) {
		const p = this.plugin;
		this.memItems = [];
		const file = this.file;
		const user = this.cuser();
		const lang = this.clang();
		if (!p.remembers(user)) return;
		try {
			if (wait && p.memory.busy) {
				const note = this.listEl?.createDiv({ cls: "el-chat-typing", text: "整理上次聊天的重點…" });
				await p.memory.settle(MEMORY_WAIT_MS);
				note?.remove();
			}
			const items = await p.memory.list(user, lang);
			if (this.file === file) this.memItems = items; // 等的時候對話已經結束或換了一個：不要蓋到別的對話
		} catch (e) {
			p.debug(`chat memory load failed: ${(e as Error)?.message ?? e}`);
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
			const d = await loadPractice(this.app, this.cuser(), this.meta?.level ?? this.level(), this.clang());
			for (const e of d.logs) if (e.type === "answer" && (e as AnswerLog).via === "chat" && (e as AnswerLog).session === convPath) this.doneTargets.add((e as AnswerLog).qid);
			this.targets = pickTargets(d.words, d.phrases, d.states);
		} catch (e) {
			this.plugin.debug(`chat targets failed: ${(e as Error)?.message ?? e}`);
		}
	}

	/** 這位使用者最近 3 次對話（不含這次）的訊息：新對話一開始就用上次的程度，不用從頭估。 */
	private async loadPastMessages(exclude: string) {
		this.pastMessages = [];
		try {
			const files = this.app.vault
				.getMarkdownFiles()
				.filter((f) => f.path.startsWith(CONV_DIR + "/") && f.path !== exclude)
				.map((f) => ({ f, fm: this.app.metadataCache.getFileCache(f)?.frontmatter ?? {} }))
				.filter((x) => String(x.fm.user ?? "") === this.cuser() && langOf(x.fm.lang) === this.clang())
				.sort((a, b) => (String(a.fm.started ?? a.f.basename) < String(b.fm.started ?? b.f.basename) ? 1 : -1))
				.slice(0, 3)
				.reverse();
			for (const { f } of files) this.pastMessages.push(...parseConvMessages(await this.app.vault.cachedRead(f)));
			this.pastMessages = this.pastMessages.slice(-40);
		} catch (e) {
			this.plugin.debug(`chat past messages failed: ${(e as Error)?.message ?? e}`);
		}
	}

	private levelEstimate() {
		return estimateChatLevel([...this.pastMessages, ...this.messages], this.meta?.level ?? this.level(), 10, this.clang());
	}

	private drawLevel() {
		if (!this.levelEl) return;
		const est = this.levelEstimate();
		this.levelEl.setText(`程度：${LEVEL_LABEL[est.level]}`);
		this.levelEl.setAttribute("aria-label", "AI 依你最近的句子自動調整說話難度");
		if (this.lastLevel !== null && this.lastLevel !== est.level)
			this.plugin.debug(`chat level ${this.lastLevel} → ${est.level} (fluency ${est.fluency.toFixed(2)}, ${est.samples} msgs, avg ${est.avgWords.toFixed(1)} words)`);
		this.lastLevel = est.level;
	}

	private activeTargets(): ChatTarget[] {
		return this.targets.filter((t) => !this.doneTargets.has(t.qid));
	}

	private async startNew(topic: Topic, articlePath?: string, review = true) {
		const p = this.plugin;
		if (!p.getApiKey()) return new Notice("尚未設定 API key");
		if (navigator.onLine === false) return new Notice("對話需要網路");
		if (this.starting) return; // 連點兩下只開一個對話
		this.starting = true;
		try {
			this.topic = topic;
			this.article = await this.loadArticle(articlePath);
			const now = new Date();
			const lang = p.lang;
			const meta: ConvMeta = { user: p.user, level: this.level(), ...(lang !== "en" ? { lang } : {}), topic: topic.id, topicLabel: topic.label, article: articlePath, device: p.deviceId, started: now.toISOString() };
			// conversations/<日期>-<裝置>-<序號>.md：由開始的裝置獨佔寫入
			const base = `${localDate(now)}-${p.deviceId}`;
			const pathOf = (k: number) => normalizePath(`${CONV_DIR}/${base}-${k}.md`);
			let n = 1;
			// 檔案可能已經在磁碟上、但還沒進 Obsidian 的索引（剛同步下來）：兩邊都看
			while (this.app.vault.getAbstractFileByPath(pathOf(n)) || (await this.app.vault.adapter.exists(pathOf(n)))) n++;
			const path = pathOf(n);
			if (!(await this.app.vault.adapter.exists(CONV_DIR))) await this.app.vault.createFolder(CONV_DIR).catch(() => undefined);
			const file = await this.app.vault.create(path, convHeader(meta));
			this.meta = meta;
			this.file = file;
			const t0 = Date.now();
			await Promise.all([this.loadTargets(review, path), this.loadPastMessages(path)]);
			p.debug(`chat start: ${this.targets.length} review targets in ${Date.now() - t0} ms`);
			this.messages = [];
			this.lastLevel = null;
			this.phase = "chat";
			this.drawChat();
		} catch (e) {
			new Notice(`無法開始對話：${(e as Error)?.message ?? e}`, 8000);
			p.debug(`chat start failed: ${(e as Error)?.message ?? e}`);
			return;
		} finally {
			this.starting = false;
		}
		const file = this.file;
		this.sending = true; // 等記憶、等開場的時候先不讓送出（開場回來後 ask 會放開）
		await this.loadMemories(true);
		if (this.file !== file) return; // 等記憶的時候這個對話已經結束（或又開了別的）
		await this.send(null); // AI 開場
	}

	private async resume(f: TFile, fm: ConvMeta, review = true) {
		if (this.starting) return; // 正在開另一個對話（連點、或同時按了「開始對話」）
		this.starting = true;
		try {
			// 名字像數字時 frontmatter 會被讀成數字：一律轉成文字
			this.meta = { ...fm, user: String(fm.user ?? this.plugin.user), level: fm.level === "kid" ? "kid" : "adult", lang: langOf(fm.lang) };
			this.topic = TOPICS.find((t) => t.id === fm.topic) ?? TOPICS[0];
			this.article = await this.loadArticle(fm.article);
			this.file = f;
			this.messages = parseConvMessages(await this.app.vault.read(f));
			await Promise.all([this.loadTargets(review, f.path), this.loadPastMessages(f.path), this.loadMemories(false)]);
			this.lastLevel = null;
			this.phase = "chat";
			this.drawChat();
			for (const m of this.messages) this.renderMessage(m);
		} catch (e) {
			this.meta = null;
			this.file = null;
			new Notice(`無法打開這個對話：${(e as Error)?.message ?? e}`, 8000);
			this.plugin.debug(`chat resume failed: ${(e as Error)?.message ?? e}`);
		} finally {
			this.starting = false;
		}
	}

	private drawChat() {
		const el = this.root();
		const top = el.createDiv({ cls: "el-row el-top" });
		top.createSpan({ cls: "el-user-badge", text: `👤 ${this.cuser()}` });
		top.createSpan({ cls: "el-badge", text: this.topic.label });
		this.levelEl = top.createSpan({ cls: "el-badge el-level-badge" });
		this.levelEl.onclick = () => {
			const est = this.levelEstimate();
			new Notice(`AI 說話難度：${LEVEL_LABEL[est.level]}（${est.level}/${this.meta?.level === "kid" ? 4 : 5}）\n依你最近的句子自動調整：錯得多就說短一點、簡單一點；越來越少錯就越來越像平常聊天。`, 8000);
		};
		this.drawLevel();
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
		const L = LANG[this.clang()].name;
		const ta = bar.createEl("textarea", { attr: { rows: "2", placeholder: this.clang() === "ja" ? "用日文說（假名、漢字或羅馬拼音），或打中文問「…怎麼說」" : `用${L}說，或打中文問「…怎麼說」` } });
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
			const label = recInfo.createSpan({ text: `錄音中… 0 秒（可以${L}夾中文；最長 60 秒） ` });
			const x = recInfo.createEl("a", { text: "取消" });
			x.onclick = () => void finish(true);
			tick = setInterval(() => label.setText(`錄音中… ${Math.round((Date.now() - t0) / 1000)} 秒（可以${L}夾中文；最長 60 秒） `), 1000);
		};
		ta.addEventListener("keydown", (e) => {
			// 電腦上 Enter 送出、Shift+Enter 換行（iPad 的螢幕鍵盤用送出鈕）
			if (e.key === "Enter" && !e.shiftKey && !composing(e)) {
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
		const used = usedTargets(active, learnerText, parseLearnerUsed(rawReply), corrected, this.clang());
		if (!used.length) return;
		const p = this.plugin;
		for (const t of used) {
			this.doneTargets.add(t.qid);
			await p.appendLog(
				p.makeEntry("answer", {
					qid: t.qid,
					bank: "words",
					qtype: t.kind === "word" ? "word" : "phrase",
					session: this.file.path,
					correct: true,
					via: "chat",
					...(this.clang() !== "en" ? { lang: this.clang() } : {}),
				}, this.cuser()),
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
		await this.ask(historyTurns(this.messages, this.plugin.chatMemoryOf(this.cuser())), text, null);
	}

	/** 語音訊息：錄音直接送給 AI，AI 聽寫（heard）後照平常回覆，只呼叫一次。 */
	private async sendVoice(wav: ArrayBuffer) {
		if (!this.meta || !this.file || this.sending) return;
		const bubble = this.listEl?.createDiv({ cls: "el-bubble el-bubble-user is-voice", text: "🎤 語音訊息…" }) ?? null;
		bubble?.scrollIntoView({ block: "end" });
		const turns: ChatTurn[] = historyTurns(this.messages, this.plugin.chatMemoryOf(this.cuser()));
		const audio = { mimeType: "audio/wav", data: arrayBufferToBase64(wav) };
		const last = turns[turns.length - 1];
		if (last?.role === "user") {
			last.text += `\n${voiceTurn(this.clang())}`;
			last.media = [...(last.media ?? []), audio];
		} else turns.push({ role: "user", text: voiceTurn(this.clang()), media: [audio] });
		await this.ask(turns, null, bubble, Math.round((wav.byteLength - 44) / 32000));
	}

	private async ask(turns: ChatTurn[], typed: string | null, voiceBubble: HTMLElement | null, voiceSeconds = 0) {
		const p = this.plugin;
		if (!this.meta || !this.file) return;
		const file = this.file;
		this.sending = true;
		const req = ++this.reqSeq; // 這次請求的編號：等 AI 的時候對話結束或又開了新的，回來的回覆就不算數
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
				system:
					chatSystemPrompt(this.meta.level, this.topic, this.article || undefined, this.clang()) +
					memoryPrompt(this.memItems, this.clang()) +
					levelPrompt(this.levelEstimate(), this.meta.level, this.clang()) +
					targetsPrompt(this.activeTargets(), this.meta.level, this.clang()),
				json: true,
				// 日文的回覆還帶平假名和羅馬拼音，1024 偶爾不夠（會被截斷）
				maxOutputTokens: this.clang() === "ja" ? 2048 : 1024,
				temperature: 0.9,
				hedgeAfterMs: voiceBubble ? HEDGE_MS + 4000 : HEDGE_MS,
				timeoutMs: TIMEOUT_MS,
			});
			const ms = Date.now() - t0;
			const reply = parseReply(res.text);
			if (req !== this.reqSeq || this.file !== file) {
				// 等 AI 的時候這個對話已經結束（或開了新的對話）：回覆存回原本的對話檔，
				// 但不能畫到現在的畫面、也不能放進新對話的歷史
				if (!voiceBubble && (reply.reply || reply.correction || reply.howto.length))
					await p.appendText(file, convBlock({ role: "model", text: res.text, ts: new Date().toISOString() })).catch(() => undefined);
				return;
			}
			const heard = voiceBubble ? parseHeard(res.text) : null;
			// AI 沒回內容（被截斷、被擋、空白）：當作沒有回應，不存進對話。
			// 空白的 AI 訊息留在歷史裡，之後每次送出都可能被 Google 拒絕
			if (!reply.reply && !reply.correction && !reply.howto.length && !(voiceBubble && !heard))
				throw new Error(res.finishReason === "MAX_TOKENS" ? "AI 的回覆太長被截斷了" : `AI 回了空白的內容${res.finishReason && res.finishReason !== "STOP" ? `（${res.finishReason}）` : ""}`);
			typing?.remove();
			let learnerText = typed;
			if (voiceBubble) {
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
			this.renderMessage(mm, reply);
			this.drawLevel();
			this.speakReply(reply.reply);
			// 背景先把回覆裡的字查好中文，點字就會立刻出現
			const forZh = [reply.reply, reply.correction?.corrected ?? "", ...reply.howto.map((h) => h.en)].join(" ");
			window.setTimeout(() => {
				prefetchMeanings(this.app, p.fastBackend(), forZh, this.clang()).catch((e) => p.debug(`prefetch meanings failed: ${(e as Error)?.message ?? e}`));
			}, 1500);
			await p.appendText(file, convBlock(mm));
			await this.savePhrases(reply);
			if (learnerText !== null) await this.recordUsed(learnerText, res.text, !!reply.correction);
			p.appendLog(p.makeEntry("api", { ok: true, purpose: "chat", model: res.model, usage: res.usage, ms, ...(voiceBubble ? { voice: true, seconds: voiceSeconds } : {}) }, this.cuser())).catch(() => undefined);
			if (ms > 8000) p.debug(`chat slow: ${ms} ms (in ${res.usage.inputTokens ?? "?"} / out ${res.usage.outputTokens ?? "?"} tokens${voiceBubble ? ", voice" : ""})`);
		} catch (e) {
			if (req !== this.reqSeq) return; // 對話已經結束：不用再提示
			typing?.setText(`AI 沒有回應：${(e as Error)?.message ?? e}（${voiceBubble ? "請再說一次" : "可以再送一次"}）`);
			if (voiceBubble) {
				voiceBubble.setText("🎤（沒有送出）");
				voiceBubble.addClass("is-failed");
			}
			const body = e instanceof AIError && e.body ? ` ${e.body.replace(/\s+/g, " ").slice(0, 300)}` : "";
			p.debug(`chat failed after ${Date.now() - t0} ms: ${(e as Error)?.message ?? e}${body}`);
		} finally {
			clearInterval(tick);
			if (req === this.reqSeq) this.sending = false; // 已經有更新的請求（新對話的開場）就不要動它的狀態
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
		const lang = this.clang();
		const system = () => speak(this.app, text, undefined, lang).catch((e) => this.plugin.debug(`chat speak failed: ${(e as Error)?.message ?? e}`));
		if (v === "natural") {
			const gen = this.speechGen;
			const stopped = () => this.speechGen !== gen;
			// 第一句先產生先播；拿不到自然語音（額度、網路）就改用系統語音
			this.plugin.pronouncer
				.speakNatural(text, stopped, lang)
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
		const lang = this.clang();
		const tag = lang !== "en" ? { lang } : {};
		if (r.correction && r.correction.zh) {
			const c = r.correction;
			await p.addPhrase({ key: phraseKey(c.corrected, lang), zh: c.zh, en: c.corrected, note: c.explanation, source: "correction", original: c.original, conv, ...tag }, this.cuser());
		}
		for (const h of r.howto) await p.addPhrase({ key: phraseKey(h.en, lang), zh: h.zh, en: h.en, alt: h.alt, note: h.note, source: "howto", conv, ...tag }, this.cuser());
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
				this.englishLine(box, r.correction.corrected, undefined, false, r.correction);
				if (r.correction.explanation) box.createDiv({ cls: "el-muted", text: r.correction.explanation });
			}
			for (const h of r.howto) {
				const box = list.createDiv({ cls: "el-chat-box el-chat-tip" });
				box.createDiv({ cls: "el-chat-box-title", text: `💡 怎麼說：${h.zh}（已記入句子本）` });
				this.englishLine(box, h.en, undefined, false, h);
				if (h.alt) this.englishLine(box, h.alt);
				if (h.note) box.createDiv({ cls: "el-muted", text: h.note });
			}
			const b = list.createDiv({ cls: "el-bubble el-bubble-ai" });
			this.englishLine(b, r.reply, r.replyZh, true, { reading: r.replyReading, romaji: r.replyRomaji });
		}
		list.lastElementChild?.scrollIntoView({ block: "end" });
	}

	/** 英文：逐字可點（唸、看中文、加入生字本）、🔊 唸整句、「中」看翻譯。 */
	private englishLine(parent: HTMLElement, text: string, zh?: string, markTargets = false, pron?: { reading?: string; romaji?: string }) {
		const lang = this.clang();
		const targetWords = markTargets ? this.activeTargets().filter((t) => t.kind === "word") : [];
		const wrap = parent.createDiv({ cls: "el-line-wrap" });
		const line = wrap.createDiv({ cls: "el-line" });
		const words = line.createSpan({ cls: "el-words" });
		for (const tok of tokenize(text, lang)) {
			if (!tok.word) {
				words.appendChild(document.createTextNode(tok.text));
				continue;
			}
			const w = words.createSpan({ cls: "el-w", text: tok.text });
			if (targetWords.some((t) => !t.en.includes(" ") && mentionsWord(tok.text, t, lang))) w.addClass("el-target-word"); // AI 用到了複習的字
			w.onclick = (e) => this.wordMenu(e, tok.text, text);
		}
		// 日文：AI 一起回傳的平假名與羅馬拼音（從零開始的學習者看不懂漢字）
		if (lang === "ja" && (pron?.reading || pron?.romaji)) {
			const box = wrap.createDiv({ cls: "el-reading" });
			if (pron.reading && pron.reading !== text) box.createDiv({ cls: "el-kana", text: pron.reading });
			if (pron.romaji) box.createDiv({ cls: "el-romaji", text: pron.romaji });
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
			box.setText(zh || cachedZh(this.app, text, lang) || "翻譯中…");
			if (!zh && !cachedZh(this.app, text, lang)) {
				try {
					box.setText((await translateMany(this.app, this.plugin.fastBackend(), [text], lang))[0]);
				} catch (err) {
					box.setText(`無法翻譯：${(err as Error)?.message ?? err}`);
				}
			}
		};
	}

	private wordMenu(evt: MouseEvent, word: string, sentence: string) {
		const menu = new Menu();
		const lang = this.clang();
		menu.addItem((i) => i.setTitle(`🔊 唸 ${word}`).onClick(() => this.plugin.say(word, undefined, { lang })));
		menu.addItem((i) =>
			i.setTitle("看中文意思").onClick(() => inlineMeaning(this.app, () => this.plugin.fastBackend(), word, evt.target instanceof HTMLElement ? evt.target : null, lang)),
		);
		menu.addItem((i) => i.setTitle("＋ 加入生字本").onClick(() => this.plugin.addWord(word, sentence, undefined, lang, this.cuser())));
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
		this.reqSeq++; // 還在等的 AI 回覆作廢
		this.sending = false;
		const fixes = this.messages.filter((m) => m.role === "model").map((m) => parseReply(m.text));
		const nFix = fixes.filter((r) => r.correction).length;
		const nHow = fixes.reduce((n, r) => n + r.howto.length, 0);
		const nRev = this.targets.filter((t) => this.doneTargets.has(t.qid)).length;
		new Notice(`對話結束：糾正 ${nFix} 句、學了 ${nHow} 個說法，都已記進句子本。${this.targets.length ? `複習到 ${nRev}／${this.targets.length} 個生字和句子。` : ""}`, 6000);
		// 這次聊到的重點整理成記憶：在背景做，不擋畫面
		const p = this.plugin;
		const job = this.file && p.remembers(this.cuser()) ? p.memory.remember(this.file.path) : null;
		this.phase = "start";
		this.meta = null;
		this.file = null;
		this.messages = [];
		this.memItems = [];
		this.targets = [];
		this.doneTargets = new Set();
		this.drawStart();
		// 等記憶整理完再同步（對話和記憶一起上傳，別台裝置下次聊天就接得上）；太久就先同步，記憶下次再上傳
		const sync = () => void p.triggerSync(true);
		if (job) {
			let timer = 0;
			const waited = new Promise<void>((ok) => (timer = window.setTimeout(ok, MEMORY_SYNC_WAIT_MS)));
			void Promise.race([job.then(() => undefined), waited]).then(() => {
				window.clearTimeout(timer);
				sync();
			});
		} else sync();
	}
}
