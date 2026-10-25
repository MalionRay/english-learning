// 生字本與學習統計畫面
import { ItemView, WorkspaceLeaf } from "obsidian";
import type EnglishLearningPlugin from "./main";
import { TYPE_LABEL } from "./generate";
import { loadPractice } from "./practice";
import { computeStats, wordQid } from "./words";
import { phraseQid } from "./chat";
import type { AnswerLog, GradeLog } from "./srs";

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
			const shown = words.filter((w) => !f || w.key.includes(f) || (w.meaning ?? "").includes(f));
			if (!shown.length) list.createDiv({ cls: "el-muted", text: words.length ? "沒有符合的字" : "還沒有生字。練習時點句子裡的字可以加入。" });
			for (const w of shown) {
				const st = d.states.get(wordQid(w.key));
				const card = list.createDiv({ cls: "el-card el-word-card" });
				const top = card.createDiv({ cls: "el-row" });
				top.createSpan({ cls: "el-say el-title", text: w.word });
				if (w.ipa) top.createSpan({ cls: "el-ipa", text: w.ipa });
				top.createSpan({ text: w.meaning ?? "" });
				if (w.context) card.createDiv({ cls: "el-say el-sentence el-muted", text: w.context });
				const tags: string[] = [];
				if (w.reasons.has("marked")) tags.push("⭐標記");
				if (w.wrong) tags.push(`答錯 ${w.wrong} 次`);
				if (w.reasons.has("manual")) tags.push("自己加入");
				tags.push(st ? `下次複習：${relDay(st.due)}` : "還沒複習過");
				const bottom = card.createDiv({ cls: "el-row" });
				bottom.createSpan({ cls: "el-muted", text: tags.join("・") });
				const rm = bottom.createEl("button", { text: "移除", cls: "el-zh-btn" });
				rm.onclick = async () => {
					await p.appendLog(p.makeEntry("word-remove", { word: w.word }));
					card.remove();
				};
			}
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
		const labels: Record<string, string> = { ...TYPE_LABEL, word: "生字複習", dictation: "聽寫", listening: "聽力理解", phrase: "句子", speaking: "口說跟讀" };
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
		el.createDiv({ cls: "el-muted", text: `共 ${items.length} 句。來源：對話中被糾正的句子、問過「怎麼說」的說法。到「練習 → 句子」可以複習。` });
		const search = el.createEl("input", { cls: "el-cloze-input", attr: { type: "search", placeholder: "搜尋中文或英文" } });
		search.value = this.filter;
		const list = el.createDiv();
		const draw = () => {
			list.empty();
			const f = this.filter.trim().toLowerCase();
			const shown = items.filter((x) => !f || x.en.toLowerCase().includes(f) || x.zh.includes(f));
			if (!shown.length) list.createDiv({ cls: "el-muted", text: items.length ? "沒有符合的句子" : "還沒有句子。到「英文對話」聊聊看吧。" });
			for (const x of shown) {
				const st = d.states.get(phraseQid(x.key));
				const card = list.createDiv({ cls: "el-card el-word-card" });
				card.createDiv({ cls: "el-title", text: x.zh });
				card.createDiv({ cls: "el-say el-sentence", text: x.en });
				if (x.alt) card.createDiv({ cls: "el-say el-sentence el-muted", text: x.alt });
				if (x.source === "correction" && x.original) card.createDiv({ cls: "el-d-typed", text: x.original });
				if (x.note) card.createDiv({ cls: "el-muted", text: x.note });
				const bottom = card.createDiv({ cls: "el-row" });
				bottom.createSpan({ cls: "el-muted", text: `${x.source === "correction" ? "被糾正" : "問過怎麼說"}・${st ? `下次複習：${relDay(st.due)}` : "還沒複習過"}` });
				const rm = bottom.createEl("button", { text: "移除", cls: "el-zh-btn" });
				rm.onclick = async () => {
					await p.appendLog(p.makeEntry("phrase-remove", { key: x.key }));
					card.remove();
				};
			}
		};
		search.addEventListener("input", () => {
			this.filter = search.value;
			draw();
		});
		draw();
	}
}
