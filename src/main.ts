import * as obsidian from "obsidian";
import { App, Notice, Platform, Plugin, TFile, normalizePath } from "obsidian";
import { AIBackend, AIError, GeminiBackend } from "./ai";
import {
	DEFAULTS,
	HOME_VIEW,
	LS_DEVICE_ID,
	LS_FALLBACK_KEY,
	LS_USER,
	REMOTELY_SAVE_SYNC,
	Settings,
	VERIFY_VIEW,
} from "./constants";
import { Level } from "./generate";
import { AppendOnlyWriter, DEBUG_ROOT, LogEntry, Totals, computeTotals, logPath, safeName, uuid } from "./logs";
import { ELSettingTab } from "./settings";
import { bankPath, generateForSource, importArticle, resetSource, waitForStatus } from "./sources";
import { HomeView, ImportModal, VerifyView } from "./views";
import { englishVoices, speak, ttsAvailable } from "./tts";
import { Pronouncer, PronounceSource, loadQuota, unlockAudio } from "./pronounce";
import { PRACTICE_VIEW, PracticeView } from "./practice";
import { STATS_VIEW, StatsView, WORDS_VIEW, WordsView } from "./wordviews";
import { cachedZh, translateMany } from "./translate";
import { backupNow, maybeAutoBackup } from "./backup";
import { FIX_DIR, FixOutcome, makeFix } from "./fixes";
import type { Bank, Question } from "./generate";

/** 由 esbuild 從 manifest.json 注入（Hot Reload 後 this.manifest 可能是舊的） */
declare const PLUGIN_VERSION: string;

const LS_LAST_LEVEL = "english-learning:last-level";

export default class EnglishLearningPlugin extends Plugin {
	settings!: Settings;
	deviceId!: string;
	writer!: AppendOnlyWriter;
	/** 這台裝置正在出題的文章路徑 */
	generating = new Set<string>();
	pronouncer!: Pronouncer;
	/** 最後一次 Vault 檔案變動的時間（判斷同步是否結束的備案） */
	private lastVaultEvent = 0;

