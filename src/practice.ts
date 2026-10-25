// 練習介面：開始前同步 → 依 SRS 出題 → 作答寫 log → 結束並同步。
import { App, ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { FLAG_REASONS, loadFlags } from "./flags";
import { loadFixes, resolveQuestion } from "./fixes";
import type EnglishLearningPlugin from "./main";
import { Bank, ChoiceQ, Level, QType, Question, TYPE_LABEL, TranslateQ, parseBank, stripMarks } from "./generate";
import { BANK_DIR, stripFrontmatter } from "./sources";
import { LOG_ROOT, listRecursive, safeName, uuid } from "./logs";
import { AnswerLog, GradeLog, QState, computeStates, pickSession } from "./srs";
import { gradeTranslation } from "./grade";
import { cachedZh, translateMany } from "./translate";

export const PRACTICE_VIEW = "english-learning-practice";
const LS_PRACTICE = "english-learning:practice"; // { [user]: { level, size, sync } }
export const LS_LAST_SYNC_DONE = "english-learning:last-sync-done";

export type LevelFilter = Level | "all";

export interface PQ {
	q: Question;
	bank: Bank;
	marked: boolean;
	relearn?: boolean;
}

// ---------------------------------------------------------------------
// 資料載入

export async function loadBanks(app: App): Promise<Bank[]> {
	const out: Bank[] = [];
	for (const f of app.vault.getMarkdownFiles()) {
		if (!f.path.startsWith(BANK_DIR + "/")) continue;
		const b = parseBank(await app.vault.cachedRead(f));
		if (b?.questions?.length) out.push(b);
	}
	return out.sort((a, b) => (a.generatedAt < b.generatedAt ? -1 : 1));
}

export async function loadUserLogs(app: App, user: string): Promise<(AnswerLog | GradeLog)[]> {
	const out: (AnswerLog | GradeLog)[] = [];
	for (const path of await listRecursive(app, `${LOG_ROOT}/${safeName(user)}`)) {
		if (!path.endsWith(".jsonl")) continue;
		for (const line of (await app.vault.adapter.read(path)).split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line);
				if (e?.type === "answer" || e?.type === "grade") out.push(e);
			} catch {
				/* 壞行略過 */
			}
		}
	}
	return out;
}

export function questionsFor(banks: Bank[], level: LevelFilter): PQ[] {
	const order: Record<string, number> = { vocab: 0, cloze: 1, reading: 2, translate: 3 };
	const out: PQ[] = [];
	for (const b of banks) {
		if (level !== "all" && b.level !== level) continue;
		const qs = [...b.questions].sort((x, y) => order[x.type] - order[y.type]);
		for (const q of qs) out.push({ q, bank: b, marked: q.type !== "translate" && !!(q as ChoiceQ).marked });
	}
	return out;
}

export interface PracticeData {
	pqs: PQ[];
	states: Map<string, QState>;
	logs: (AnswerLog | GradeLog)[];
}

export async function loadPractice(app: App, user: string, level: LevelFilter): Promise<PracticeData> {
	const [banks, logs, flags, fixes] = await Promise.all([loadBanks(app), loadUserLogs(app, user), loadFlags(app), loadFixes(app)]);
	// 被回報的題目：有修正題就換成修正題，沒有就不出
	const flagged = new Set(flags.keys());
	const pqs: PQ[] = [];
	for (const x of questionsFor(banks, level)) {
		const q = resolveQuestion(x.q, flagged, fixes);
		if (!q) continue;
		pqs.push(q === x.q ? x : { q, bank: x.bank, marked: q.type !== "translate" && !!(q as ChoiceQ).marked });
	}
	const marked = new Set(pqs.filter((p) => p.marked).map((p) => p.q.id));
	return { pqs, states: computeStates(logs, marked), logs };
}

/** 這台裝置自己的、還沒批改的翻譯作答（只批改自己的，避免兩台同時批改同一題）。 */
export function pendingAnswers(logs: (AnswerLog | GradeLog)[], deviceId: string): AnswerLog[] {
	const graded = new Set(logs.filter((e): e is GradeLog => e.type === "grade").map((g) => g.answerId));
	return logs.filter((e): e is AnswerLog => e.type === "answer" && !!e.pending && e.device === deviceId && !graded.has(e.id));
}

// ---------------------------------------------------------------------

interface Result {
	pq: PQ;
	correct?: boolean;
	pending?: boolean;
}

interface Prefs {
	level: LevelFilter;
	size: number;
	sync: boolean;
}

type Phase = "start" | "busy" | "question" | "done";

const TYPES: QType[] = ["vocab", "cloze", "reading", "translate"];
const TYPE_HINT: Record<QType, string> = {
	vocab: "看英文選中文（或反過來）",
	cloze: "句子挖空，自己打出那個字",
	reading: "依文章內容回答問題",
	translate: "中翻英，AI 批改",
};

