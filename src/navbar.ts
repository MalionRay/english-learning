// iPhone：Obsidian 手機版下方有浮動導覽列（.mobile-navbar），會蓋住外掛畫面最下面（例如對話的輸入框、麥克風、送出）。
// 量它的高度＋離底部的距離，存成 body 上的 CSS 變數 --el-navbar-gap，外掛畫面的底部留這麼多空間（styles.css）。
// 用 CSS 的 bottom 而不是畫面位置：捲動時導覽列會滑出去又回來，保留固定空間畫面才不會跳。iPad、電腦沒有這個導覽列＝0。
import { Platform, Plugin } from "obsidian";

export const NAVBAR_VAR = "--el-navbar-gap";

export function navbarGap(doc: Document = document, isPhone: boolean = Platform.isPhone): number {
	if (!isPhone) return 0;
	const nav = doc.querySelector<HTMLElement>(".mobile-navbar");
	if (!nav) return 0;
	const cs = (doc.defaultView ?? window).getComputedStyle(nav);
	if (cs.display === "none" || cs.visibility === "hidden") return 0;
	const h = nav.offsetHeight || nav.getBoundingClientRect().height;
	if (!h) return 0;
	const bottom = parseFloat(cs.bottom);
	return Math.ceil(h + (isFinite(bottom) && bottom > 0 ? bottom : 0) + 8);
}

export function watchNavbar(plugin: Plugin, isPhone: boolean = Platform.isPhone): () => void {
	const body = document.body;
	let last = -1;
	const update = () => {
		const g = navbarGap(document, isPhone);
		if (g === last) return;
		last = g;
		body.style.setProperty(NAVBAR_VAR, `${g}px`);
	};
	update();
	if (!isPhone) return update;
	plugin.registerDomEvent(window, "resize", update);
	const vv = window.visualViewport;
	if (vv) {
		vv.addEventListener("resize", update);
		plugin.register(() => vv.removeEventListener("resize", update));
	}
	plugin.registerEvent(plugin.app.workspace.on("layout-change", update));
	// 導覽列是 Obsidian 畫的，出現時間不一定：每 2 秒再量一次（數字沒變就不動）
	plugin.registerInterval(window.setInterval(update, 2000));
	plugin.register(() => body.style.removeProperty(NAVBAR_VAR));
	return update;
}