	async onload() {
		await this.loadSettings();
		this.deviceId = this.loadOrCreateDeviceId();
		this.writer = new AppendOnlyWriter(this.app);

		this.pronouncer = new Pronouncer({
			app: this.app,
			deviceId: this.deviceId,
			settings: () => this.settings,
			apiKey: () => this.getApiKey(),
			systemSpeak: (t) => speak(this.app, t),
			log: (source, extra) => {
				this.writeEntry(this.entry("tts", { source, ...extra })).catch(() => undefined);
			},
			notice: (m) => new Notice(m, 8000),
			debug: (m) => this.debug(m),
		});
		this.registerEvent(this.app.vault.on("create", (f) => this.pronouncer.onCreate(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => this.pronouncer.onDelete(f)));
		this.registerEvent(
			this.app.vault.on("rename", (f, old) => {
				this.pronouncer.onDelete(old);
				this.pronouncer.onCreate(f);
			}),
		);
		this.app.workspace.onLayoutReady(() => this.pronouncer.rebuildIndex());
		// 每週自動備份一次（等 1 分鐘，讓啟動時的同步先跑完）
		this.app.workspace.onLayoutReady(() => {
			const t = window.setTimeout(() => {
				maybeAutoBackup(this.app, this.deviceId)
					.then((r) => r && this.debug(`auto backup ${r.path}: ${r.files} files, ${Math.round(r.bytes / 1024)} KB`))
					.catch((e) => this.debug(`auto backup failed: ${errMsg(e)}`));
			}, 60_000);
			this.register(() => window.clearTimeout(t));
		});
		this.addCommand({ id: "backup", name: "立即備份", callback: () => this.backup() });

		const touch = () => (this.lastVaultEvent = Date.now());
		this.registerEvent(this.app.vault.on("create", touch));
		this.registerEvent(this.app.vault.on("modify", touch));
		this.registerEvent(this.app.vault.on("delete", touch));
		this.registerEvent(this.app.vault.on("rename", touch));

		this.registerView(PRACTICE_VIEW, (leaf) => new PracticeView(leaf, this));
		this.registerView(WORDS_VIEW, (leaf) => new WordsView(leaf, this));
		this.registerView(STATS_VIEW, (leaf) => new StatsView(leaf, this));
		this.addCommand({ id: "words", name: "開啟生字本", callback: () => this.openView(WORDS_VIEW) });
		this.addCommand({ id: "stats", name: "開啟學習統計", callback: () => this.openView(STATS_VIEW) });
		this.addRibbonIcon("graduation-cap", "English Learning：練習", () => this.openView(PRACTICE_VIEW));
		this.addCommand({ id: "practice", name: "開始練習", callback: () => this.openView(PRACTICE_VIEW) });
		this.registerView(HOME_VIEW, (leaf) => new HomeView(leaf, this));
		this.registerView(VERIFY_VIEW, (leaf) => new VerifyView(leaf, this));
		this.addRibbonIcon("book-open", "English Learning", () => this.openView(HOME_VIEW));
		this.addRibbonIcon("flask-conical", "English Learning：驗證面板", () => this.openView(VERIFY_VIEW));

		this.addCommand({ id: "open-home", name: "開啟主畫面", callback: () => this.openView(HOME_VIEW) });
		this.addCommand({ id: "import", name: "匯入文章", callback: () => new ImportModal(this.app, this).open() });
		this.addCommand({
			id: "generate-current",
			name: "為目前的文章出題",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				const ok = !!f && f.path.startsWith("english/sources/");
				if (ok && !checking) this.generate(f as TFile);
				return ok;
			},
		});
		this.addCommand({ id: "open-verify", name: "開啟驗證面板", callback: () => this.openView(VERIFY_VIEW) });
		this.addCommand({ id: "tap", name: "記一筆（append log）", callback: () => this.tap() });
		this.addCommand({ id: "test-api", name: "測試 AI API", callback: () => this.testApi() });
		this.addCommand({ id: "test-mic", name: "測試麥克風", callback: () => this.testMic() });
		this.addCommand({ id: "sync", name: "立即同步（Remotely Save）", callback: () => this.triggerSync() });
		this.addCommand({ id: "test-tts", name: "測試發音", callback: () => this.testTts() });
		this.addSettingTab(new ELSettingTab(this.app, this));

		// 點 .el-say（題庫中的英文）就朗讀；閱讀模式下點文章裡的 ==螢光筆== 生字也會朗讀
		this.registerDomEvent(
			document,
			"click",
			(e: MouseEvent) => {
				const t = e.target as HTMLElement | null;
				const say = t?.closest?.(".el-say");
				const mark = !say ? t?.closest?.(".markdown-reading-view mark, .markdown-preview-view mark") : null;
				const el = say ?? mark;
				if (!el) return;
				if (mark && !this.app.workspace.getActiveFile()?.path.startsWith("english/")) return;
				this.say(el.textContent ?? "");
			},
			true,
		);

		this.app.workspace.onLayoutReady(() =>
			this.debug(`plugin loaded v${PLUGIN_VERSION}; device=${this.deviceId}; platform=${platformName()}`),
		);
	}

	onunload() {}

	// ---------- 裝置 ID 與使用者 ----------
	private loadOrCreateDeviceId(): string {
		const existing = this.app.loadLocalStorage(LS_DEVICE_ID);
		if (typeof existing === "string" && /^[a-z]+-[0-9a-f]{8}$/.test(existing)) return existing;
		const hex = uuid().replace(/-/g, "").slice(0, 8);
		const id = `${devicePrefix()}-${hex}`;
		this.app.saveLocalStorage(LS_DEVICE_ID, id);
		new Notice(`已產生本機裝置 ID：${id}`);
		return id;
	}

	get user(): string {
		const u = this.app.loadLocalStorage(LS_USER);
		const users = this.settings.users;
		return typeof u === "string" && users.includes(u) ? u : users[0] ?? "default";
	}

	set user(u: string) {
		this.app.saveLocalStorage(LS_USER, safeName(u));
		this.refreshViews();
	}

	get lastLevel(): Level {
		return this.app.loadLocalStorage(LS_LAST_LEVEL) === "kid" ? "kid" : "adult";
	}

	// ---------- log ----------
	makeEntry(type: LogEntry["type"], extra: Record<string, unknown> = {}): LogEntry {
		return this.entry(type, extra);
	}

