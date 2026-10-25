// 在 Node 裡用 jsdom 模擬瀏覽器，並補上 Obsidian 對 HTMLElement 的擴充方法
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><body></body>");
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLButtonElement = dom.window.HTMLButtonElement;
Object.defineProperty(global, "navigator", { value: { onLine: true }, configurable: true });
dom.window.setTimeout = setTimeout;
dom.window.clearTimeout = clearTimeout;
const P = dom.window.HTMLElement.prototype;
function apply(el, o) {
	if (!o) return el;
	if (typeof o === "string") { el.className = o; return el; }
	if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
	if (o.text !== undefined) el.textContent = o.text;
	if (o.attr) for (const k in o.attr) el.setAttribute(k, o.attr[k]);
	return el;
}
P.createEl = function (tag, o, cb) { const e = apply(document.createElement(tag), o); this.appendChild(e); if (cb) cb(e); return e; };
P.createDiv = function (o, cb) { return this.createEl("div", o, cb); };
P.createSpan = function (o, cb) { return this.createEl("span", o, cb); };
P.empty = function () { this.innerHTML = ""; };
P.addClass = function (c) { this.classList.add(c); };
P.removeClass = function (c) { this.classList.remove(c); };
P.hasClass = function (c) { return this.classList.contains(c); };
P.setText = function (t) { this.textContent = t; };
P.scrollIntoView = function () {};
