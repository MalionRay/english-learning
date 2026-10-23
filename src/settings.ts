import * as obsidian from "obsidian";
import { App, PluginSettingTab, Setting } from "obsidian";
import type EnglishLearningPlugin from "./main";
import { DEFAULTS, LS_FALLBACK_KEY } from "./constants";
import { safeName } from "./logs";

export class ELSettingTab extends PluginSettingTab {
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

		new Setting(containerEl)
			.setName("出題後自動同步")
			.setDesc("出題完成後立刻觸發 Remotely Save 上傳，讓其他裝置可以練習。")
			.addToggle((t) =>
				t.setValue(p.settings.syncAfterGenerate).onChange(async (v) => {
					p.settings.syncAfterGenerate = v;
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