	appendLog(e: LogEntry): Promise<void> {
		return this.writeEntry(e);
	}

	private entry(type: LogEntry["type"], extra: Record<string, unknown> = {}): LogEntry {
		return { id: uuid(), ts: new Date().toISOString(), device: this.deviceId, user: this.user, type, ...extra };
	}

	private async writeEntry(e: LogEntry) {
		await this.writer.append(logPath(e.user, this.deviceId), JSON.stringify(e) + "\n");
	}

	async tap(): Promise<void> {
		try {
			await this.writeEntry(this.entry("tap"));
			new Notice("已記一筆");
		} catch (e) {
			this.fail("append log", e);
		}
		this.refreshViews();
	}

	totals(): Promise<Totals> {
		return computeTotals(this.app);
	}

	// ---------- AI ----------
	getApiKey(): string | null {
		const ss = (this.app as App & { secretStorage?: obsidian.SecretStorage }).secretStorage;
		if (ss && this.settings.apiKeySecretName) return ss.getSecret(this.settings.apiKeySecretName);
		if (!ss) {
			const k = this.app.loadLocalStorage(LS_FALLBACK_KEY);
			return typeof k === "string" && k ? k : null;
		}
		return null;
	}

	backend(): AIBackend {
		const key = this.getApiKey();
		if (!key) throw new Error("尚未設定 API key（設定 → English Learning）");
		return new GeminiBackend(key, this.settings.geminiModel);
	}

	async testApi(): Promise<string> {
		const started = Date.now();
		try {
			const r = await this.backend().complete(
				"Reply with exactly one short English sentence that a beginner can understand.",
				{ maxOutputTokens: 256 },
			);
			const ms = Date.now() - started;
			await this.writeEntry(this.entry("api", { ok: true, purpose: "test", backend: "gemini", model: r.model, ms, usage: r.usage }));
			const msg = `API OK（${r.model}，${ms} ms，tokens ${r.usage.inputTokens ?? "?"}/${r.usage.outputTokens ?? "?"}）\n${r.text || `（沒有文字，finishReason=${r.finishReason}）`}`;
			new Notice(msg, 8000);
			this.debug(msg);
			this.refreshViews();
			return msg;
		} catch (e) {
			const status = e instanceof AIError ? e.status : undefined;
			await this.writeEntry(this.entry("api", { ok: false, purpose: "test", backend: "gemini", model: this.settings.geminiModel, status, error: errMsg(e) })).catch(() => undefined);
			this.fail("API", e);
			if (e instanceof AIError && e.body) this.debug(`API body: ${e.body}`);
			this.refreshViews();
			return `API FAIL：${errMsg(e)}`;
		}
	}

	// ---------- 文章匯入與出題 ----------
	async importArticle(title: string, level: Level, text: string, unknownWords: string[] = []): Promise<TFile | null> {
		try {
			this.app.saveLocalStorage(LS_LAST_LEVEL, level);
			const { file: f, notFound } = await importArticle(this.app, { title, level, text, deviceId: this.deviceId, unknownWords });
			new Notice(`已匯入：${f.basename}${notFound.length ? `\n文章裡找不到這些字，沒有標記：${notFound.join("、")}` : ""}`, notFound.length ? 10000 : 4000);
			this.debug(`import ${f.path}`);
			this.refreshViews();
			return f;
		} catch (e) {
			this.fail("匯入", e);
			return null;
		}
	}

