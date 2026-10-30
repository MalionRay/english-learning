// 生字本與學習統計畫面
import { ItemView, WorkspaceLeaf } from "obsidian";
import type EnglishLearningPlugin from "./main";
import { TYPE_LABEL } from "./generate";
import { loadPractice } from "./practice";
import { BOOK_STATUS_LABEL, BookStatus, bookStatus, computeStats, splitByStatus, wordQid } from "./words";
import { PHRASE_SOURCE_LABEL, phraseQid } from "./chat";
import type { AnswerLog, GradeLog } from "./srs";
import { PatternModal } from "./patternview";

export const WORDS_VIEW = "english-learning-words";
export const STATS_VIEW = "english-learning-stats";

function header(el: HTMLElement, title: string, plugin: EnglishLearningPlugin, onChange: () => void) {
	el.createEl("h3", { text: title });
	el.createDiv({ cls: "el-row" }, (r) => {
		r.createSpan({ text: "使用者" });
		const sel = r.createEl("select", { cls: "dropdown" });
		for (const u of plugin.settings.users) sel.createEl("option", { text: u, value: u });
		sel.value = plugin.user;
		sel.onchange = () => {
			plugin.user = sel.value;
			onChange();
		};
	});
}

function levelFor(user: string): "adult" | "kid" {
	return user === "kid" ? "kid" : "adult";
}

/** 卡片上的狀態標籤。 */
function statusChip(parent: HTMLElement, s: BookStatus) {
	parent.createSpan({ cls: `el-status is-${s}`, text: BOOK_STATUS_LABEL[s] });
}

/** 還在學的直接列出；熟練的收在「已熟練」裡（搜尋時自動展開）。 */
function drawSplit<T>(list: HTMLElement, items: T[], statusOf: (x: T) => BookStatus, filtering: boolean, drawCard: (parent: HTMLElement, x: T, s: BookStatus) => void) {
	const { active, mastered, counts } = splitByStatus(items, statusOf);
	list.createDiv({ cls: "el-muted el-book-summary", text: `要加強 ${counts.wrong}・學習中 ${counts.learning}・還沒複習 ${counts.new}・熟練 ${counts.mastered}` });
	for (const x of active) drawCard(list, x, statusOf(x));
	if (!mastered.length) return;
	const det = list.createEl("details", { cls: "el-mastered" });
	det.createEl("summary", { text: `✓ 已熟練 ${mastered.length}（間隔 7 天以上，偶爾才會出現；點開查看）` });
	if (filtering) det.open = true;
	for (const x of mastered) drawCard(det, x, "mastered");
}

function relDay(ms: number): string {
	const days = Math.round((ms - Date.now()) / 864e5);
	if (days <= 0) return "今天";
	if (days === 1) return "明天";
	return `${days} 天後`;
}

// =====================================================================
export class WordsView extends ItemView {
	private filter = "";
	private busy = false;

