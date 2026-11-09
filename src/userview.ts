// 新增／刪除使用者的畫面（設定頁與指令「新增使用者」）
import { App, Modal, Notice, Setting } from "obsidian";
import type EnglishLearningPlugin from "./main";
import type { Level } from "./generate";
import { CHAT_MEMORY_DEFAULT, CHAT_MEMORY_OPTIONS, LEVEL_NAME, chatMemoryLabel, checkNewName } from "./users";

export class AddUserModal extends Modal {
	private name = "";
	private level: Level = "adult";

	constructor(app: App, private plugin: EnglishLearningPlugin, private onDone: () => void = () => undefined) {
		super(app);
	}

	onOpen() {
		this.setTitle("新增使用者");
		const el = this.contentEl;
		el.createEl("p", { cls: "el-muted", text: "每位使用者的答題紀錄、生字本、句子本、對話和統計都分開。同步後其他裝置也會出現這位使用者。" });
		const err = el.createDiv({ cls: "el-warn" });
		new Setting(el)
			.setName("名字")
			.setDesc("英文字母、數字、- 或 _（例如 amy、kid2）")
			.addText((t) => {
				t.inputEl.setAttribute("autocapitalize", "off");
				t.inputEl.setAttribute("autocorrect", "off");
				t.setPlaceholder("amy").onChange((v) => {
					this.name = v;
					err.setText("");
				});
			});
		new Setting(el)
			.setName("程度")
			.setDesc("小孩：小孩題庫、對話對象是 Mia、句子比較簡單、只糾正基本錯誤")
			.addDropdown((d) =>
				d
					.addOption("adult", LEVEL_NAME.adult)
					.addOption("kid", LEVEL_NAME.kid)
					.setValue(this.level)
					.onChange((v) => (this.level = v === "kid" ? "kid" : "adult")),
			);
		const row = el.createDiv({ cls: "el-row el-modal-buttons" });
		row.createEl("button", { text: "取消" }).onclick = () => this.close();
		const ok = row.createEl("button", { text: "建立", cls: "mod-cta" });
		ok.onclick = async () => {
			const msg = checkNewName(this.name, this.plugin.userNames());
			if (msg) return void err.setText(msg);
			ok.disabled = true;
			try {
				const name = await this.plugin.addUser(this.name, this.level);
				new Notice(`已建立使用者「${name}」（${LEVEL_NAME[this.level]}），並切換成他`);
				this.close();
				this.onDone();
			} catch (e) {
				err.setText(String((e as Error)?.message ?? e));
				ok.disabled = false;
			}
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class DeleteUserModal extends Modal {
	constructor(app: App, private plugin: EnglishLearningPlugin, private name: string, private onDone: () => void = () => undefined) {
		super(app);
	}

	onOpen() {
		this.setTitle(`刪除使用者「${this.name}」`);
		const el = this.contentEl;
		el.createEl("p", { text: "會刪除這位使用者的所有資料，所有裝置同步後都會刪掉：" });
		const ul = el.createEl("ul");
		for (const t of ["答題紀錄與複習進度", "生字本、句子本、學習統計", "英文對話紀錄", "錯誤分析報告", "備份裡他的資料"]) ul.createEl("li", { text: t });
		el.createEl("p", { cls: "el-muted", text: "文章、題庫和錄音是大家共用的，不會刪。刪掉的檔案會照 Obsidian「刪除的檔案」設定放進垃圾桶。" });
		el.createEl("p", { text: `確定的話，請輸入名字「${this.name}」：` });
		const input = el.createEl("input", { cls: "el-cloze-input", attr: { type: "text", autocapitalize: "off", autocorrect: "off", placeholder: this.name } });
		const row = el.createDiv({ cls: "el-row el-modal-buttons" });
		row.createEl("button", { text: "取消" }).onclick = () => this.close();
		const del = row.createEl("button", { text: "刪除", cls: "mod-warning" });
		del.disabled = true;
		input.addEventListener("input", () => (del.disabled = input.value.trim().toLowerCase() !== this.name));
		const status = el.createDiv({ cls: "el-muted" });
		del.onclick = async () => {
			del.disabled = true;
			input.disabled = true;
			status.setText("刪除中…");
			try {
				const r = await this.plugin.removeUser(this.name);
				new Notice(`已刪除使用者「${this.name}」（${r.files} 個檔案${r.backups ? `，並清理 ${r.backups} 份備份` : ""}）`, 8000);
				this.close();
				this.onDone();
			} catch (e) {
				status.setText(`刪除失敗：${(e as Error)?.message ?? e}`);
			}
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** 設定頁的使用者區：每位一列（程度、刪除），最下面「新增使用者」。 */
export function drawUsersSection(container: HTMLElement, plugin: EnglishLearningPlugin, redraw: () => void) {
	new Setting(container).setName("使用者").setHeading();
	const users = plugin.users();
	for (const u of users) {
		const s = new Setting(container).setName(u.name).setDesc(`${LEVEL_NAME[u.level]}${u.name === plugin.user ? "・這台裝置目前的使用者" : ""}`);
		s.addButton((b) => {
			b.setButtonText("刪除…").onClick(() => new DeleteUserModal(plugin.app, plugin, u.name, redraw).open());
			if (users.length <= 1) b.setDisabled(true).setTooltip("至少要留一位使用者");
			else b.setWarning();
		});
	}
	new Setting(container)
		.setDesc("每位使用者的資料分開；新增或刪除後，同步到其他裝置也會一樣。")
		.addButton((b) => b.setButtonText("＋ 新增使用者…").setCta().onClick(() => new AddUserModal(plugin.app, plugin, redraw).open()));

	// 每位使用者自己的對話記憶長度（存在 english/users，所有裝置一樣）
	new Setting(container)
		.setName("對話記憶長度")
		.setDesc("對話時 AI 看得到最近幾則訊息（你和 AI 各算一則）。越多越記得前面聊過的事，回覆會稍慢一點。每位使用者各自設定，所有裝置一樣。")
		.setHeading();
	for (const u of users) {
		new Setting(container).setName(u.name).addDropdown((d) => {
			for (const n of CHAT_MEMORY_OPTIONS) d.addOption(String(n), chatMemoryLabel(n) + (n === CHAT_MEMORY_DEFAULT ? "（預設）" : ""));
			d.setValue(String(plugin.chatMemoryOf(u.name))).onChange(async (v) => {
				try {
					await plugin.setUserPref(u.name, "chatMemory", Number(v));
					new Notice(`${u.name} 的對話記憶：${chatMemoryLabel(Number(v))}`);
				} catch (e) {
					new Notice(`沒存到：${(e as Error)?.message ?? e}`);
				}
			});
		});
	}
}