	async generate(file: TFile, levelIfMissing?: Level): Promise<void> {
		if (this.generating.has(file.path)) return;
		let ai: AIBackend;
		try {
			ai = this.backend();
		} catch (e) {
			this.fail("出題", e);
			return;
		}
		this.generating.add(file.path);
		this.refreshViews();
		const notice = new Notice(`出題中：${file.basename}…`, 0);
		try {
			const r = await generateForSource(this.app, file, ai, this.deviceId, levelIfMissing);
			await this.writeEntry(this.entry("api", { ok: true, purpose: "generate", source: file.path, backend: ai.id, model: r.model, ms: r.ms, usage: r.usage, count: r.count })).catch(() => undefined);
			const cover = r.marked ? `；標記的生字 ${r.marked - r.missing.length}/${r.marked} 個有出題${r.missing.length ? `（漏了：${r.missing.join("、")}）` : ""}` : "";
			const msg = `出題完成：${r.count} 題${r.dropped ? `（丟掉 ${r.dropped} 題不合格的）` : ""}${cover}，${(r.ms / 1000).toFixed(1)} 秒，tokens ${r.usage.inputTokens ?? "?"}/${r.usage.outputTokens ?? "?"}`;
			new Notice(msg, 8000);
			this.debug(`generate ${file.path}: ${msg}`);
			if (this.settings.syncAfterGenerate) await this.triggerSync(true);
		} catch (e) {
			await this.writeEntry(this.entry("api", { ok: false, purpose: "generate", source: file.path, backend: ai.id, model: ai.model, status: e instanceof AIError ? e.status : undefined, error: errMsg(e) })).catch(() => undefined);
			this.fail("出題", e);
			if (e instanceof AIError && e.body) this.debug(`API body: ${e.body}`);
		} finally {
			notice.hide();
			this.generating.delete(file.path);
			this.refreshViews();
		}
	}

	async regenerate(file: TFile) {
		try {
			await resetSource(this.app, file, this.deviceId);
			await waitForStatus(this.app, file, "new");
			this.debug(`reset ${file.path}`);
		} catch (e) {
			this.fail("重新出題", e);
			return;
		}
		await this.generate(file);
	}

