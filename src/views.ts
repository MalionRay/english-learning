import { App, ItemView, Modal, Notice, Setting, WorkspaceLeaf } from "obsidian";
import type EnglishLearningPlugin from "./main";
import { HOME_VIEW, VERIFY_VIEW } from "./constants";
import { DEBUG_ROOT, logPath } from "./logs";
import { LEVEL_LABEL, Level, MAX_WORDS, Question, TYPE_LABEL, parseBank, planFor, planTotal, wordCount } from "./generate";
import { bankPath, canGenerate, listSources } from "./sources";
import { FlagLog, loadFlags } from "./flags";
import { loadFixes } from "./fixes";
import { TFile } from "obsidian";

// =====================================================================
// 主畫面：文章列表、匯入、出題
export class HomeView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private plugin: EnglishLearningPlugin) {
		super(leaf);
	}
	getViewType() {
		return HOME_VIEW;
	}
	getDisplayText() {
		return "English Learning";
	}
	getIcon() {
		return "book-open";
	}

	async onOpen() {
		const relevant = (path: string) => path.startsWith("english/");
		this.registerEvent(this.app.metadataCache.on("changed", (f) => relevant(f.path) && this.render()));
		this.registerEvent(this.app.vault.on("create", (f) => relevant(f.path) && this.render()));
		this.registerEvent(this.app.vault.on("delete", (f) => relevant(f.path) && this.render()));
		this.registerEvent(this.app.vault.on("rename", (f, old) => (relevant(f.path) || relevant(old)) && this.render()));
		this.render();
	}

	render() {
		const p = this.plugin;
		const el = this.contentEl;
		el.empty();
		el.addClass("el-verify");
		el.createEl("h3", { text: "English Learning" });
		el.createDiv({ cls: "el-muted", text: `裝置 ${p.deviceId}　使用者 ${p.user}` });

		el.createDiv({ cls: "el-row" }, (r) => {
			const pr = r.createEl("button", { text: "開始練習", cls: "mod-cta" });
			pr.onclick = () => p.openView("english-learning-practice");
			const ch = r.createEl("button", { text: "英文對話", cls: "mod-cta" });
			ch.onclick = () => p.openView("english-learning-chat");
			const pb = r.createEl("button", { text: "句子本" });
			pb.onclick = () => p.openView("english-learning-phrases");
			const wb = r.createEl("button", { text: "生字本" });
			wb.onclick = () => p.openView("english-learning-words");
			const st = r.createEl("button", { text: "學習統計" });
			st.onclick = () => p.openView("english-learning-stats");
			const imp = r.createEl("button", { text: "匯入文章" });
			imp.onclick = () => new ImportModal(this.app, p).open();
			const s = r.createEl("button", { text: "立即同步" });
			s.onclick = () => p.triggerSync();
		});

		el.createEl("h4", { text: "文章" });
		const sources = listSources(this.app);
		if (!sources.length) {
			el.createDiv({ cls: "el-muted", text: "還沒有文章。按「匯入文章」貼上一篇英文文章，或在 english/sources 資料夾新增筆記。" });
		}
		const cards = new Map<string, HTMLElement>();
		for (const s of sources) {
			const card = el.createDiv({ cls: "el-card" });
			if (s.id) cards.set(s.id, card);
			const head = card.createDiv({ cls: "el-row" });
			const a = head.createEl("a", { text: s.title, cls: "el-title" });
			a.onclick = () => this.app.workspace.getLeaf(false).openFile(s.file);
			if (s.level) head.createSpan({ cls: "el-badge", text: LEVEL_LABEL[s.level] });

			const busy = p.generating.has(s.file.path);
			const status = card.createDiv({ cls: "el-row" });
			if (s.status === "generated") {
				status.createSpan({ cls: "el-ok", text: `✓ 已出題 ${s.count ?? ""} 題` });
				const b = status.createEl("button", { text: "開啟題庫" });
				b.onclick = () => p.openBank(s.id);
				if (!s.importedOn || s.importedOn === p.deviceId) {
					const re = status.createEl("button", { text: "重新出題" });
					re.onclick = () =>
						new ConfirmModal(
							this.app,
							"重新出題",
							"舊題庫會移到垃圾桶，然後用目前的文章（包含 ==螢光筆== 標記的生字）重新出題。已經做過的舊題目練習紀錄會保留，但不會再出現。",
							() => p.regenerate(s.file),
						).open();
				}
			} else if (busy || s.status === "generating") {
				status.createSpan({ text: "出題中…（約 10～30 秒）" });
			} else {
				const chk = canGenerate(s, p.deviceId);
				if (chk.ok) {
					const b = status.createEl("button", { text: "出題" });
					b.onclick = () => {
						if (s.level) p.generate(s.file);
						else new LevelModal(this.app, (lv) => p.generate(s.file, lv)).open();
					};
					status.createSpan({ cls: "el-muted", text: "未出題" });
				} else {
					status.createSpan({ cls: "el-muted", text: chk.reason ?? "" });
				}
			}
			if (s.lastError && s.status !== "generated") card.createDiv({ cls: "el-warn", text: `上次失敗：${s.lastError}` });
		}

		// 被回報有問題的題目
		loadFlags(this.app)
			.then((flags) => {
				const byBank = new Map<string, FlagLog[]>();
				for (const f of flags.values()) byBank.set(f.bank, [...(byBank.get(f.bank) ?? []), f]);
				for (const [bank, list] of byBank) {
					const card = cards.get(bank);
					if (!card) continue;
					const a = card.createEl("a", { cls: "el-warn el-flag-link", text: `⚑ ${list.length} 題被回報（點這裡查看、修正或恢復）` });
					a.onclick = () => new FlaggedModal(this.app, p, bank, list).open();
				}
			})
			.catch(() => undefined);


	}
}