/** 比對打字答案：不分大小寫、忽略多餘空白、彎引號、句尾標點。 */
export function normAnswer(s: string): string {
	return s
		.toLowerCase()
		.replace(/[’‘]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/\s+/g, " ")
		.replace(/^[\s"'(]+|[\s"'.,!?;:)]+$/g, "")
		.trim();
}

export function sameAnswer(typed: string, answer: string): boolean {
	return normAnswer(typed) === normAnswer(answer);
}

/** 字首提示：d _ _ _ (4)；片語保留空格。 */
export function letterHint(answer: string): string {
	const words = answer.trim().split(/\s+/);
	const shown = words.map((w) => w.split("").map((ch, i) => (i === 0 || !/[a-z]/i.test(ch) ? ch : "_")).join(" ")).join("   ");
	const count = words.map((w) => w.replace(/[^a-z]/gi, "").length).join(" + ");
	return `${shown}（${count} 個字母）`;
}

/** 只差一個字母（多、少、錯一個）。 */
export function nearMiss(typed: string, answer: string): boolean {
	const a = normAnswer(typed);
	const b = normAnswer(answer);
	if (!a || a === b || Math.abs(a.length - b.length) > 1 || b.length < 4) return false;
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

export class PracticeView extends ItemView {
	private phase: Phase = "start";
	private busyText = "";
	private sessionId = "";
	private sessionType: QType = "vocab";
	private items: PQ[] = [];
	private idx = 0;
	private results: Result[] = [];
	private requeued = new Set<string>();
	private answered = false;
	private hintUsed = false;

	constructor(leaf: WorkspaceLeaf, private plugin: EnglishLearningPlugin) {
		super(leaf);
	}
	getViewType() {
		return PRACTICE_VIEW;
	}
	getDisplayText() {
		return "練習";
	}
	getIcon() {
		return "graduation-cap";
	}

	async onOpen() {
		this.render();
	}

	/** 外部刷新（同步、設定變更）只在開始畫面重畫，練習中不打斷。 */
	render() {
		if (this.phase === "start") this.drawStart();
		else if (this.phase === "busy") this.drawBusy();
	}

	// ---- 偏好（每台裝置、每位使用者） ----
	private prefs(): Prefs {
		const all = (this.app.loadLocalStorage(LS_PRACTICE) ?? {}) as Record<string, Partial<Prefs>>;
		const u = this.plugin.user;
		return { level: u === "kid" ? "kid" : "adult", size: 20, sync: true, ...(all[u] ?? {}) };
	}

	private savePrefs(p: Prefs) {
		const all = (this.app.loadLocalStorage(LS_PRACTICE) ?? {}) as Record<string, unknown>;
		all[this.plugin.user] = p;
		this.app.saveLocalStorage(LS_PRACTICE, all);
	}

	private root(): HTMLElement {
		const el = this.contentEl;
		el.empty();
		el.addClass("el-verify");
		el.addClass("el-practice");
		return el;
	}

	// ---- 開始畫面：選題型 ----
	private async drawStart() {
		const p = this.plugin;
		const el = this.root();
		el.createEl("h3", { text: "練習" });
		const prefs = this.prefs();

		el.createDiv({ cls: "el-row" }, (r) => {
			r.createSpan({ text: "使用者" });
			const sel = r.createEl("select", { cls: "dropdown" });
			for (const u of p.settings.users) sel.createEl("option", { text: u, value: u });
			sel.value = p.user;
			sel.onchange = () => {
				p.user = sel.value;
				this.drawStart();
			};
			r.createSpan({ text: "題庫" });
			const lv = r.createEl("select", { cls: "dropdown" });
			lv.createEl("option", { text: "成人", value: "adult" });
			lv.createEl("option", { text: "小孩", value: "kid" });
			lv.createEl("option", { text: "全部", value: "all" });
			lv.value = prefs.level;
			lv.onchange = () => {
				this.savePrefs({ ...prefs, level: lv.value as LevelFilter });
				this.drawStart();
			};
			r.createSpan({ text: "題數" });
			const size = r.createEl("input", { cls: "el-size-input", attr: { type: "number", min: "1", max: "200", step: "1", inputmode: "numeric" } });
			size.value = String(prefs.size);
			const saveSize = () => {
				const n = Math.max(1, Math.min(200, Math.floor(Number(size.value)) || 20));
				size.value = String(n);
				this.savePrefs({ ...this.prefs(), size: n });
			};
			size.onchange = saveSize;
			size.onblur = saveSize;
		});
		el.createDiv({ cls: "el-row" }, (r) => {
			const cb = r.createEl("input", { attr: { type: "checkbox", id: "el-sync-first" } });
			cb.checked = prefs.sync;
			cb.onchange = () => this.savePrefs({ ...this.prefs(), sync: cb.checked });
			r.createEl("label", { text: "開始前先同步（下載其他裝置的進度）", attr: { for: "el-sync-first" } });
		});

		const list = el.createDiv({ cls: "el-types" });
		list.createDiv({ cls: "el-muted", text: "計算中…" });
		const last = this.app.loadLocalStorage(LS_LAST_SYNC_DONE);
		el.createDiv({ cls: "el-muted", text: `上次「結束並同步」：${typeof last === "string" ? new Date(last).toLocaleString() : "還沒有"}` });

		try {
			const d = await loadPractice(this.app, p.user, prefs.level);
			if (this.phase !== "start") return;
			list.empty();
			if (!d.pqs.length) {
				list.createDiv({ cls: "el-muted", text: "這個題庫還沒有題目。先到主畫面匯入文章並出題。" });
				return;
			}
			for (const t of TYPES) {
				const qs = d.pqs.filter((x) => x.q.type === t);
				const pick = pickSession(qs.map((x) => ({ id: x.q.id, marked: x.marked })), d.states, 100000);
				const card = list.createDiv({ cls: "el-type-card" });
				const info = card.createDiv({ cls: "el-type-info" });
				info.createDiv({ cls: "el-title", text: TYPE_LABEL[t] });
				info.createDiv({ cls: "el-muted", text: TYPE_HINT[t] });
				info.createDiv({ text: `到期 ${pick.dueTotal}・新題 ${pick.freshTotal}・共 ${qs.length}` });
				const b = card.createEl("button", { text: "開始", cls: pick.dueTotal + pick.freshTotal ? "mod-cta" : "" });
				b.disabled = !qs.length;
				b.onclick = () => this.start(t);
			}
			const pend = pendingAnswers(d.logs, p.deviceId).length;
			if (pend) list.createDiv({ cls: "el-muted", text: `${pend} 題翻譯等待批改（連上網路開始練習時會自動批改）` });
		} catch (e) {
			list.empty();
			list.createDiv({ cls: "el-warn", text: `讀取失敗：${(e as Error)?.message ?? e}` });
		}
	}

	private drawBusy() {
		const el = this.root();
		el.createEl("h3", { text: "練習" });
		el.createDiv({ cls: "el-busy", text: this.busyText });
	}

	private setBusy(t: string) {
		this.phase = "busy";
		this.busyText = t;
		this.drawBusy();
	}

	// ---- 開始 ----
	private async start(type: QType) {
		const p = this.plugin;
		const prefs = this.prefs();
		if (prefs.sync) {
			this.setBusy("同步中…（下載其他裝置的進度）");
			const ok = await p.syncAndWait((s) => {
				this.busyText = s;
				this.drawBusy();
			});
			if (!ok) new Notice("沒有完成同步，改用這台裝置上的資料練習", 6000);
		}
		this.setBusy("準備題目…");
		const d = await loadPractice(this.app, p.user, prefs.level);
		this.gradePendingInBackground(d.logs);

		const pqs = d.pqs.filter((x) => x.q.type === type);
		const pick = pickSession(pqs.map((x) => ({ id: x.q.id, marked: x.marked })), d.states, prefs.size);
		const byId = new Map(pqs.map((x) => [x.q.id, x]));
		this.items = [...pick.due, ...pick.fresh].map((x) => byId.get(x.id)!).filter(Boolean);
		if (!this.items.length) {
			this.phase = "start";
			this.drawStart();
			new Notice(`「${TYPE_LABEL[type]}」今天沒有到期的題目了，明天再來！`);
			return;
		}
		this.sessionType = type;
		this.sessionId = uuid();
		this.idx = 0;
		this.results = [];
		this.requeued.clear();
		this.phase = "question";
		p.debug(`practice start user=${p.user} type=${type} items=${this.items.length} (due ${pick.due.length}, new ${pick.fresh.length})`);
		this.drawQuestion();
	}

	private async gradePendingInBackground(logs: (AnswerLog | GradeLog)[]) {
		const p = this.plugin;
		const pend = pendingAnswers(logs, p.deviceId);
		if (!pend.length || !p.getApiKey()) return;
		const banks = await loadBanks(this.app);
		const qmap = new Map<string, { q: TranslateQ; level: Level }>();
		for (const b of banks) for (const q of b.questions) if (q.type === "translate") qmap.set(q.id, { q, level: b.level });
		let done = 0;
		for (const a of pend) {
			const hit = qmap.get(a.qid);
			if (!hit || !a.text) continue;
			try {
				const r = await gradeTranslation(p.backend(), hit.q, a.text, hit.level);
				await p.appendLog(p.makeEntry("grade", { answerId: a.id, qid: a.qid, score: r.score, correct: r.correct, feedback: r.feedback, corrected: r.corrected }));
				done++;
			} catch (e) {
				p.debug(`grade pending failed: ${(e as Error)?.message ?? e}`);
				break; // 多半是離線或額度問題，下次再試
			}
		}
		if (done) new Notice(`已批改 ${done} 題之前離線時的翻譯`);
	}

	// ---- 中文翻譯按鈕 ----

	/** 取得翻譯：題庫已有就用，沒有就即時翻譯（會快取在這台裝置）。 */
	private async zhFor(texts: string[], given?: (string | undefined)[]): Promise<string[]> {
		if (given && given.length === texts.length && given.every(Boolean)) return given as string[];
		const cached = texts.map((t) => cachedZh(this.app, t));
		if (cached.every(Boolean)) return cached as string[];
		if (!navigator.onLine) throw new Error("這份題庫沒有內建翻譯，需要連上網路才能翻譯");
		return translateMany(this.app, this.plugin.backend(), texts);
	}

	/** 在 parent 裡加一個「中」按鈕；按下後在 target 顯示翻譯。作答前按下算看提示。 */
	private zhButton(parent: HTMLElement, target: HTMLElement, get: () => Promise<string> | string, countsAsHint = true) {
		const btn = parent.createEl("button", { cls: "el-zh-btn", text: "中" });
		const box = target.createDiv({ cls: "el-zh" });
		box.style.display = "none";
		let loaded = false;
		btn.onclick = async (e) => {
			e.stopPropagation();
			if (box.style.display !== "none") {
				box.style.display = "none";
				btn.removeClass("is-on");
				return;
			}
			if (countsAsHint && !this.answered) this.hintUsed = true;
			box.style.display = "";
			btn.addClass("is-on");
			if (loaded) return;
			box.setText("翻譯中…");
			try {
				box.setText(await get());
				loaded = true;
			} catch (err) {
				box.setText(`無法翻譯：${(err as Error)?.message ?? err}`);
			}
		};
	}

	/** 一行英文（可點擊朗讀）＋「中」按鈕＋翻譯區。 */
	private sentence(parent: HTMLElement, text: string, zh: string | undefined, cls = "el-sentence") {
		const wrap = parent.createDiv({ cls: "el-line-wrap" });
		const line = wrap.createDiv({ cls: "el-line" });
		line.createSpan({ cls: `el-say ${cls}`, text });
		this.zhButton(line, wrap, async () => (await this.zhFor([text], [zh]))[0]);
	}

	/** 選項的中文：一個按鈕切換全部選項下方的中文。 */
	private optionsZhButton(parent: HTMLElement, q: ChoiceQ, buttons: HTMLButtonElement[]) {
		const english = q.type !== "vocab" || q.direction === "zh2en";
		if (!english) return;
		const row = parent.createDiv({ cls: "el-row el-opts-zh-row" });
		row.createSpan({ cls: "el-muted", text: "選項中文" });
		const holder = row.createDiv();
		holder.style.display = "none";
		this.zhButton(row, holder, async () => {
			const zh = await this.zhFor(q.options, q.optionsZh);
			buttons.forEach((b, i) => {
				let span = b.querySelector(".el-opt-zh") as HTMLElement | null;
				if (!span) span = b.createDiv({ cls: "el-opt-zh" });
				span.setText(zh[i] ?? "");
			});
			return "";
		});
		// 第二次按「中」時切換顯示
		const btn = row.querySelector(".el-zh-btn") as HTMLButtonElement;
		btn.addEventListener("click", () => {
			const on = btn.hasClass("is-on");
			buttons.forEach((b) => {
				const span = b.querySelector(".el-opt-zh") as HTMLElement | null;
				if (span) span.style.display = on ? "" : "none";
			});
		});
	}

	// ---- 出題 ----
	private drawQuestion() {
		const el = this.root();
		const pq = this.items[this.idx];
		const q = pq.q;
		this.answered = false;
		this.hintUsed = false;

		const top = el.createDiv({ cls: "el-row el-top" });
		const realTotal = this.items.filter((x) => !x.relearn).length;
		const realIdx = this.items.slice(0, this.idx + 1).filter((x) => !x.relearn).length;
		top.createSpan({ cls: "el-user-badge", text: `👤 ${this.plugin.user}` });
		top.createSpan({ cls: "el-muted", text: pq.relearn ? "再練一次" : `${realIdx} / ${realTotal}` });
		top.createSpan({ cls: "el-badge", text: TYPE_LABEL[q.type] });
		if (pq.marked) top.createSpan({ cls: "el-badge", text: "⭐生字" });
		const quit = top.createEl("a", { text: "結束", cls: "el-quit" });
		quit.onclick = () => this.finish();
		const flag = top.createEl("a", { text: "⚑ 回報", cls: "el-flag" });
		flag.onclick = () => new FlagModal(this.app, (reason) => this.flagCurrent(reason)).open();
		el.createDiv({ cls: "el-progress" }).createDiv({ cls: "el-progress-bar" }).style.width = `${Math.round((this.idx / this.items.length) * 100)}%`;

		const card = el.createDiv({ cls: "el-qcard" });
		if (q.type === "translate") return this.drawTranslate(card, pq, q);

		const cq = q as ChoiceQ;
		if (cq.type === "vocab" && cq.direction !== "zh2en") {
			const wrap = card.createDiv({ cls: "el-line-wrap" });
			const w = wrap.createDiv({ cls: "el-qword el-line" });
			w.createSpan({ cls: "el-say", text: cq.prompt });
			if (cq.ipa) w.createSpan({ cls: "el-ipa", text: ` ${cq.ipa}` });
			this.zhButton(w, wrap, () => cq.options[cq.answer]); // 單字的中文就是答案
			if (cq.context) this.sentence(card, cq.context, cq.contextZh, "el-sentence el-context");
			card.createDiv({ cls: "el-muted", text: "選出在這句裡的意思" });
		} else if (cq.type === "vocab") {
			card.createDiv({ cls: "el-qword", text: cq.prompt });
			card.createDiv({ cls: "el-muted", text: "選出對應的英文" });
		} else if (cq.type === "cloze") {
			return this.drawCloze(card, pq, cq);
		} else {
			const wrap = card.createDiv({ cls: "el-line-wrap" });
			const line = wrap.createDiv({ cls: "el-line el-qtext" });
			line.createSpan({ cls: "el-say", text: cq.prompt });
			this.zhButton(line, wrap, async () => (await this.zhFor([cq.prompt], [cq.promptZh]))[0]);
			this.articleToggle(card, pq.bank);
		}

		const opts = card.createDiv({ cls: "el-opts" });
		const buttons: HTMLButtonElement[] = [];
		cq.options.forEach((o, i) => {
			const b = opts.createEl("button", { cls: "el-opt" });
			b.createDiv({ text: `${"ABCD"[i]}. ${o}` });
			buttons.push(b);
			b.onclick = () => this.answerChoice(card, pq, cq, i, buttons);
		});
		this.optionsZhButton(card, cq, buttons);
		const idk = card.createEl("button", { cls: "el-idk", text: "我不知道" });
		idk.onclick = () => {
			idk.disabled = true;
			this.answerChoice(card, pq, cq, -1, buttons);
		};
	}

	private articleToggle(card: HTMLElement, bank: Bank) {
		const det = card.createEl("details", { cls: "el-article" });
		det.createEl("summary", { text: "📄 顯示文章" });
		const body = det.createDiv();
		let loaded = false;
		det.addEventListener("toggle", async () => {
			if (!det.open || loaded) return;
			loaded = true;
			const f = this.app.vault.getAbstractFileByPath(bank.sourcePath);
			if (!(f instanceof TFile)) return body.setText("找不到文章（可能還沒同步）");
			const text = stripMarks(stripFrontmatter(await this.app.vault.cachedRead(f)));
			for (const para of text.split(/\n/).map((s) => s.trim()).filter(Boolean)) {
				const wrap = body.createDiv({ cls: "el-line-wrap el-para" });
				const line = wrap.createDiv({ cls: "el-line" });
				line.createSpan({ text: para });
				this.zhButton(line, wrap, async () => (await this.zhFor([para]))[0]);
			}
		});
	}

	private async answerChoice(card: HTMLElement, pq: PQ, q: ChoiceQ, choice: number, buttons: HTMLButtonElement[]) {
		if (this.answered) return;
		this.answered = true;
		const dontKnow = choice < 0;
		const correct = choice === q.answer;
		buttons.forEach((b, i) => {
			b.disabled = true;
			if (i === q.answer) b.addClass("el-ok-opt");
			else if (i === choice) b.addClass("el-bad-opt");
		});
		card.querySelectorAll(".el-idk").forEach((b) => ((b as HTMLButtonElement).disabled = true));
		this.record(pq, { correct, choice: dontKnow ? undefined : choice, dontKnow, hint: this.hintUsed });

		const fb = card.createDiv({ cls: `el-feedback ${correct ? "is-ok" : "is-bad"}` });
		const verdict = correct ? (this.hintUsed ? "✓ 答對了（看過中文，這次不拉長間隔）" : "✓ 答對了") : `${dontKnow ? "答案是" : "✗ 正確答案是"} ${"ABCD"[q.answer]}. ${q.options[q.answer]}`;
		fb.createDiv({ cls: "el-verdict", text: verdict });
		if (q.type === "vocab" && q.direction === "zh2en" && q.word) {
			const w = fb.createDiv({ cls: "el-qword-small" });
			w.createSpan({ cls: "el-say", text: q.word });
			if (q.ipa) w.createSpan({ cls: "el-ipa", text: ` ${q.ipa}` });
			if (q.context) this.sentence(fb, q.context, q.contextZh);
		}
		if (q.type === "cloze") this.sentence(fb, q.prompt.replace("____", q.options[q.answer]), q.promptZh);
		if (q.explanation) fb.createDiv({ cls: "el-explain", text: q.explanation });
		this.nextButton(card);
	}

	/** 克漏字：打字作答（題庫裡的 options[answer] 就是答案，其他選項不再顯示）。 */
	private drawCloze(card: HTMLElement, pq: PQ, q: ChoiceQ) {
		const answer = q.options[q.answer];
		const full = q.prompt.replace("____", answer);
		const wrap = card.createDiv({ cls: "el-line-wrap" });
		const line = wrap.createDiv({ cls: "el-line el-qtext" });
		line.createSpan({ text: q.prompt });
		this.zhButton(line, wrap, async () => (await this.zhFor([full], [q.promptZh]))[0]);

		// 提示：字首與字母數、中文意思（看了算提示）
		const hints = card.createDiv({ cls: "el-row el-hints" });
		const out1 = card.createDiv({ cls: "el-zh" });
		const out2 = card.createDiv({ cls: "el-zh" });
		out1.style.display = out2.style.display = "none";
		const showHint = (out: HTMLElement, t: string) => {
			if (!this.answered) this.hintUsed = true;
			out.style.display = "";
			out.setText(t);
		};
		const h1 = hints.createEl("button", { cls: "el-zh-btn", text: "提示：字首" });
		h1.onclick = () => {
			h1.addClass("is-on");
			showHint(out1, letterHint(answer));
		};
		const h2 = hints.createEl("button", { cls: "el-zh-btn", text: "提示：中文" });
		h2.onclick = async () => {
			h2.addClass("is-on");
			showHint(out2, "翻譯中…");
			try {
				showHint(out2, (await this.zhFor([answer], [q.optionsZh?.[q.answer]]))[0]);
			} catch (e) {
				showHint(out2, `無法翻譯：${(e as Error)?.message ?? e}`);
			}
		};

		const input = card.createEl("input", {
			cls: "el-cloze-input",
			attr: { type: "text", autocapitalize: "off", autocorrect: "off", autocomplete: "off", spellcheck: "false", placeholder: "打出空格裡的字" },
		});
		const row = card.createDiv({ cls: "el-row el-big-buttons" });
		const send = row.createEl("button", { text: "送出", cls: "mod-cta" });
		const idk = row.createEl("button", { text: "我不知道" });

		const done = (typed: string, dontKnow: boolean) => {
			if (this.answered) return;
			this.answered = true;
			input.disabled = true;
			send.disabled = true;
			idk.disabled = true;
			const correct = !dontKnow && sameAnswer(typed, answer);
			this.record(pq, { correct, text: typed, dontKnow, hint: this.hintUsed });
			const fb = card.createDiv({ cls: `el-feedback ${correct ? "is-ok" : "is-bad"}` });
			let verdict: string;
			if (correct) verdict = this.hintUsed ? "✓ 答對了（看過提示，這次不拉長間隔）" : "✓ 答對了";
			else if (dontKnow) verdict = `答案是 ${answer}`;
			else verdict = `✗ 你寫的是「${typed}」，正確是「${answer}」${nearMiss(typed, answer) ? "（拼字差一點）" : ""}`;
			fb.createDiv({ cls: "el-verdict", text: verdict });
			const w = fb.createDiv({ cls: "el-qword-small" });
			w.createSpan({ cls: "el-say", text: answer });
			this.sentence(fb, full, q.promptZh);
			if (q.explanation) fb.createDiv({ cls: "el-explain", text: q.explanation });
			this.nextButton(card);
		};
		send.onclick = () => {
			const typed = input.value.trim();
			if (!typed) return new Notice("先打出答案，或按「我不知道」");
			done(typed, false);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				send.click();
			}
		});
		idk.onclick = () => done("", true);
		window.setTimeout(() => input.focus(), 50);
	}

	private drawTranslate(card: HTMLElement, pq: PQ, q: TranslateQ) {
		card.createDiv({ cls: "el-muted", text: "翻成英文（可用鍵盤的麥克風說出來）" });
		card.createDiv({ cls: "el-qword", text: q.prompt });
		const ta = card.createEl("textarea", { cls: "el-textarea el-answer", attr: { rows: "3", autocapitalize: "sentences", placeholder: "Type your English here" } });
		const row = card.createDiv({ cls: "el-row el-big-buttons" });
		const send = row.createEl("button", { text: "送出", cls: "mod-cta" });
		const giveUp = row.createEl("button", { text: "我不知道" });
		const out = card.createDiv();

		const finish = (res: { correct?: boolean; pending?: boolean; score?: number; feedback?: string; corrected?: string; dontKnow?: boolean }, text: string) => {
			ta.disabled = true;
			send.disabled = true;
			giveUp.disabled = true;
			this.record(pq, { correct: res.correct, pending: res.pending, text, score: res.score, feedback: res.feedback, corrected: res.corrected, dontKnow: res.dontKnow });
			const ok = res.correct === true;
			const fb = out.createDiv({ cls: `el-feedback ${res.pending ? "" : ok ? "is-ok" : "is-bad"}` });
			if (res.pending) fb.createDiv({ cls: "el-verdict", text: "已記錄，之後連上網路會自動批改" });
			else if (res.score !== undefined) fb.createDiv({ cls: "el-verdict", text: `${ok ? "✓" : "✗"} ${res.score} 分` });
			else fb.createDiv({ cls: "el-verdict", text: "參考答案" });
			if (res.feedback) fb.createDiv({ cls: "el-explain", text: res.feedback });
			if (res.corrected && res.corrected !== text.trim()) {
				fb.createDiv({ cls: "el-muted", text: "修改後：" });
				fb.createDiv({ cls: "el-say el-sentence", text: res.corrected });
			}
			fb.createDiv({ cls: "el-muted", text: "參考答案：" });
			fb.createDiv({ cls: "el-say el-sentence", text: q.reference });
			if (q.explanation) fb.createDiv({ cls: "el-explain", text: q.explanation });
			this.nextButton(card);
		};

		giveUp.onclick = () => {
			if (this.answered) return;
			this.answered = true;
			finish({ correct: false, dontKnow: true }, "");
		};
		send.onclick = async () => {
			const text = ta.value.trim();
			if (!text) return new Notice("先輸入你的翻譯");
			if (this.answered) return;
			this.answered = true;
			send.setText("批改中…");
			send.disabled = true;
			try {
				if (!navigator.onLine) throw new Error("offline");
				const r = await gradeTranslation(this.plugin.backend(), q, text, pq.bank.level);
				finish({ correct: r.correct, score: r.score, feedback: r.feedback, corrected: r.corrected }, text);
			} catch (e) {
				this.plugin.debug(`grade failed: ${(e as Error)?.message ?? e}`);
				finish({ pending: true }, text);
			}
		};
	}

	private record(
		pq: PQ,
		r: { correct?: boolean; choice?: number; pending?: boolean; text?: string; score?: number; feedback?: string; corrected?: string; hint?: boolean; dontKnow?: boolean },
	) {
		const p = this.plugin;
		const extra: Record<string, unknown> = {
			qid: pq.q.id,
			bank: pq.bank.sourceId,
			qtype: pq.q.type,
			session: this.sessionId,
		};
		if (r.correct !== undefined) extra.correct = r.correct;
		if (r.choice !== undefined) extra.choice = r.choice;
		if (r.text !== undefined) extra.text = r.text;
		if (r.score !== undefined) extra.score = r.score;
		if (r.feedback) extra.feedback = r.feedback;
		if (r.corrected) extra.corrected = r.corrected;
		if (r.pending) extra.pending = true;
		if (r.hint) extra.hint = true;
		if (r.dontKnow) extra.dontKnow = true;
		if (pq.relearn) extra.relearn = true;
		if (pq.marked) extra.marked = true;
		p.appendLog(p.makeEntry("answer", extra)).catch((e) => new Notice(`寫入紀錄失敗：${(e as Error)?.message ?? e}`));

		if (!pq.relearn) this.results.push({ pq, correct: r.correct, pending: r.pending });
		// 答錯的題目在這場最後再練一次（只重出一次）
		if (r.correct === false && !pq.relearn && !this.requeued.has(pq.q.id)) {
			this.requeued.add(pq.q.id);
			this.items.push({ ...pq, relearn: true });
		}
	}

	private async flagCurrent(reason: string) {
		const p = this.plugin;
		const pq = this.items[this.idx];
		await p.appendLog(p.makeEntry("flag", { qid: pq.q.id, bank: pq.bank.sourceId, qtype: pq.q.type, reason })).catch(() => undefined);
		// 這場後面如果還排了這題（答錯重練），也拿掉
		this.items = this.items.filter((x, i) => i <= this.idx || x.q.id !== pq.q.id);
		p.debug(`flag ${pq.q.id} (${reason})`);
		const wasAnswered = this.answered;
		this.answered = true;

		// 請 AI 出修正題
		const note = this.contentEl.createDiv({ cls: "el-busy", text: "已回報。AI 正在出一題修正版…" });
		note.scrollIntoView({ block: "nearest" });
		const out = await p.fixQuestion(pq.bank, pq.q, reason);
		if (out?.kind === "originalCorrect") {
			// 原題沒錯：已自動恢復
			new Notice(`AI 判斷原本的答案是對的：${out.message}`, 12000);
			if (!wasAnswered) {
				this.items[this.idx] = pq;
				return this.drawQuestion();
			}
			note.setText(`AI 判斷原本的答案是對的：${out.message}（這題已恢復出題）`);
			return;
		}
		if (out?.kind === "replaced") {
			const fixed = out.question;
			const npq: PQ = { q: fixed, bank: pq.bank, marked: fixed.type !== "translate" && !!(fixed as ChoiceQ).marked };
			const msg = out.sameId ? "已修正中文與解釋（練習進度保留）" : "已換成修正後的題目";
			if (!wasAnswered) {
				new Notice(out.message ? `${msg}：${out.message}` : msg, 8000);
				this.items[this.idx] = npq;
				return this.drawQuestion();
			}
			note.setText(`${msg}${out.message ? `：${out.message}` : ""}。${out.sameId ? "" : "之後會當新題出現。"}按「下一題」繼續。`);
			return;
		}
		note.setText("暫時無法出修正版（可能沒有網路）。這題先跳過，之後可在主畫面的回報清單按「重新出這題」。");
		if (wasAnswered) return;
		window.setTimeout(() => {
			if (this.idx >= this.items.length - 1) return this.finish();
			this.idx++;
			this.drawQuestion();
		}, 1500);
	}

	private nextButton(card: HTMLElement) {
		const row = card.createDiv({ cls: "el-row el-big-buttons" });
		const last = this.idx >= this.items.length - 1;
		const b = row.createEl("button", { text: last ? "看結果" : "下一題", cls: "mod-cta" });
		b.onclick = () => {
			if (last) return this.finish();
			this.idx++;
			this.drawQuestion();
		};
		b.scrollIntoView({ block: "nearest" });
	}

	// ---- 結束 ----
	private finish() {
		this.phase = "done";
		const el = this.root();
		el.createEl("h3", { text: `練習結果：${TYPE_LABEL[this.sessionType]}` });
		const graded = this.results.filter((r) => r.correct !== undefined);
		const right = graded.filter((r) => r.correct).length;
		const pend = this.results.filter((r) => r.pending).length;
		el.createDiv({ cls: "el-big", text: graded.length ? `${right} / ${graded.length}` : "—" });
		if (pend) el.createDiv({ cls: "el-muted", text: `${pend} 題翻譯等待批改` });

		const wrong = this.results.filter((r) => r.correct === false);
		if (wrong.length) {
			el.createEl("h4", { text: "這次答錯的（明天會再出現）" });
			const ul = el.createEl("ul");
			for (const r of wrong) {
				const q = r.pq.q;
				const li = ul.createEl("li");
				if (q.type === "vocab" && q.word) {
					li.createSpan({ cls: "el-say", text: q.word });
					li.createSpan({ cls: "el-muted", text: `　${q.direction === "zh2en" ? q.prompt : q.options[q.answer]}` });
				} else li.createSpan({ text: q.type === "translate" ? q.prompt : q.prompt.slice(0, 80) });
			}
		}

		const status = el.createDiv({ cls: "el-muted" });
		el.createDiv({ cls: "el-row el-big-buttons" }, (r) => {
			const end = r.createEl("button", { text: "結束並同步", cls: "mod-cta" });
			end.onclick = async () => {
				end.disabled = true;
				status.setText("同步中…請等上傳完成再離開");
				const ok = await this.plugin.syncAndWait((s) => status.setText(s));
				if (ok) {
					const now = new Date().toISOString();
					this.app.saveLocalStorage(LS_LAST_SYNC_DONE, now);
					status.setText(`✓ 已同步（${new Date(now).toLocaleTimeString()}），可以關掉了`);
				} else {
					status.setText("同步沒有完成。紀錄已存在這台裝置，下次同步時會上傳。");
					end.disabled = false;
				}
			};
			const again = r.createEl("button", { text: "換一種題型" });
			again.onclick = () => {
				this.phase = "start";
				this.drawStart();
			};
		});
		this.plugin.debug(`practice end type=${this.sessionType} right=${right}/${graded.length} pending=${pend}`);
	}
}

export class FlagModal extends Modal {
	private reason = FLAG_REASONS[0];
	private note = "";
	constructor(app: App, private onOk: (reason: string) => void) {
		super(app);
	}
	onOpen() {
		this.setTitle("這題有問題");
		this.contentEl.createEl("p", { text: "回報後，這題對所有人都不會再出現。之後可以在主畫面恢復。" });
		new Setting(this.contentEl).setName("原因").addDropdown((d) => {
			for (const r of FLAG_REASONS) d.addOption(r, r);
			d.setValue(this.reason).onChange((v) => (this.reason = v));
		});
		new Setting(this.contentEl).setName("補充（可留空）").addText((t) => t.onChange((v) => (this.note = v)));
		const row = this.contentEl.createDiv({ cls: "el-row el-modal-buttons" });
		row.createEl("button", { text: "取消" }).onclick = () => this.close();
		row.createEl("button", { text: "回報", cls: "mod-warning" }).onclick = () => {
			this.close();
			this.onOk(this.note.trim() ? `${this.reason}：${this.note.trim()}` : this.reason);
		};
	}
	onClose() {
		this.contentEl.empty();
	}
}
