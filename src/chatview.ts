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

export const CHAT_VIEW = "english-learning-chat";
const LS_CHAT = "english-learning:chat"; // { [user]: { topic, article } }

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
			text: "用英文聊天；說錯會即時糾正。不會說的可以直接打中文問「…英文怎麼說」。糾正過的句子和問過的說法會記進「句子本」，之後在練習裡複習。",
		});
		const prefs = ((this.app.loadLocalStorage(LS_CHAT) ?? {}) as Record<string, { topic?: string; article?: string }>)[p.user] ?? {};

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

		el.createDiv({ cls: "el-row el-big-buttons" }, (r) => {
			const go = r.createEl("button", { text: "開始對話", cls: "mod-cta" });
			go.onclick = () => {
				const all = (this.app.loadLocalStorage(LS_CHAT) ?? {}) as Record<string, unknown>;
				all[p.user] = { topic: topicId, article: articlePath };
				this.app.saveLocalStorage(LS_CHAT, all);
				this.startNew(TOPICS.find((t) => t.id === topicId) ?? TOPICS[0], topicId === "article" ? articlePath : undefined);
			};
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
					cont.onclick = () => this.resume(f, fm as unknown as ConvMeta);
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

	private async startNew(topic: Topic, articlePath?: string) {
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
		this.messages = [];
		this.phase = "chat";
		this.drawChat();
		await this.send(null); // AI 開場
	}

	private async resume(f: TFile, fm: ConvMeta) {
		this.meta = { ...fm, level: fm.level === "kid" ? "kid" : "adult" };
		this.topic = TOPICS.find((t) => t.id === fm.topic) ?? TOPICS[0];
		this.article = await this.loadArticle(fm.article);
		this.file = f;
		this.messages = parseConvMessages(await this.app.vault.read(f));
		this.phase = "chat";
		this.drawChat();
		for (const m of this.messages) this.renderMessage(m);
	}

	private drawChat() {
		const el = this.root();
		const top = el.createDiv({ cls: "el-row el-top" });
		top.createSpan({ cls: "el-user-badge", text: `👤 ${this.plugin.user}` });
		top.createSpan({ cls: "el-badge", text: this.topic.label });
		const end = top.createEl("a", { text: "結束對話", cls: "el-quit" });
		end.onclick = () => this.end();

		this.listEl = el.createDiv({ cls: "el-chat-list" });
		const bar = el.createDiv({ cls: "el-chat-input" });
		const ta = bar.createEl("textarea", { attr: { rows: "2", placeholder: "用英文說，或打中文問「…怎麼說」" } });
		const send = bar.createEl("button", { text: "送出", cls: "mod-cta" });
		send.onclick = () => {
			const t = ta.value.trim();
			if (!t || this.sending) return;
			ta.value = "";
			this.send(t);
		};
		ta.addEventListener("keydown", (e) => {
			// 電腦上 Enter 送出、Shift+Enter 換行（iPad 的螢幕鍵盤用送出鈕）
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				send.click();
			}
		});
	}

	private async send(text: string | null) {
		const p = this.plugin;
		if (!this.meta || !this.file) return;
		if (text !== null) {
			const um: ConvMessage = { role: "user", text, ts: new Date().toISOString() };
			this.messages.push(um);
			this.renderMessage(um);
			await p.appendText(this.file, convBlock(um));
		}
		this.sending = true;
		const typing = this.listEl?.createDiv({ cls: "el-chat-typing", text: "AI 輸入中…" });
		typing?.scrollIntoView({ block: "end" });
		try {
			const res = await p.backend().chat(historyTurns(this.messages), {
				system: chatSystemPrompt(this.meta.level, this.topic, this.article || undefined),
				json: true,
				maxOutputTokens: 1024,
				temperature: 0.7,
			});
			typing?.remove();
			const mm: ConvMessage = { role: "model", text: res.text, ts: new Date().toISOString() };
			this.messages.push(mm);
			await p.appendText(this.file, convBlock(mm));
			const reply = parseReply(res.text);
			this.renderMessage(mm, reply);
			await this.savePhrases(reply);
			p.appendLog(p.makeEntry("api", { ok: true, purpose: "chat", model: res.model, usage: res.usage })).catch(() => undefined);
		} catch (e) {
			typing?.setText(`AI 沒有回應：${(e as Error)?.message ?? e}（可以再送一次）`);
			p.debug(`chat failed: ${(e as Error)?.message ?? e}`);
		} finally {
			this.sending = false;
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
			list.createDiv({ cls: "el-bubble el-bubble-user", text: m.text });
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
			this.englishLine(b, r.reply, r.replyZh);
		}
		list.lastElementChild?.scrollIntoView({ block: "end" });
	}

	/** 英文：逐字可點（唸、看中文、加入生字本）、🔊 唸整句、「中」看翻譯。 */
	private englishLine(parent: HTMLElement, text: string, zh?: string) {
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
			w.onclick = (e) => this.wordMenu(e, m[2], text);
			if (m[3]) words.appendChild(document.createTextNode(m[3]));
		}
		const say = line.createEl("button", { cls: "el-zh-btn", text: "🔊" });
		say.onclick = (e) => {
			e.stopPropagation();
			this.plugin.say(text);
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
					box.setText((await translateMany(this.app, this.plugin.backend(), [text]))[0]);
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
					new Notice(`${word}：${cachedZh(this.app, word) ?? (await translateMany(this.app, this.plugin.backend(), [word]))[0]}`, 8000);
				} catch (e) {
					new Notice(`無法翻譯：${(e as Error)?.message ?? e}`);
				}
			}),
		);
		menu.addItem((i) => i.setTitle("＋ 加入生字本").onClick(() => this.plugin.addWord(word, sentence)));
		menu.showAtMouseEvent(evt);
	}

	private end() {
		const fixes = this.messages.filter((m) => m.role === "model").map((m) => parseReply(m.text));
		const nFix = fixes.filter((r) => r.correction).length;
		const nHow = fixes.reduce((n, r) => n + r.howto.length, 0);
		new Notice(`對話結束：糾正 ${nFix} 句、學了 ${nHow} 個說法，都已記進句子本。`, 6000);
		this.phase = "start";
		this.meta = null;
		this.file = null;
		this.messages = [];
		this.drawStart();
		this.plugin.triggerSync(true);
	}
}
