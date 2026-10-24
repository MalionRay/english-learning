// 練習介面：開始前同步 → 依 SRS 出題 → 作答寫 log → 結束並同步。
import { App, ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type EnglishLearningPlugin from "./main";
import { Bank, ChoiceQ, LEVEL_LABEL, Level, Question, TYPE_LABEL, TranslateQ, parseBank, stripMarks } from "./generate";
import { BANK_DIR, stripFrontmatter } from "./sources";
import { LOG_ROOT, listRecursive, safeName, uuid } from "./logs";
import { AnswerLog, GradeLog, QState, computeStates, pickSession } from "./srs";
import { PASS, gradeTranslation } from "./grade";

export const PRACTICE_VIEW = "english-learning-practice";
const LS_PRACTICE = "english-learning:practice"; // { [user]: { level, size } }
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
	const [banks, logs] = await Promise.all([loadBanks(app), loadUserLogs(app, user)]);
	const pqs = questionsFor(banks, level);
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

type Phase = "start" | "busy" | "question" | "done";

export class PracticeView extends ItemView {
	private phase: Phase = "start";
	private busyText = "";
	private sessionId = "";
	private items: PQ[] = [];
	private idx = 0;
	private results: Result[] = [];
	private requeued = new Set<string>();
	private answered = false;
	private level: Level = "adult";

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
	private prefs(): { level: LevelFilter; size: number } {
		const all = (this.app.loadLocalStorage(LS_PRACTICE) ?? {}) as Record<string, { level: LevelFilter; size: number }>;
		const u = this.plugin.user;
		return all[u] ?? { level: u === "kid" ? "kid" : "adult", size: 20 };
	}

	private savePrefs(p: { level: LevelFilter; size: number }) {
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

	// ---- 開始畫面 ----
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
		});
		el.createDiv({ cls: "el-row" }, (r) => {
			r.createSpan({ text: "題庫" });
			const sel = r.createEl("select", { cls: "dropdown" });
			sel.createEl("option", { text: "成人", value: "adult" });
			sel.createEl("option", { text: "小孩", value: "kid" });
			sel.createEl("option", { text: "全部", value: "all" });
			sel.value = prefs.level;
			sel.onchange = () => {
				this.savePrefs({ ...prefs, level: sel.value as LevelFilter });
				this.drawStart();
			};
			r.createSpan({ text: "題數" });
			const size = r.createEl("select", { cls: "dropdown" });
			for (const n of [10, 20, 30]) size.createEl("option", { text: String(n), value: String(n) });
			size.value = String(prefs.size);
			size.onchange = () => this.savePrefs({ ...prefs, size: Number(size.value) });
		});

		const stats = el.createDiv({ cls: "el-muted", text: "計算中…" });
		const last = this.app.loadLocalStorage(LS_LAST_SYNC_DONE);
		el.createDiv({ cls: "el-muted", text: `上次「結束並同步」：${typeof last === "string" ? new Date(last).toLocaleString() : "還沒有"}` });

		el.createDiv({ cls: "el-row el-big-buttons" }, (r) => {
			const go = r.createEl("button", { text: "同步後開始", cls: "mod-cta" });
			go.onclick = () => this.start(true);
			const now = r.createEl("button", { text: "直接開始（不同步）" });
			now.onclick = () => this.start(false);
		});

		try {
			const d = await loadPractice(this.app, p.user, prefs.level);
			if (this.phase !== "start") return;
			const pick = pickSession(d.pqs.map((x) => ({ id: x.q.id, marked: x.marked })), d.states, 10000);
			const pend = pendingAnswers(d.logs, p.deviceId).length;
			stats.setText(
				d.pqs.length
					? `到期 ${pick.dueTotal} 題、還沒練過 ${pick.freshTotal} 題（共 ${d.pqs.length} 題）${pend ? `；${pend} 題翻譯等待批改` : ""}`
					: "這個題庫還沒有題目。先到主畫面匯入文章並出題。",
			);
		} catch (e) {
			stats.setText(`讀取失敗：${(e as Error)?.message ?? e}`);
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
	private async start(sync: boolean) {
		const p = this.plugin;
		const prefs = this.prefs();
		if (sync) {
			this.setBusy("同步中…（下載其他裝置的進度）");
			const ok = await p.syncAndWait((s) => {
				this.busyText = s;
				this.drawBusy();
			});
			if (!ok) new Notice("沒有完成同步，改用這台裝置上的資料練習", 6000);
		}
		this.setBusy("準備題目…");
		const d = await loadPractice(this.app, p.user, prefs.level);

		// 背景批改之前離線時的翻譯
		this.gradePendingInBackground(d.logs);

		const pick = pickSession(d.pqs.map((x) => ({ id: x.q.id, marked: x.marked })), d.states, prefs.size);
		const byId = new Map(d.pqs.map((x) => [x.q.id, x]));
		this.items = [...pick.due, ...pick.fresh].map((x) => byId.get(x.id)!).filter(Boolean);
		if (!this.items.length) {
			this.phase = "start";
			this.drawStart();
			new Notice(d.pqs.length ? "今天沒有到期的題目了，明天再來！" : "還沒有題目，先匯入文章並出題");
			return;
		}
		this.sessionId = uuid();
		this.idx = 0;
		this.results = [];
		this.requeued.clear();
		this.phase = "question";
		p.debug(`practice start user=${p.user} items=${this.items.length} (due ${pick.due.length}, new ${pick.fresh.length})`);
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

	// ---- 出題 ----
	private drawQuestion() {
		const el = this.root();
		const pq = this.items[this.idx];
		const q = pq.q;
		this.answered = false;

		const top = el.createDiv({ cls: "el-row el-top" });
		const realTotal = this.items.filter((x) => !x.relearn).length;
		const realIdx = this.items.slice(0, this.idx + 1).filter((x) => !x.relearn).length;
		top.createSpan({ cls: "el-muted", text: pq.relearn ? "再練一次" : `${realIdx} / ${realTotal}` });
		top.createSpan({ cls: "el-badge", text: TYPE_LABEL[q.type] });
		if (pq.marked) top.createSpan({ cls: "el-badge", text: "⭐生字" });
		const quit = top.createEl("a", { text: "結束", cls: "el-quit" });
		quit.onclick = () => this.finish();
		el.createDiv({ cls: "el-progress" }).createDiv({ cls: "el-progress-bar" }).style.width = `${Math.round((this.idx / this.items.length) * 100)}%`;

		const card = el.createDiv({ cls: "el-qcard" });
		if (q.type === "translate") return this.drawTranslate(card, pq, q);

		const cq = q as ChoiceQ;
		if (cq.type === "vocab" && cq.direction !== "zh2en") {
			const w = card.createDiv({ cls: "el-qword" });
			w.createSpan({ cls: "el-say", text: cq.prompt });
			if (cq.ipa) w.createSpan({ cls: "el-ipa", text: `  ${cq.ipa}` });
			if (cq.context) card.createDiv({ cls: "el-say el-sentence el-context", text: cq.context });
			card.createDiv({ cls: "el-muted", text: "選出在這句裡的意思" });
		} else if (cq.type === "vocab") {
			card.createDiv({ cls: "el-qword", text: cq.prompt });
			card.createDiv({ cls: "el-muted", text: "選出對應的英文" });
		} else if (cq.type === "cloze") {
			card.createDiv({ cls: "el-qtext", text: cq.prompt });
		} else {
			card.createDiv({ cls: "el-qtext", text: cq.prompt });
			this.articleToggle(card, pq.bank);
		}

		const opts = card.createDiv({ cls: "el-opts" });
		const buttons: HTMLButtonElement[] = [];
		cq.options.forEach((o, i) => {
			const b = opts.createEl("button", { cls: "el-opt", text: `${"ABCD"[i]}. ${o}` });
			buttons.push(b);
			b.onclick = () => this.answerChoice(card, pq, cq, i, buttons);
		});
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
			for (const para of text.split(/\n\s*\n|\n/).map((s) => s.trim()).filter(Boolean)) body.createEl("p", { text: para });
		});
	}

	private async answerChoice(card: HTMLElement, pq: PQ, q: ChoiceQ, choice: number, buttons: HTMLButtonElement[]) {
		if (this.answered) return;
		this.answered = true;
		const correct = choice === q.answer;
		buttons.forEach((b, i) => {
			b.disabled = true;
			if (i === q.answer) b.addClass("el-ok-opt");
			else if (i === choice) b.addClass("el-bad-opt");
		});
		this.record(pq, { correct, choice });

		const fb = card.createDiv({ cls: `el-feedback ${correct ? "is-ok" : "is-bad"}` });
		fb.createDiv({ cls: "el-verdict", text: correct ? "✓ 答對了" : `✗ 正確答案是 ${"ABCD"[q.answer]}. ${q.options[q.answer]}` });
		if (q.type === "vocab" && q.direction === "zh2en" && q.word) {
			const w = fb.createDiv({ cls: "el-qword-small" });
			w.createSpan({ cls: "el-say", text: q.word });
			if (q.ipa) w.createSpan({ cls: "el-ipa", text: `  ${q.ipa}` });
			if (q.context) fb.createDiv({ cls: "el-say el-sentence", text: q.context });
		}
		if (q.type === "cloze") fb.createDiv({ cls: "el-say el-sentence", text: q.prompt.replace("____", q.options[q.answer]) });
		if (q.explanation) fb.createDiv({ cls: "el-explain", text: q.explanation });
		this.nextButton(card);
	}

	private drawTranslate(card: HTMLElement, pq: PQ, q: TranslateQ) {
		card.createDiv({ cls: "el-muted", text: "翻成英文（可用鍵盤的麥克風說出來）" });
		card.createDiv({ cls: "el-qword", text: q.prompt });
		const ta = card.createEl("textarea", { cls: "el-textarea el-answer", attr: { rows: "3", autocapitalize: "sentences", placeholder: "Type your English here" } });
		const row = card.createDiv({ cls: "el-row el-big-buttons" });
		const send = row.createEl("button", { text: "送出", cls: "mod-cta" });
		const giveUp = row.createEl("button", { text: "不會，看答案" });
		const out = card.createDiv();

		const finish = (res: { correct?: boolean; pending?: boolean; score?: number; feedback?: string; corrected?: string }, text: string) => {
			ta.disabled = true;
			send.disabled = true;
			giveUp.disabled = true;
			this.record(pq, { correct: res.correct, pending: res.pending, text, score: res.score, feedback: res.feedback, corrected: res.corrected });
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
			finish({ correct: false }, "");
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

	private record(pq: PQ, r: { correct?: boolean; choice?: number; pending?: boolean; text?: string; score?: number; feedback?: string; corrected?: string }) {
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
		el.createEl("h3", { text: "練習結果" });
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
				if (q.type === "vocab" && q.word) li.createSpan({ cls: "el-say", text: q.word });
				else li.createSpan({ text: q.type === "translate" ? q.prompt : q.prompt.slice(0, 80) });
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
			const again = r.createEl("button", { text: "再練一輪" });
			again.onclick = () => {
				this.phase = "start";
				this.drawStart();
			};
		});
		this.plugin.debug(`practice end right=${right}/${graded.length} pending=${pend}`);
	}
}

export { LEVEL_LABEL, PASS };
