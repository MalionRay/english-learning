// 錯誤模式分析的畫面：分析 → 顯示報告 → 勾選練習句加入句子本。
import { App, Modal, Notice, TFile } from "obsidian";
import type EnglishLearningPlugin from "./main";
import { phraseKey } from "./chat";
import { loadPractice } from "./practice";
import {
	Drill,
	MIN_ERRORS,
	PatternReport,
	analyzePatterns,
	collectAnswerErrors,
	loadConversationErrors,
	pickErrors,
	reportMarkdown,
	saveReport,
} from "./patterns";

export const ANALYZE_DAYS = 60;

export class PatternModal extends Modal {
	private report: PatternReport | null = null;
	private file: TFile | null = null;

	constructor(app: App, private plugin: EnglishLearningPlugin) {
		super(app);
	}

	onOpen() {
		this.setTitle(`常見錯誤分析（${this.plugin.user}）`);
		void this.run();
	}

	onClose() {
		this.contentEl.empty();
	}

	private async run() {
		const el = this.contentEl;
		el.empty();
		const status = el.createDiv({ cls: "el-muted", text: "整理最近的錯誤…" });
		const p = this.plugin;
		const since = Date.now() - ANALYZE_DAYS * 864e5;
		try {
			const d = await loadPractice(this.app, p.user, "all");
			const items = pickErrors([...collectAnswerErrors(d.logs, d.banks, since), ...(await loadConversationErrors(this.app, p.user, since))]);
			if (items.length < MIN_ERRORS) {
				status.setText(`最近 ${ANALYZE_DAYS} 天只有 ${items.length} 筆可以分析的錯誤（至少要 ${MIN_ERRORS} 筆）。多做翻譯題、句子練習或英文對話之後再來分析。`);
				return;
			}
			if (typeof navigator !== "undefined" && navigator.onLine === false) {
				status.setText("沒有網路連線，分析需要用 AI。");
				return;
			}
			status.setText(`AI 分析 ${items.length} 筆錯誤中…（約 10～30 秒）`);
			this.report = await analyzePatterns(p.backend(), items, p.user === "kid" ? "kid" : "adult");
			const now = new Date();
			this.file = await saveReport(this.app, p.user, p.deviceId, reportMarkdown(this.report, p.user, now.toISOString()), now);
			this.draw();
		} catch (e) {
			status.setText(`分析失敗：${(e as Error)?.message ?? e}`);
		}
	}

	private draw() {
		const r = this.report!;
		const el = this.contentEl;
		el.empty();
		el.addClass("el-practice");
		el.createDiv({ cls: "el-muted", text: `分析了 ${r.count} 筆錯誤` });
		if (r.summary) el.createEl("p", { text: r.summary });
		if (!r.patterns.length) el.createDiv({ cls: "el-muted", text: "沒有找到反覆出現的錯誤，繼續保持！" });
		const picked: { d: Drill; box: HTMLInputElement }[] = [];
		r.patterns.forEach((pt, i) => {
			const card = el.createDiv({ cls: "el-card" });
			card.createEl("h4", { text: `${i + 1}. ${pt.title}` });
			if (pt.explanation) card.createDiv({ text: pt.explanation });
			for (const x of pt.examples)
				card.createDiv({ cls: "el-row" }, (row) => {
					row.createSpan({ cls: "el-d-typed", text: x.wrong });
					row.createSpan({ text: " → " });
					row.createSpan({ cls: "el-say", text: x.right });
				});
			if (pt.tip) card.createDiv({ cls: "el-muted", text: `💡 ${pt.tip}` });
			if (pt.drills.length) card.createDiv({ cls: "el-muted", text: "練習句（勾選的會加入句子本）：" });
			for (const d of pt.drills) {
				const row = card.createEl("label", { cls: "el-row el-drill" });
				const box = row.createEl("input", { type: "checkbox" });
				box.checked = true;
				row.createSpan({ text: `${d.zh} → ` });
				row.createSpan({ cls: "el-say", text: d.en });
				picked.push({ d, box });
			}
		});
		const buttons = el.createDiv({ cls: "el-row el-modal-buttons" });
		if (this.file) {
			const f = this.file;
			buttons.createEl("button", { text: "開啟報告" }).onclick = () => {
				this.close();
				void this.app.workspace.getLeaf(true).openFile(f);
			};
		}
		if (picked.length) {
			const add = buttons.createEl("button", { text: "加入句子本", cls: "mod-cta" });
			add.onclick = async () => {
				const chosen = picked.filter((x) => x.box.checked).map((x) => x.d);
				if (!chosen.length) return;
				add.disabled = true;
				for (const d of chosen) await this.plugin.addPhrase({ key: phraseKey(d.en), zh: d.zh, en: d.en, note: d.note, source: "pattern" });
				new Notice(`已加入句子本 ${chosen.length} 句，到「練習 → 句子」複習`);
				this.close();
			};
		}
		buttons.createEl("button", { text: "關閉" }).onclick = () => this.close();
	}
}