	async openBank(sourceId?: string) {
		if (!sourceId) return;
		const f = this.app.vault.getAbstractFileByPath(bankPath(sourceId));
		if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f);
		else new Notice("找不到題庫檔，可能還沒同步下來");
	}

	// ---------- 朗讀 ----------
	/** 必須在使用者點擊的事件裡同步呼叫（iOS 播放限制）。 */
	say(text: string) {
		unlockAudio();
		this.pronouncer.pronounce(text).catch((e) => {
			this.debug(`pronounce failed: ${errMsg(e)}`);
			speak(this.app, text).catch((e2) => this.fail("朗讀", e2));
		});
	}

	/** 驗證用：強制呼叫 Gemini 語音（會計入每日上限）。 */
	async testGeminiTts(): Promise<string> {
		unlockAudio();
		const before = loadQuota(this.app);
		try {
			const src: PronounceSource = await this.pronouncer.pronounce("Hello! This is the Gemini voice. Espionage. Lodge a protest.", { forceGemini: true });
			const q = loadQuota(this.app);
			const msg =
				src === "gemini"
					? `Gemini 語音 OK（${this.settings.ttsModel} / ${this.settings.ttsVoice}）；今天已產生 ${q.count}/${this.settings.ttsDailyCap} 段`
					: `沒有用到 Gemini 語音（改用 ${src}）${q.exhausted ? "：今天額度已用完" : before.count >= this.settings.ttsDailyCap ? "：達到每日上限" : "：請看除錯紀錄"}`;
			new Notice(msg, 8000);
			this.debug(msg);
			return msg;
		} catch (e) {
			this.fail("Gemini 語音", e);
			return `FAIL：${errMsg(e)}`;
		}
	}

	async testTts(): Promise<string> {
		let result: string;
		try {
			if (!ttsAvailable()) throw new Error("speechSynthesis 不存在");
			const voices = await englishVoices();
			const v = await speak(this.app, "Hello! This is a pronunciation test. Espionage. Remilitarisation. Lodge a protest.");
			result = `tts OK：使用 ${v?.name ?? "預設"}（${v?.lang ?? "?"}）；可用英文語音 ${voices.length} 個`;
			await this.writeEntry(this.entry("tts", { result: "OK", voice: v?.name, voices: voices.map((x) => `${x.name} (${x.lang})${x.localService ? "" : " [online]"}`) })).catch(() => undefined);
		} catch (e) {
			result = `tts FAIL: ${errMsg(e)}`;
			await this.writeEntry(this.entry("tts", { result: "FAIL", error: errMsg(e) })).catch(() => undefined);
		}
		new Notice(result, 6000);
		this.debug(result);
		return result;
	}

	// ---------- 麥克風 ----------
	async testMic(): Promise<string> {
		let result: string;
		try {
			const md = navigator.mediaDevices;
			if (!md || typeof md.getUserMedia !== "function") throw Object.assign(new Error("navigator.mediaDevices 不存在"), { name: "NoMediaDevices" });
			const stream = await md.getUserMedia({ audio: true });
			stream.getTracks().forEach((t) => t.stop());
			result = "mic OK";
		} catch (e) {
			result = "mic FAIL: " + ((e as Error)?.name ?? String(e));
		}
		new Notice(result);
		this.debug(result);
		await this.writeEntry(this.entry("mic", { result })).catch((e) => this.fail("append log", e));
		this.refreshViews();
		return result;
	}

	// ---------- 同步（非正式內部 API，可能隨版本失效） ----------
	async triggerSync(quiet = false): Promise<boolean> {
		const cmds = (this.app as unknown as { commands?: { commands?: Record<string, unknown>; executeCommandById?: (id: string) => boolean } }).commands;
		if (!cmds?.executeCommandById || !cmds.commands?.[REMOTELY_SAVE_SYNC]) {
			if (!quiet) new Notice("找不到 Remotely Save 的同步指令：請確認已安裝並啟用，或改用它的手動同步按鈕。", 8000);
			this.debug("sync: command not found");
			return false;
		}
		// 先寫紀錄再同步，這筆紀錄才會在這次一起上傳
		await this.writeEntry(this.entry("sync", { triggered: true })).catch(() => undefined);
		const ok = cmds.executeCommandById(REMOTELY_SAVE_SYNC);
		this.debug(`sync triggered: ${ok}`);
		this.refreshViews();
		return ok;
	}

	/**
	 * 觸發同步並等它結束。Remotely Save 沒有公開的完成事件：
	 * 優先讀它內部的 isSyncing（非正式 API），讀不到就等 Vault 安靜 3 秒。
	 */
	async syncAndWait(onStatus?: (s: string) => void, maxMs = 90_000): Promise<boolean> {
		if (typeof navigator !== "undefined" && navigator.onLine === false) {
			onStatus?.("離線中，略過同步");
			return false;
		}
		const rs = (this.app as unknown as { plugins?: { plugins?: Record<string, { isSyncing?: boolean }> } }).plugins?.plugins?.["remotely-save"];
		const started = Date.now();
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		const secs = () => Math.round((Date.now() - started) / 1000);
		// 如果自動同步正在跑，先等它結束：它可能沒包含剛寫入的紀錄，所以結束後再同步一次
		if (rs?.isSyncing) {
			while (rs.isSyncing && Date.now() - started < maxMs) {
				onStatus?.(`等待進行中的同步…（${secs()} 秒）`);
				await sleep(300);
			}
		}
		const ok = await this.triggerSync(true);
		if (!ok) return false;
		if (rs && typeof rs.isSyncing === "boolean") {
			// 等它開始（最多 3 秒），再等它結束
			while (!rs.isSyncing && Date.now() - started < 3000) await sleep(100);
			while (rs.isSyncing && Date.now() - started < maxMs) {
				onStatus?.(`同步中…（${secs()} 秒）`);
				await sleep(300);
			}
			const done = !rs.isSyncing;
			this.debug(`syncAndWait ${done ? "done" : "timeout"} in ${secs()}s (isSyncing)`);
			return done;
		}
		await sleep(1500);
		while (Date.now() - started < maxMs) {
			onStatus?.(`同步中…（${secs()} 秒）`);
			if (Date.now() - this.lastVaultEvent > 3000 && Date.now() - started > 5000) break;
			await sleep(500);
		}
		this.debug(`syncAndWait done in ${secs()}s (quiet heuristic)`);
		return true;
	}

	/** 加入生字本（寫在目前使用者的 log）。有網路時順便查好中文。 */
	async addWord(word: string, context?: string, bank?: string): Promise<void> {
		let meaning = cachedZh(this.app, word);
		if (!meaning && navigator.onLine !== false) {
			try {
				meaning = (await translateMany(this.app, this.backend(), [word]))[0];
			} catch {
				/* 之後複習時再查 */
			}
		}
		const extra: Record<string, unknown> = { word };
		if (meaning) extra.meaning = meaning;
		if (context) extra.context = context;
		if (bank) extra.bank = bank;
		await this.appendLog(this.makeEntry("word-add", extra));
		new Notice(`已加入生字本：${word}${meaning ? `（${meaning}）` : ""}`);
	}

	/** 請 AI 出修正題並存到 english/fixes/<deviceId>.jsonl；失敗回傳 null。 */
	async fixQuestion(bank: Bank, old: Question, reason: string): Promise<FixOutcome | null> {
		if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
		let ai: AIBackend;
		try {
			ai = this.backend();
		} catch {
			return null;
		}
		const started = Date.now();
		try {
			const out = await makeFix(this.app, ai, bank, old, reason);
			if (out.kind === "originalCorrect") {
				// AI 判斷原題沒錯：自動恢復，繼續出原題
				await this.appendLog(this.makeEntry("unflag", { qid: old.id, bank: bank.sourceId, reason: "AI 判斷原題正確" }));
				this.debug(`fix ${old.id}: original correct (${out.message})`);
				return out;
			}
			const q = out.question;
			const fix = { id: uuid(), ts: new Date().toISOString(), device: this.deviceId, type: "fix", replaces: old.id, bank: bank.sourceId, reason, question: q };
			await this.writer.append(normalizePath(`${FIX_DIR}/${this.deviceId}.jsonl`), JSON.stringify(fix) + "\n");
			this.debug(`fix ${old.id} -> ${q.id}${out.sameId ? " (same id)" : ""} in ${Date.now() - started} ms`);
			return out;
		} catch (e) {
			this.debug(`fix failed ${old.id}: ${errMsg(e)}`);
			return null;
		}
	}

	async backup(): Promise<void> {
		try {
			const r = await backupNow(this.app, this.deviceId);
			new Notice(`已備份 ${r.files} 個檔案（${Math.round(r.bytes / 1024)} KB）到 ${r.path}`, 6000);
			this.debug(`manual backup ${r.path}`);
		} catch (e) {
			this.fail("備份", e);
		}
	}

	// ---------- 除錯（iOS 沒有 DevTools，寫進 Vault；每台裝置一個檔） ----------
	debug(msg: string) {
		const line = `- ${new Date().toISOString()} ${msg.replace(/\n/g, " ⏎ ")}\n`;
		this.writer.append(normalizePath(`${DEBUG_ROOT}/${this.deviceId}.md`), line).catch(() => undefined);
	}

	private fail(what: string, e: unknown) {
		const m = `${what} 失敗：${errMsg(e)}`;
		new Notice(m, 10000);
		this.debug(m);
	}

	// ---------- 其他 ----------
	async openView(type: string) {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(type)[0];
		if (!leaf) {
			leaf = Platform.isMobile || type !== VERIFY_VIEW ? workspace.getLeaf(true) : (workspace.getRightLeaf(false) ?? workspace.getLeaf(true));
			await leaf.setViewState({ type, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	refreshViews() {
		for (const type of [HOME_VIEW, VERIFY_VIEW, PRACTICE_VIEW, WORDS_VIEW, STATS_VIEW]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				const v = leaf.view as unknown as { render?: () => unknown };
				v.render?.();
			}
		}
	}

	async loadSettings() {
		const raw = (await this.loadData()) ?? {};
		this.settings = { ...DEFAULTS, ...raw };
		// 防呆：data.json 不應該出現這些欄位
		for (const k of ["apiKey", "deviceId", "key"]) delete (this.settings as unknown as Record<string, unknown>)[k];
		this.settings.users = (this.settings.users ?? []).map(safeName).filter(Boolean);
		if (!this.settings.users.length) this.settings.users = ["default"];
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refreshViews();
	}
}

function errMsg(e: unknown): string {
	return String((e as Error)?.message ?? e);
}

function devicePrefix(): string {
	if (Platform.isIosApp) return Platform.isTablet ? "ipad" : "iphone";
	if (Platform.isAndroidApp) return "android";
	if (Platform.isWin) return "win";
	if (Platform.isMacOS) return "mac";
	if (Platform.isLinux) return "linux";
	return "device";
}

function platformName(): string {
	return `${devicePrefix()}${Platform.isMobile ? " (mobile)" : " (desktop)"}`;
}
