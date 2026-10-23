import * as obsidian from "obsidian";
import {
	App,
	ItemView,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
	normalizePath,
} from "obsidian";
import { AIBackend, AIError, GeminiBackend } from "./ai";
import {
	AppendOnlyWriter,
	DEBUG_ROOT,
	LogEntry,
	Totals,
	computeTotals,
	logPath,
	safeName,
	uuid,
} from "./logs";

const VIEW_TYPE = "english-learning-verify";
// 以下都存在 localStorage（app.saveLocalStorage），不在 Vault 檔案裡，不會被同步
const LS_DEVICE_ID = "english-learning:device-id";
const LS_USER = "english-learning:user";
const LS_FALLBACK_KEY = "english-learning:fallback-api-key"; // 僅在沒有 SecretStorage 時使用
const REMOTELY_SAVE_SYNC = "remotely-save:start-sync";

/** data.json 只放非機密設定。不得放 API key 或裝置 ID。 */
interface Settings {
	users: string[];
	backend: "gemini";
	geminiModel: string;
	apiKeySecretName: string; // SecretStorage 裡的 secret 名稱，不是金鑰本身
}

const DEFAULTS: Settings = {
	users: ["ray", "kid"],
	backend: "gemini",
	geminiModel: "gemini-3.5-flash-lite",
	apiKeySecretName: "",
};

export default class EnglishLearningPlugin extends Plugin {
	settings!: Settings;
	deviceId!: string;
	writer!: AppendOnlyWriter;

	async onload() {
		await this.loadSettings();
		this.deviceId = this.loadOrCreateDeviceId();
		this.writer = new AppendOnlyWriter(this.app);

		this.registerView(VIEW_TYPE, (leaf) => new VerifyView(leaf, this));
		this.addRibbonIcon("flask-conical", "English Learning：驗證面板", () => this.openView());
		this.addCommand({ id: "open-verify", name: "開啟驗證面板", callback: () => this.openView() });
		this.addCommand({ id: "tap", name: "記一筆（append log）", callback: () => this.tap() });
		this.addCommand({ id: "test-api", name: "測試 AI API", callback: () => this.testApi() });
		this.addCommand({ id: "test-mic", name: "測試麥克風", callback: () => this.testMic() });
		this.addCommand({ id: "sync", name: "立即同步（Remotely Save）", callback: () => this.triggerSync() });
		this.addSettingTab(new ELSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() =>
			this.debug(`plugin loaded; device=${this.deviceId}; platform=${platformName()}`),
		);
	}

	onunload() {}

	// ---------- 1. 裝置 ID ----------
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
	}

	private entry(type: LogEntry["type"], extra: Record<string, unknown> = {}): LogEntry {
		return { id: uuid(), ts: new Date().toISOString(), device: this.deviceId, user: this.user, type, ...extra };
	}

	private async writeEntry(e: LogEntry) {
		await this.writer.append(logPath(e.user, this.deviceId), JSON.stringify(e) + "\n");
	}

	// ---------- 2. append log ----------
	async tap(): Promise<void> {
		try {
			await this.writeEntry(this.entry("tap"));
			new Notice("已記一筆");
		} catch (e) {
			this.fail("append log", e);
		}
		this.refreshViews();
	}

	// ---------- 3. 合計 ----------
	totals(): Promise<Totals> {
		return computeTotals(this.app);
	}

	// ---------- 4. AI API ----------
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
			await this.writeEntry(this.entry("api", { ok: true, backend: "gemini", model: r.model, ms, usage: r.usage }));
			const msg = `API OK（${r.model}，${ms} ms，tokens ${r.usage.inputTokens ?? "?"}/${r.usage.outputTokens ?? "?"}）\n${r.text}`;
			new Notice(msg, 8000);
			this.debug(msg);
			this.refreshViews();
			return msg;
		} catch (e) {
			const status = e instanceof AIError ? e.status : undefined;
			await this.writeEntry(this.entry("api", { ok: false, backend: "gemini", model: this.settings.geminiModel, status, error: String((e as Error)?.message ?? e) })).catch(() => undefined);
			this.fail("API", e);
			if (e instanceof AIError && e.body) this.debug(`API body: ${e.body}`);
			this.refreshViews();
			return `API FAIL：${(e as Error)?.message ?? e}`;
		}
	}

	// ---------- 5. 麥克風 ----------
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
	async triggerSync(): Promise<boolean> {
		const cmds = (this.app as unknown as { commands?: { commands?: Record<string, unknown>; executeCommandById?: (id: string) => boolean } }).commands;
		if (!cmds?.executeCommandById || !cmds.commands?.[REMOTELY_SAVE_SYNC]) {
			new Notice("找不到 Remotely Save 的同步指令：請確認已安裝並啟用，或改用它的手動同步按鈕。", 8000);
			this.debug("sync: command not found");
			return false;
		}
		const ok = cmds.executeCommandById(REMOTELY_SAVE_SYNC);
		await this.writeEntry(this.entry("sync", { triggered: ok })).catch(() => undefined);
		this.debug(`sync triggered: ${ok}`);
		this.refreshViews();
		return ok;
	}

	// ---------- 除錯（iOS 沒有 DevTools，寫進 Vault；每台裝置一個檔） ----------
	debug(msg: string) {
		const line = `- ${new Date().toISOString()} ${msg.replace(/\n/g, " ⏎ ")}\n`;
		this.writer.append(normalizePath(`${DEBUG_ROOT}/${this.deviceId}.md`), line).catch(() => undefined);
	}

	private fail(what: string, e: unknown) {
		const m = `${what} 失敗：${(e as Error)?.message ?? e}`;
		new Notice(m, 8000);
		this.debug(m);
	}

	// ---------- 其他 ----------
	async openView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = Platform.isMobile ? workspace.getLeaf(true) : (workspace.getRightLeaf(false) ?? workspace.getLeaf(true));
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	refreshViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const v = leaf.view;
			if (v instanceof VerifyView) v.render();
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