	constructor(leaf: WorkspaceLeaf, private plugin: EnglishLearningPlugin) {
		super(leaf);
	}
	getViewType() {
		return WORDS_VIEW;
	}
	getDisplayText() {
		return "生字本";
	}
	getIcon() {
		return "book-a";
	}
	async onOpen() {
		this.render();
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
		el.empty();
		el.addClass("el-verify");
		el.addClass("el-practice");
		header(el, "生字本", p, () => this.render());
		const d = await loadPractice(this.app, p.user, levelFor(p.user));
		const words = d.words;

		el.createDiv({
			cls: "el-muted",
			text: `共 ${words.length} 個字。來源：文章標記的生字、答錯過的字、練習時點字加入的字。到「練習 → 生字複習」可以複習。`,
		});
		const search = el.createEl("input", { cls: "el-cloze-input", attr: { type: "search", placeholder: "搜尋英文或中文" } });
		search.value = this.filter;
		const list = el.createDiv();
		const draw = () => {
			list.empty();
			const f = this.filter.trim().toLowerCase();
			const shown = words.filter((w) => !f || w.key.includes(f) || [...w.forms].some((x) => x.toLowerCase().includes(f)) || (w.meaning ?? "").includes(f));
			if (!shown.length) list.createDiv({ cls: "el-muted", text: words.length ? "沒有符合的字" : "還沒有生字。練習時點句子裡的字可以加入。" });
			drawSplit(list, shown, (w) => bookStatus(d.states.get(wordQid(w.key))), !!f, (parent, w, status) => {
				const st = d.states.get(wordQid(w.key));
				const card = parent.createDiv({ cls: `el-card el-word-card is-${status}` });
				const top = card.createDiv({ cls: "el-row" });
				statusChip(top, status);
				top.createSpan({ cls: "el-say el-title", text: w.word });
				if (w.ipa) top.createSpan({ cls: "el-ipa", text: w.ipa });
				top.createSpan({ text: w.meaning ?? "" });
				if (w.forms.size) card.createDiv({ cls: "el-muted", text: `也包含：${[...w.forms].join("、")}` });
				if (w.context) card.createDiv({ cls: "el-say el-sentence el-muted", text: w.context });
				const tags: string[] = [];
				if (w.reasons.has("marked")) tags.push("⭐標記");
				if (w.wrong) tags.push(`答錯 ${w.wrong} 次`);
				if (w.reasons.has("manual")) tags.push("自己加入");
				if (st) tags.push(`下次複習：${relDay(st.due)}`);
				const bottom = card.createDiv({ cls: "el-row" });
				bottom.createSpan({ cls: "el-muted", text: tags.join("・") });
				const rm = bottom.createEl("button", { text: "移除", cls: "el-zh-btn" });
				rm.onclick = async () => {
					await p.appendLog(p.makeEntry("word-remove", { word: w.word }));
					card.remove();
				};
			});
		};
		search.addEventListener("input", () => {
			this.filter = search.value;
			draw();
		});
		draw();
	}
}

// =====================================================================
export class StatsView extends ItemView {
	private busy = false;
	constructor(leaf: WorkspaceLeaf, private plugin: EnglishLearningPlugin) {
		super(leaf);
	}
	getViewType() {
		return STATS_VIEW;
	}
	getDisplayText() {
		return "學習統計";
	}
	getIcon() {
		return "bar-chart-2";
	}
	async onOpen() {
		this.render();
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
		el.empty();
		el.addClass("el-verify");
		el.addClass("el-practice");
		header(el, "學習統計", p, () => this.render());
		const d = await loadPractice(this.app, p.user, "all");
		const answers = d.logs.filter((e): e is AnswerLog | GradeLog => e.type === "answer" || e.type === "grade");
		const s = computeStats(answers, d.states);

		const tiles = el.createDiv({ cls: "el-tiles" });
		const tile = (label: string, value: string, sub?: string) => {
			const t = tiles.createDiv({ cls: "el-tile" });
			t.createDiv({ cls: "el-tile-value", text: value });
			t.createDiv({ cls: "el-tile-label", text: label });
			if (sub) t.createDiv({ cls: "el-muted", text: sub });
		};
		tile("連續天數", `${s.streak}`, s.today ? "今天已練習" : "今天還沒練");
		tile("今天作答", `${s.today}`);
		tile("已熟練", `${s.mastered}`, "間隔 7 天以上");
		tile("學習中", `${s.learning}`, `明天前到期 ${s.dueTomorrow}`);
		tile("生字本", `${d.words.length}`);
		tile("句子本", `${d.phrases.length}`);

		el.createDiv({ cls: "el-row" }, (r) => {
			const b = r.createEl("button", { text: "分析我的常見錯誤", cls: "mod-cta" });
			b.onclick = () => new PatternModal(this.app, p).open();
			r.createSpan({ cls: "el-muted", text: "用 AI 找出最近 60 天反覆犯的錯，並產生練習句" });
		});

		el.createEl("h4", { text: "最近 30 天" });
		const max = Math.max(1, ...s.days.map((x) => x.count));
		const chart = el.createDiv({ cls: "el-bars" });
		for (const day of s.days) {
			const col = chart.createDiv({ cls: "el-bar-col", attr: { title: `${day.date}：${day.count} 題` } });
			const bar = col.createDiv({ cls: "el-bar" });
			bar.style.height = `${Math.round((day.count / max) * 100)}%`;
			if (!day.count) bar.addClass("is-zero");
		}
		el.createDiv({ cls: "el-row el-bars-axis" }, (r) => {
			r.createSpan({ cls: "el-muted", text: s.days[0].date.slice(5) });
			r.createSpan({ cls: "el-muted", text: "今天" });
		});

		el.createEl("h4", { text: "各題型正確率（最近 30 天）" });
		const labels: Record<string, string> = { ...TYPE_LABEL, word: "生字複習", dictation: "聽寫", listening: "聽力理解", phrase: "句子" };
		const types = Object.keys(s.byType);
		if (!types.length) el.createDiv({ cls: "el-muted", text: "還沒有作答紀錄" });
		for (const t of types) {
			const v = s.byType[t];
			const pct = Math.round((v.right / v.total) * 100);
			const row = el.createDiv({ cls: "el-acc-row" });
			row.createSpan({ cls: "el-acc-label", text: labels[t] ?? t });
			const track = row.createDiv({ cls: "el-acc-track" });
			track.createDiv({ cls: "el-acc-fill" }).style.width = `${pct}%`;
			row.createSpan({ cls: "el-acc-num", text: `${pct}%（${v.right}/${v.total}）` });
		}
	}
}

