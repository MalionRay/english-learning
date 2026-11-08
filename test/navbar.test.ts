import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NAVBAR_VAR, navbarGap, watchNavbar } from "../src/navbar";

function addNav(height: number, style = "") {
	document.querySelectorAll(".mobile-navbar").forEach((e) => e.remove());
	const nav = document.createElement("div");
	nav.className = "mobile-navbar";
	nav.setAttribute("style", style);
	Object.defineProperty(nav, "offsetHeight", { configurable: true, get: () => height });
	document.body.appendChild(nav);
	return nav;
}

test("iPhone 浮動導覽列：高度＋離底部距離＋8px；藏起來、不是手機就是 0", () => {
	addNav(60, "position: fixed; bottom: 12px");
	assert.equal(navbarGap(document, true), 80);
	assert.equal(navbarGap(document, false), 0, "iPad、電腦不留空間");
	addNav(60, "position: fixed; bottom: 12px; display: none");
	assert.equal(navbarGap(document, true), 0);
	addNav(0);
	assert.equal(navbarGap(document, true), 0);
	document.querySelectorAll(".mobile-navbar").forEach((e) => e.remove());
	assert.equal(navbarGap(document, true), 0, "沒有導覽列");
});

test("watchNavbar 把量到的值設成 body 的 CSS 變數，卸載時清掉", () => {
	addNav(50, "position: fixed; bottom: 10px");
	const cleanups: (() => void)[] = [];
	const plugin: any = {
		app: { workspace: { on: () => ({}) } },
		registerDomEvent: () => undefined,
		registerEvent: () => undefined,
		registerInterval: (id: number) => (window.clearInterval(id), id),
		register: (f: () => void) => cleanups.push(f),
	};
	const update = watchNavbar(plugin, true);
	assert.equal(document.body.style.getPropertyValue(NAVBAR_VAR), "68px");
	addNav(70, "position: fixed; bottom: 10px");
	update();
	assert.equal(document.body.style.getPropertyValue(NAVBAR_VAR), "88px");
	cleanups.forEach((f) => f());
	assert.equal(document.body.style.getPropertyValue(NAVBAR_VAR), "");
	document.querySelectorAll(".mobile-navbar").forEach((e) => e.remove());
});