// =====================================================================
class VerifyView extends ItemView {
	private busy = false;

	constructor(leaf: WorkspaceLeaf, private plugin: EnglishLearningPlugin) {
		super(leaf);
	}
	getViewType() {
		return VIEW_TYPE;
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

// =====================================================================
class ELSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: EnglishLearningPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const p = this.plugin;
		containerEl.empty();

		new Setting(containerEl)
			.setName("本機裝置 ID")
			.setDesc("存在本機 localStorage，不會同步。每台裝置不同。")
			.addText((t) => t.setValue(p.deviceId).setDisabled(true));

		new Setting(containerEl)
			.setName("使用者")
			.setDesc("以逗號分隔，只能用英文小寫、數字、- 和 _。")
			.addText((t) =>
				t.setValue(p.settings.users.join(", ")).onChange(async (v) => {
					p.settings.users = v.split(",").map(safeName).filter(Boolean);
					if (!p.settings.users.length) p.settings.users = ["default"];
					await p.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Gemini 模型")
			.setDesc("例如 gemini-3.5-flash-lite、gemini-3.8-flash。")
			.addText((t) =>
				t.setValue(p.settings.geminiModel).onChange(async (v) => {
					p.settings.geminiModel = v.trim() || DEFAULTS.geminiModel;
					await p.saveSettings();
				}),
			);

		const SecretComponentCtor = (obsidian as unknown as { SecretComponent?: typeof obsidian.SecretComponent }).SecretComponent;
		const hasSecretStorage = !!(this.app as App & { secretStorage?: unknown }).secretStorage;

		if (SecretComponentCtor && hasSecretStorage) {
			new Setting(containerEl)
				.setName("Gemini API key")
				.setDesc("金鑰存在 Obsidian 的 SecretStorage（本機、不進 Vault）。這裡只記住 secret 的名稱。每台裝置各設定一次。")
				.addComponent((el) =>
					new SecretComponentCtor(this.app, el).setValue(p.settings.apiKeySecretName).onChange(async (v) => {
						p.settings.apiKeySecretName = v ?? "";
						await p.saveSettings();
					}),
				);
		} else {
			new Setting(containerEl)
				.setName("Gemini API key（備案：localStorage）")
				.setDesc("這個 Obsidian 版本沒有 SecretStorage，改存本機 localStorage（未加密，但不在 Vault 檔案裡）。建議更新 Obsidian 到 1.11.4 以上。")
				.addText((t) => {
					t.inputEl.type = "password";
					const cur = this.app.loadLocalStorage(LS_FALLBACK_KEY);
					t.setValue(typeof cur === "string" ? cur : "").onChange((v) =>
						this.app.saveLocalStorage(LS_FALLBACK_KEY, v.trim() || null),
					);
				});
		}
	}
}