// =====================================================================
export const PHRASES_VIEW = "english-learning-phrases";

export class PhrasesView extends ItemView {
	private filter = "";
	private busy = false;

	constructor(leaf: WorkspaceLeaf, private plugin: EnglishLearningPlugin) {
		super(leaf);
	}
	getViewType() {
		return PHRASES_VIEW;
	}
	getDisplayText() {
		return "句子本";
	}
	getIcon() {
		return "quote";
	}
	async onOpen() {
		this.render();
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
		el.empty();
		el.addClass("el-verify");
		el.addClass("el-practice");
		header(el, "句子本", p, () => this.render());
		const d = await loadPractice(this.app, p.user, "all");
		const items = d.phrases;
		el.createDiv({ cls: "el-muted", text: `共 ${items.length} 句。來源：對話中被糾正的句子、問過「怎麼說」的說法、錯誤分析的練習句，以及答錯的克漏字、翻譯、聽力句子。到「練習 → 句子」可以複習，英文對話也會自然用到到期的句子。` });
		const search = el.createEl("input", { cls: "el-cloze-input", attr: { type: "search", placeholder: "搜尋中文或英文" } });
		search.value = this.filter;
		const list = el.createDiv();
		const draw = () => {
			list.empty();
			const f = this.filter.trim().toLowerCase();
			const shown = items.filter((x) => !f || x.en.toLowerCase().includes(f) || x.zh.includes(f));
			if (!shown.length) list.createDiv({ cls: "el-muted", text: items.length ? "沒有符合的句子" : "還沒有句子。到「英文對話」聊聊看吧。" });
			drawSplit(list, shown, (x) => bookStatus(d.states.get(phraseQid(x.key))), !!f, (parent, x, status) => {
				const st = d.states.get(phraseQid(x.key));
				const card = parent.createDiv({ cls: `el-card el-word-card is-${status}` });
				const head = card.createDiv({ cls: "el-row" });
				statusChip(head, status);
				head.createSpan({ cls: "el-title", text: x.zh || "（中文會在練習時翻譯）" });
				card.createDiv({ cls: "el-say el-sentence", text: x.en });
				if (x.alt) card.createDiv({ cls: "el-say el-sentence el-muted", text: x.alt });
				if (x.source === "correction" && x.original) card.createDiv({ cls: "el-d-typed", text: x.original });
				if (x.note) card.createDiv({ cls: "el-muted", text: x.note });
				const bottom = card.createDiv({ cls: "el-row" });
				bottom.createSpan({ cls: "el-muted", text: `${PHRASE_SOURCE_LABEL[x.source] ?? "問過怎麼說"}${st ? `・下次複習：${relDay(st.due)}` : ""}` });
				const rm = bottom.createEl("button", { text: "移除", cls: "el-zh-btn" });
				rm.onclick = async () => {
					await p.appendLog(p.makeEntry("phrase-remove", { key: x.key }));
					card.remove();
				};
			});
		};
		search.addEventListener("input", () => {
			this.filter = search.value;
			draw();
		});
		draw();
	}
}
