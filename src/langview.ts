// 「語言」下拉選單：練習、對話、生字本、句子本、統計、主畫面共用。
// 選的語言記在這台裝置（每位使用者分開），改了會重畫所有畫面。
import { LANG, LANGS, Lang } from "./lang";

export interface LangHost {
	lang: Lang;
}

export function langSelect(parent: HTMLElement, plugin: LangHost, onChange?: (l: Lang) => void): HTMLSelectElement {
	parent.createSpan({ text: "語言" });
	const sel = parent.createEl("select", { cls: "dropdown el-lang-select" });
	for (const l of LANGS) sel.createEl("option", { text: LANG[l].name, value: l });
	sel.value = plugin.lang;
	sel.onchange = () => {
		const l = sel.value as Lang;
		plugin.lang = l;
		onChange?.(l);
	};
	return sel;
}