// =====================================================================
export class ImportModal extends Modal {
	private title = "";
	private level: Level;
	private text = "";
	private unknown = "";

	constructor(app: App, private plugin: EnglishLearningPlugin) {
		super(app);
		this.level = plugin.lastLevel;
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle("匯入文章");
		new Setting(contentEl).setName("標題").addText((t) => {
			t.setPlaceholder("例如：BBC - Why we sleep").onChange((v) => (this.title = v));
			t.inputEl.style.width = "100%";
		});
		new Setting(contentEl).setName("程度").addDropdown((d) =>
			d
				.addOptions({ adult: "成人", kid: "小孩" })
				.setValue(this.level)
				.onChange((v) => (this.level = v as Level)),
		);
		new Setting(contentEl)
			.setName("我不會的字")
			.setDesc("用逗號分隔，可留空。會在文章中標成 ==螢光筆==，出題時一定會考；之後也可以直接在文章裡用 ==字== 標記。")
			.addText((t) => {
				t.setPlaceholder("espionage, lodge a protest").onChange((v) => (this.unknown = v));
				t.inputEl.style.width = "100%";
			});
		const info = contentEl.createDiv({ cls: "el-muted" });
		const ta = contentEl.createEl("textarea", { cls: "el-textarea", attr: { placeholder: "把英文文章貼在這裡", rows: "12" } });
		const update = () => {
			this.text = ta.value;
			const w = wordCount(ta.value);
			info.setText(w ? `${w} 個英文字 → 預計 ${planTotal(planFor(w))} 題${w > MAX_WORDS ? `（超過 ${MAX_WORDS} 字，請分段）` : ""}` : "");
		};
		ta.addEventListener("input", update);

		const row = contentEl.createDiv({ cls: "el-row el-modal-buttons" });
		const go = async (andGenerate: boolean) => {
			if (!this.text.trim()) return new Notice("請先貼上文章");
			if (!this.title.trim()) this.title = this.text.trim().split(/\s+/).slice(0, 6).join(" ");
			this.close();
			const words = this.unknown.split(/[,，、;；\n]/).map((w) => w.trim()).filter(Boolean);
			const file = await this.plugin.importArticle(this.title, this.level, this.text, words);
			if (file && andGenerate) await this.plugin.generate(file);
		};
		row.createEl("button", { text: "只匯入" }).onclick = () => go(false);
		row.createEl("button", { text: "匯入並出題", cls: "mod-cta" }).onclick = () => go(true);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** 列出某篇文章被回報的題目，可以恢復。 */
export class FlaggedModal extends Modal {
	constructor(app: App, private plugin: EnglishLearningPlugin, private bankId: string, private flags: FlagLog[]) {
		super(app);
	}
	async onOpen() {
		this.setTitle("被回報的題目");
		const f = this.app.vault.getAbstractFileByPath(bankPath(this.bankId));
		const bank = f instanceof TFile ? parseBank(await this.app.vault.cachedRead(f)) : null;
		const fixes = await loadFixes(this.app);
		const qs = new Map<string, Question>((bank?.questions ?? []).map((q) => [q.id, q]));
		for (const fx of fixes.values()) if (fx.bank === this.bankId) qs.set(fx.question.id, fx.question);
		for (const fl of this.flags) {
			const q = qs.get(fl.qid);
			const box = this.contentEl.createDiv({ cls: "el-card" });
			box.createDiv({ cls: "el-muted", text: `${q ? TYPE_LABEL[q.type] : "題目"}・${fl.user}・${new Date(fl.ts).toLocaleDateString()}・${fl.reason ?? ""}` });
			if (q) {
				box.createDiv({ text: q.prompt });
				if (q.type !== "translate") box.createDiv({ cls: "el-muted", text: `標示的答案：${q.options[q.answer]}` });
				else box.createDiv({ cls: "el-muted", text: `參考答案：${q.reference}` });
			} else box.createDiv({ cls: "el-muted", text: "（找不到題目，可能題庫已重新產生）" });
			const row = box.createDiv({ cls: "el-row" });
			const fx = fixes.get(fl.qid);
			if (fx) row.createSpan({ cls: "el-ok", text: "✓ 已換成修正題" });
			else if (q && bank) {
				const re = row.createEl("button", { text: "重新出這題", cls: "mod-cta" });
				re.onclick = async () => {
					re.disabled = true;
					re.setText("出題中…");
					const out = await this.plugin.fixQuestion(bank, q, fl.reason ?? "其他");
					re.setText(!out ? "失敗，請確認網路後再試" : out.kind === "originalCorrect" ? `AI 判斷原題正確，已恢復：${out.message}` : "✓ 已修正");
					if (!out) re.disabled = false;
					this.plugin.refreshViews();
				};
			}
			const b = row.createEl("button", { text: "恢復原題" });
			b.onclick = async () => {
				const p = this.plugin;
				await p.appendLog(p.makeEntry("unflag", { qid: fl.qid, bank: fl.bank }));
				b.disabled = true;
				b.setText("已恢復");
				p.refreshViews();
			};
		}
	}
	onClose() {
		this.contentEl.empty();
	}
}

export class ConfirmModal extends Modal {
	constructor(app: App, private heading: string, private message: string, private onOk: () => void) {
		super(app);
	}
	onOpen() {
		this.setTitle(this.heading);
		this.contentEl.createEl("p", { text: this.message });
		const row = this.contentEl.createDiv({ cls: "el-row el-modal-buttons" });
		row.createEl("button", { text: "取消" }).onclick = () => this.close();
		row.createEl("button", { text: "確定", cls: "mod-warning" }).onclick = () => {
			this.close();
			this.onOk();
		};
	}
	onClose() {
		this.contentEl.empty();
	}
}

export class LevelModal extends Modal {
	constructor(app: App, private onPick: (lv: Level) => void) {
		super(app);
	}
	onOpen() {
		this.setTitle("這篇文章的程度");
		const row = this.contentEl.createDiv({ cls: "el-row el-modal-buttons" });
		(["adult", "kid"] as Level[]).forEach((lv) => {
			row.createEl("button", { text: LEVEL_LABEL[lv], cls: "mod-cta" }).onclick = () => {
				this.close();
				this.onPick(lv);
			};
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

// =====================================================================
// 驗證面板（同步層測試用）
export class VerifyView extends ItemView {
	private busy = false;

	constructor(leaf: WorkspaceLeaf, private plugin: EnglishLearningPlugin) {
		super(leaf);
	}
	getViewType() {
		return VERIFY_VIEW;
	}
	getDisplayText() {
		return "English Learning 驗證";
	}
	getIcon() {
		return "flask-conical";
	}

	async onOpen() {
		this.registerEvent(this.app.vault.on("create", (f) => f.path.startsWith("logs/") && this.render()));
		this.registerEvent(this.app.vault.on("modify", (f) => f.path.startsWith("logs/") && this.render()));
		this.registerEvent(this.app.vault.on("delete", (f) => f.path.startsWith("logs/") && this.render()));
		await this.render();
	}

	async render() {
		if (this.busy) return;
		this.busy = true;
		try {
			await this.draw();
		} finally {
			this.busy = false;
		}
	}

	private async draw() {
		const p = this.plugin;
		const el = this.contentEl;
		const totals = await p.totals();
		el.empty();
		el.addClass("el-verify");

		el.createEl("h3", { text: "驗證外掛" });

		// 1. 裝置與使用者
		el.createEl("h4", { text: "1. 本機裝置" });
		el.createDiv({ cls: "el-row" }, (r) => {
			r.createSpan({ text: "裝置 ID：" });
			r.createSpan({ cls: "el-mono", text: p.deviceId });
		});
		el.createDiv({ cls: "el-row" }, (r) => {
			r.createSpan({ text: "使用者：" });
			const sel = r.createEl("select", { cls: "dropdown" });
			for (const u of p.settings.users) sel.createEl("option", { text: u, value: u });
			sel.value = p.user;
			sel.onchange = () => {
				p.user = sel.value;
				this.render();
			};
		});
		el.createDiv({ cls: "el-muted", text: `本機寫入：${logPath(p.user, p.deviceId)}` });

		// 2. append
		el.createEl("h4", { text: "2. 記一筆" });
		el.createDiv({ cls: "el-row" }, (r) => {
			const b = r.createEl("button", { text: "記一筆", cls: "mod-cta" });
			b.onclick = () => p.tap();
			const s = r.createEl("button", { text: "立即同步" });
			s.onclick = () => p.triggerSync();
			const re = r.createEl("button", { text: "重新計算" });
			re.onclick = () => this.render();
		});

		// 3. 合計
		el.createEl("h4", { text: "3. 合計（所有裝置）" });
		el.createDiv({ cls: "el-big", text: String(totals.uniqueTaps) });
		el.createDiv({
			cls: "el-muted",
			text: `原始筆數 ${totals.rawTaps}，UUID 重複 ${totals.duplicates}，壞行 ${totals.badLines}，計算於 ${new Date().toLocaleTimeString()}`,
		});
		const devices = Object.keys({ ...totals.byDevice, ...totals.latest }).sort();
		if (devices.length) {
			const tbl = el.createEl("table");
			const h = tbl.createEl("tr");
			for (const c of ["裝置", "筆數", "API", "麥克風", "上次同步觸發"]) h.createEl("th", { text: c });
			for (const d of devices) {
				const tr = tbl.createEl("tr");
				const l = totals.latest[d] ?? {};
				tr.createEl("td", { cls: "el-mono", text: d + (d === p.deviceId ? "（本機）" : "") });
				tr.createEl("td", { text: String(totals.byDevice[d] ?? 0) });
				tr.createEl("td", { text: l.api ? (l.api.ok ? "OK" : "FAIL") : "—" });
				tr.createEl("td", { text: l.mic ? String(l.mic.result).replace("mic ", "") : "—" });
				tr.createEl("td", { text: l.sync ? new Date(l.sync.ts).toLocaleString() : "—" });
			}
		}
		const users = Object.entries(totals.byUser);
		if (users.length) el.createDiv({ cls: "el-muted", text: "依使用者：" + users.map(([u, n]) => `${u} ${n}`).join("、") });
		if (totals.suspicious.length) {
			el.createDiv({ cls: "el-warn", text: `⚠ 不符合 logs/<user>/<deviceId>.jsonl 的檔案（可能是衝突副本）：` });
			for (const s of totals.suspicious) el.createDiv({ cls: "el-mono el-warn", text: s });
		} else if (totals.files.length) {
			el.createDiv({ cls: "el-ok", text: `✓ ${totals.files.length} 個 log 檔，沒有衝突副本` });
		}

		// 4. API
		el.createEl("h4", { text: "4. AI API（Gemini）" });
		const hasSecret = !!(this.app as App & { secretStorage?: unknown }).secretStorage;
		el.createDiv({
			cls: "el-muted",
			text: `模型 ${p.settings.geminiModel}；金鑰${p.getApiKey() ? "已設定" : "未設定"}（${hasSecret ? "SecretStorage" : "localStorage 備案"}）`,
		});
		const apiOut = el.createEl("pre", { text: "（尚未測試）" });
		el.createDiv({ cls: "el-row" }, (r) => {
			const b = r.createEl("button", { text: "測試 API" });
			b.onclick = async () => {
				apiOut.setText("呼叫中…");
				apiOut.setText(await p.testApi());
			};
		});

		// 發音
		el.createEl("h4", { text: "發音（系統語音）" });
		const ttsOut = el.createEl("pre", { text: "（尚未測試）" });
		el.createDiv({ cls: "el-row" }, (r) => {
			const b = r.createEl("button", { text: "測試系統語音" });
			b.onclick = async () => {
				ttsOut.setText("朗讀中…");
				ttsOut.setText(await p.testTts());
			};
			const g = r.createEl("button", { text: "測試 Gemini 語音" });
			g.onclick = async () => {
				ttsOut.setText("產生中…");
				ttsOut.setText(await p.testGeminiTts());
			};
			const w = r.createEl("button", { text: "測試字典發音" });
			w.onclick = () => {
				ttsOut.setText("播放 espionage（第一次會從字典下載）");
				p.say("espionage");
			};
		});

		// 5. Mic
		el.createEl("h4", { text: "5. 麥克風" });
		const micOut = el.createEl("pre", { text: "（尚未測試）" });
		el.createDiv({ cls: "el-row" }, (r) => {
			const b = r.createEl("button", { text: "測試麥克風" });
			b.onclick = async () => {
				micOut.setText("測試中…");
				micOut.setText(await p.testMic());
			};
		});

		el.createDiv({ cls: "el-muted", text: `除錯紀錄：${DEBUG_ROOT}/${p.deviceId}.md` });
	}
}
