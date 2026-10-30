import * as obsidian from "obsidian";
import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type EnglishLearningPlugin from "./main";
import { DEFAULTS, LS_FALLBACK_CLOUD_KEY, LS_FALLBACK_KEY, LS_SETTINGS_STEP } from "./constants";
import { safeName } from "./logs";
import { LS_TTS_RATE, getRate, voicePicker } from "./tts";
import { CHIRP_VOICES, CLOUD_FREE_CHARS, cloudMonth } from "./cloudtts";
import { unlockAudio } from "./pronounce";
import { loadQuota } from "./pronounce";
import { LS_LAST_BACKUP, listBackups, restoreBackup } from "./backup";
import { audioUsage, formatBytes } from "./audiocache";
import { ConfirmModal } from "./views";

export class ELSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: EnglishLearningPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const p = this.plugin;
		containerEl.empty();
		// 麵包屑：localStorage 是同步寫入，Obsidian 當掉也留得住；下次啟動時寫進除錯紀錄，看是哪一段當掉
		const mark = (step: string) => this.app.saveLocalStorage(LS_SETTINGS_STEP, step);
		mark("start");

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
			.setName("每天新題上限")
			.setDesc("每種題型每天最多出幾題新題，避免之後複習量一次湧上來。0＝不限。到期的複習題不受影響。")
			.addText((t) =>
				t.setValue(String(p.settings.newPerDay)).onChange(async (v) => {
					const n = Math.max(0, Math.min(500, Math.floor(Number(v))));
					if (Number.isFinite(n)) {
						p.settings.newPerDay = n;
						await p.saveSettings();
					}
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

		new Setting(containerEl)
			.setName("快速模型")
			.setDesc("英文對話、批改、翻譯這類要馬上回應的地方用這個模型（出題、拍照辨識仍用上面的模型）。不能用時會自動改用上面的模型。對話慢的話可以用「AI 速度測試」比較。")
			.addText((t) =>
				t.setValue(p.settings.fastModel).onChange(async (v) => {
					p.settings.fastModel = v.trim();
					await p.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("出題後自動同步")
			.setDesc("出題完成後立刻觸發 Remotely Save 上傳，讓其他裝置可以練習。")
			.addToggle((t) =>
				t.setValue(p.settings.syncAfterGenerate).onChange(async (v) => {
					p.settings.syncAfterGenerate = v;
					await p.saveSettings();
				}),
			);

		mark("backup");
		containerEl.createEl("h3", { text: "備份" });
		const lastBackup = this.app.loadLocalStorage(LS_LAST_BACKUP);
		new Setting(containerEl)
			.setName("自動備份")
			.setDesc(
				`每 7 天自動把答題紀錄、文章與題庫備份到 backup/${p.deviceId}/，保留最近 4 份。上次備份：${typeof lastBackup === "string" ? new Date(lastBackup).toLocaleString() : "還沒有"}`,
			)
			.addButton((b) => b.setButtonText("立即備份").onClick(() => p.backup().then(() => this.display())));
		const backups = listBackups(this.app);
		let chosen = backups[0]?.file.path ?? "";
		new Setting(containerEl)
			.setName("從備份還原")
			.setDesc(
				backups.length
					? "合併還原：補回不見的檔案與紀錄，不會覆蓋或刪除現有內容，可以放心按。建議在其他裝置都同步完、沒有在練習時操作。"
					: "還沒有任何備份。",
			)
			.addDropdown((d) => {
				for (const b of backups) d.addOption(b.file.path, `${b.date}・${b.device}`);
				if (chosen) d.setValue(chosen);
				d.onChange((v) => (chosen = v));
			})
			.addButton((b) =>
				b
					.setButtonText("還原")
					.setDisabled(!backups.length)
					.onClick(() => {
						const info = backups.find((x) => x.file.path === chosen);
						if (!info) return;
						new ConfirmModal(this.app, "從備份還原", `用 ${info.date}（${info.device}）的備份合併還原？只會補回缺少的內容。`, async () => {
							try {
								const r = await restoreBackup(this.app, info.file);
								new Notice(`還原完成：補回 ${r.created} 個檔案、${r.linesAdded} 筆紀錄（其餘 ${r.kept} 個檔案已是最新）`, 10000);
								p.debug(`restore ${info.file.path}: ${JSON.stringify(r)}`);
								p.refreshViews();
								p.triggerSync(true);
							} catch (e) {
								new Notice(`還原失敗：${(e as Error)?.message ?? e}`, 10000);
							}
						}).open();
					}),
			);

		mark("audio");
		containerEl.createEl("h3", { text: "錄音" });
		const u = audioUsage(this.app, p.deviceId);
		new Setting(containerEl)
			.setName("錄音佔用空間")
			.setDesc(`全部 ${u.files} 個檔案、${formatBytes(u.bytes)}（這台裝置產生的 ${u.mineFiles} 個、${formatBytes(u.mineBytes)}）。Dropbox 免費版 2GB，一篇文章約 2～3MB。`);
		new Setting(containerEl)
			.setName("出題後預先產生錄音")
			.setDesc("出題完成後在背景下載單字的真人錄音（字典，免費），離線練習也是自然的聲音。只補自己匯入的題庫。")
			.addToggle((t) =>
				t.setValue(p.settings.prefetchAudio).onChange(async (v) => {
					p.settings.prefetchAudio = v;
					await p.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("預先產生時也用 Gemini 語音")
			.setDesc("句子也預先產生自然語音。免費版每天只有 10 段，會跟英文對話搶額度，建議開通付費後再打開。")
			.addToggle((t) =>
				t.setValue(p.settings.prefetchGemini).onChange(async (v) => {
					p.settings.prefetchGemini = v;
					await p.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("補齊所有題庫的錄音")
			.setDesc("現在就為所有題庫產生缺少的錄音（會用掉語音額度）。")
			.addButton((b) => b.setButtonText("開始").onClick(() => p.prefetchAll().then(() => this.display())));
		new Setting(containerEl)
			.setName("清除已熟練與不再使用的錄音")
			.setDesc("已熟練（間隔 7 天以上）的題目、以及不屬於任何題庫或生字本的錄音會被刪除；之後需要時會重新產生。")
			.addButton((b) =>
				b.setButtonText("檢查").onClick(async () => {
					const plan = await p.planAudioCleanup();
					if (!plan.files.length) return new Notice("目前沒有可以清除的錄音");
					new ConfirmModal(
						this.app,
						"清除錄音",
						`可以清除 ${plan.files.length} 個檔案（${formatBytes(plan.bytes)}）：已熟練 ${plan.mastered} 個、不再使用 ${plan.unused} 個。所有裝置同步後都會刪除，之後需要時會重新產生。`,
						() => p.runAudioCleanup(plan).then(() => this.display()),
					).open();
				}),
			);

		mark("pronounce");
		containerEl.createEl("h3", { text: "發音" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "點 🔊 時依序嘗試：已存的錄音 → 字典真人錄音（單字）→ Gemini 語音 → 系統語音。取得的錄音存在 english/audio，會同步到其他裝置，之後離線也能播。",
		});
		new Setting(containerEl)
			.setName("單字用字典真人發音")
			.setDesc("Free Dictionary API，免費、不需金鑰；部分單字沒有錄音。")
			.addToggle((t) =>
				t.setValue(p.settings.dictAudio).onChange(async (v) => {
					p.settings.dictAudio = v;
					await p.saveSettings();
				}),
			);
		const q = loadQuota(this.app);
		new Setting(containerEl)
			.setName("使用 Gemini 自然語音")
			.setDesc(`用同一把 Gemini 金鑰。免費版每天只有 10 段（所有裝置共用），用完當天自動改用系統語音。這台裝置今天已產生 ${q.count} 段${q.exhausted ? "（今天額度已用完）" : ""}。`)
			.addToggle((t) =>
				t.setValue(p.settings.geminiTts).onChange(async (v) => {
					p.settings.geminiTts = v;
					await p.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("每天最多產生幾段 Gemini 語音")
			.setDesc("每台裝置分開計算，依 Google 的重置時間（台灣下午 3～4 點）歸零。免費版是 10；開通付費後可以調高。")
			.addText((t) =>
				t.setValue(String(p.settings.ttsDailyCap)).onChange(async (v) => {
					const n = Math.max(0, Math.min(10000, Math.floor(Number(v))));
					if (Number.isFinite(n)) {
						p.settings.ttsDailyCap = n;
						await p.saveSettings();
					}
				}),
			);
		new Setting(containerEl)
			.setName("Gemini 語音模型與聲音")
			.setDesc("聲音例如 Kore、Puck、Zephyr、Charon、Leda、Aoede。")
			.addText((t) =>
				t.setValue(p.settings.ttsModel).onChange(async (v) => {
					p.settings.ttsModel = v.trim() || "gemini-3.8-flash-lite-tts";
					await p.saveSettings();
				}),
			)
			.addText((t) =>
				t.setValue(p.settings.ttsVoice).onChange(async (v) => {
					p.settings.ttsVoice = v.trim() || "Kore";
					await p.saveSettings();
				}),
			);

		mark("cloud");
		this.cloudSection(containerEl);
		mark("voices");

		const voiceSetting = new Setting(containerEl)
			.setName("系統語音")
			.setDesc("每台裝置各自設定，選了會試唸。注意：iPad／iPhone 上 Apple 不讓 App 內的網頁使用另外下載的高品質語音，只能選內建的聲音。");
		voicePicker(this.app, voiceSetting.controlEl);
		new Setting(containerEl)
			.setName("朗讀速度")
			.setDesc("0.5～1.5，預設 0.9")
			.addSlider((s) =>
				s
					.setLimits(0.5, 1.5, 0.1)
					.setValue(getRate(this.app))
					.setDynamicTooltip()
					.onChange((v) => this.app.saveLocalStorage(LS_TTS_RATE, v)),
			);

		mark("apikey");
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
		// 系統語音清單是非同步載入的：等它出來後才算畫完
		window.setTimeout(() => mark("done"), 3000);
	}

	/** Google Cloud 語音（Chirp 3 HD）：設定頁只放一列摘要，細項在對話框裡（v0.17.0 在 iPad 打開設定頁會當掉，疑似同頁兩個 SecretComponent）。 */
	private cloudSection(containerEl: HTMLElement) {
		const p = this.plugin;
		const hasKey = !!p.getCloudKey();
		new Setting(containerEl)
			.setName("Google Cloud 語音（Chirp 3 HD）")
			.setDesc(`很自然的聲音，每月前 100 萬字免費。目前：${p.settings.cloudTts ? "已開啟" : "未開啟"}、金鑰${hasKey ? "已設定" : "未設定"}、聲音 ${p.settings.cloudVoice || "Kore"}。`)
			.addButton((b) =>
				b
					.setButtonText("設定…")
					.setCta()
					.onClick(() => new CloudTtsModal(this.app, p, () => this.display()).open()),
			);
	}
}

/** Google Cloud 語音的設定對話框。金鑰直接寫進 app.secretStorage（不用 SecretComponent）。 */
export const CLOUD_SECRET_ID = "english-learning-cloud-tts";

export class CloudTtsModal extends Modal {
	constructor(app: App, private plugin: EnglishLearningPlugin, private onDone: () => void) {
		super(app);
	}

	onOpen() {
		const p = this.plugin;
		const el = this.contentEl;
		// 麵包屑（iPad 打開這個視窗會當掉，找是哪一步）
		const mark = (step: string) => this.app.saveLocalStorage(LS_SETTINGS_STEP, `cloud-modal:${step}`);
		mark("start");
		this.setTitle("Google Cloud 語音（Chirp 3 HD）");
		el.createEl("p", {
			cls: "setting-item-description",
			text: "每月前 100 萬字免費（Google 要求綁付費帳戶）。請用「另一個」Google Cloud 專案的金鑰：Gemini 用的那個專案一開付費，Gemini 就不再免費。順序：已存錄音 → 字典真人錄音 → Google Cloud 語音 → Gemini 語音 → 系統語音。",
		});
		mark("toggle");
		new Setting(el).setName("使用 Google Cloud 語音").addToggle((t) =>
			t.setValue(p.settings.cloudTts).onChange(async (v) => {
				p.settings.cloudTts = v;
				await p.saveSettings();
			}),
		);
		mark("key");
		const ss = (this.app as App & { secretStorage?: obsidian.SecretStorage }).secretStorage;
		const keySetting = new Setting(el)
			.setName("API key")
			.setDesc(
				p.getCloudKey()
					? "已設定（存在這台裝置的 Obsidian 安全儲存區，不進 Vault、不同步）。要換就貼上新的。"
					: "貼上金鑰。存在這台裝置的 Obsidian 安全儲存區，不進 Vault、不同步；每台裝置各貼一次。",
			)
			.addText((t) => {
				// 不用 type=password（iPad 的密碼自動填入可能出問題）；關掉自動完成、大寫、拼字
				t.inputEl.setAttribute("autocomplete", "off");
				t.inputEl.setAttribute("autocapitalize", "off");
				t.inputEl.setAttribute("autocorrect", "off");
				t.inputEl.spellcheck = false;
				t.setPlaceholder(p.getCloudKey() ? "（已設定，要換才貼）" : "AIza…");
				t.onChange(async (v) => {
					const key = v.trim();
					if (!key) return;
					try {
						if (ss) {
							ss.setSecret(CLOUD_SECRET_ID, key);
							p.settings.cloudKeySecretName = CLOUD_SECRET_ID;
							await p.saveSettings();
						} else {
							this.app.saveLocalStorage(LS_FALLBACK_CLOUD_KEY, key);
						}
						keySetting.setDesc("已儲存。按下面的「試聽」確認能用。");
					} catch (e) {
						keySetting.setDesc(`儲存失敗：${(e as Error)?.message ?? e}`);
					}
				});
			});
		mark("voice");
		new Setting(el)
			.setName("聲音")
			.setDesc("按「試聽」會用 Google Cloud 唸一句（約 50 字，算進每月字數）。")
			.addDropdown((d) => {
				for (const v of CHIRP_VOICES) d.addOption(v.name, v.label);
				d.setValue(p.settings.cloudVoice || "Kore").onChange(async (v) => {
					p.settings.cloudVoice = v;
					await p.saveSettings();
				});
			})
			.addButton((b) =>
				b.setButtonText("試聽").onClick(() => {
					unlockAudio();
					p.pronouncer.testCloud("Hi! I'm your English buddy. How was your day?").then(
						() => new Notice("Google Cloud 語音 OK"),
						(e) => new Notice(`Google Cloud 語音失敗：${(e as Error)?.message ?? e}`, 10000),
					);
				}),
			);
		mark("cap");
		const usage = new Setting(el)
			.setName("每月上限（字）")
			.setDesc("所有裝置合計，到了就改用其他語音，下個月恢復。免費額度是 1,000,000 字。")
			.addText((t) =>
				t.setValue(String(p.settings.cloudMonthlyCap)).onChange(async (v) => {
					const n = Math.max(0, Math.min(CLOUD_FREE_CHARS, Math.floor(Number(v.replace(/,/g, "")))));
					if (Number.isFinite(n)) {
						p.settings.cloudMonthlyCap = n;
						await p.saveSettings();
					}
				}),
			);
		// 本月用量要讀所有 log，改成按了才算
		usage.addButton((b) =>
			b.setButtonText("查看本月用量").onClick(() => {
				mark("usage");
				p.pronouncer.cloudUsage.used().then(
					(n) => {
						usage.setDesc(`所有裝置合計，到了就改用其他語音，下個月恢復。免費額度是 1,000,000 字。這個月已用 ${n.toLocaleString()} 字（${cloudMonth()}）。`);
						mark("usage-done");
					},
					(e) => usage.setDesc(`讀取用量失敗：${(e as Error)?.message ?? e}`),
				);
			}),
		);
		new Setting(el).addButton((b) => b.setButtonText("完成").setCta().onClick(() => this.close()));
		mark("rendered");
		window.setTimeout(() => mark("done"), 3000);
	}

	onClose() {
		this.contentEl.empty();
		this.onDone();
	}
}
