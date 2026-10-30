// 測試用的 Obsidian API 替身（只實作外掛用到的部分）
class TAbstractFile {}
class TFile extends TAbstractFile {
	constructor(path, size = 0) {
		super();
		this.path = path;
		const name = path.split("/").pop();
		this.name = name;
		this.basename = name.replace(/\.[^.]+$/, "");
		this.extension = name.includes(".") ? name.split(".").pop() : "";
		this.stat = { size, ctime: 0, mtime: 0 };
		const parentPath = path.split("/").slice(0, -1).join("/");
		this.parent = { path: parentPath, name: parentPath.split("/").pop() };
	}
}
class TFolder extends TAbstractFile {}
class Component {}
class ItemView {
	constructor(leaf) {
		this.leaf = leaf;
		this.app = leaf && leaf.app;
		this.contentEl = document.createElement("div");
		document.body.appendChild(this.contentEl);
	}
	registerEvent() {}
}
class Modal {
	constructor(app) {
		this.app = app;
		this.contentEl = document.createElement("div");
	}
	open() {
		globalThis.__lastModal = this;
		this.onOpen && this.onOpen();
	}
	close() {
		this.onClose && this.onClose();
	}
	setTitle(t) {
		this.title = t;
		return this;
	}
}
class Setting {
	constructor(el) {
		this.el = el;
		this.controlEl = document.createElement("div");
		el.appendChild(this.controlEl);
		this.desc = "";
	}
	setName(n) { this.name = n; return this; }
	setDesc(d) { this.desc = d; return this; }
	addToggle(cb) {
		const i = document.createElement("input");
		i.type = "checkbox";
		this.el.appendChild(i);
		const t = { setValue: (v) => { i.checked = v; return t; }, onChange: (f) => { i.onchange = () => f(i.checked); return t; } };
		cb(t);
		return this;
	}
	addButton(cb) {
		const b = document.createElement("button");
		this.el.appendChild(b);
		const o = { buttonEl: b, setButtonText: (x) => { b.textContent = x; return o; }, setCta: () => o, setDisabled: (d) => { b.disabled = d; return o; }, onClick: (f) => { b.onclick = f; return o; } };
		cb(o);
		return this;
	}
	addComponent(cb) { cb(this.controlEl); return this; }
	addDropdown(cb) {
		const s = document.createElement("select");
		this.el.appendChild(s);
		const d = {
			addOption: (v, t) => { const o = document.createElement("option"); o.value = v; o.text = t; s.appendChild(o); return d; },
			addOptions: (m) => { for (const k in m) d.addOption(k, m[k]); return d; },
			setValue: (v) => { s.value = v; return d; },
			onChange: (f) => { s.onchange = () => f(s.value); return d; },
		};
		cb(d);
		return this;
	}
	addText(cb) {
		const i = document.createElement("input");
		this.el.appendChild(i);
		const t = { inputEl: i, setPlaceholder: () => t, setValue: (v) => { i.value = v; return t; }, onChange: (f) => { i.oninput = () => f(i.value); return t; } };
		cb(t);
		return this;
	}
}
const notices = [];
class Notice {
	constructor(m) { this.message = m; notices.push(m); }
	setMessage(m) { this.message = m; }
	hide() {}
}
class Menu {
	constructor() { this.items = []; globalThis.__lastMenu = this; }
	addItem(cb) {
		const it = { title: "", disabled: false, cb: null, setTitle(t) { this.title = t; return this; }, setDisabled(d) { this.disabled = d; return this; }, onClick(f) { this.cb = f; return this; } };
		cb(it);
		this.items.push(it);
		return this;
	}
	showAtMouseEvent() {}
}
let handler = async () => { throw new Error("no network in tests"); };
module.exports = {
	TAbstractFile, TFile, TFolder, Component, ItemView, Modal, Setting, Notice, Menu,
	Platform: { isMobile: false, isIosApp: false, isTablet: false, isAndroidApp: false, isWin: true, isMacOS: false, isLinux: false, isDesktopApp: true },
	normalizePath: (p) => p.replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
	requestUrl: async (r) => handler(typeof r === "string" ? { url: r } : r),
	__setRequestHandler: (h) => { handler = h; },
	__notices: notices,
};
