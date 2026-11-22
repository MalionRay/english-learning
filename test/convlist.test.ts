// v0.24.1：刪掉對話檔（或改名、從別台裝置同步進來）時，對話開始畫面的「之前的對話」馬上更新
// （使用者 2026-11-22：刪除對話時畫面沒有馬上更新）；正在聊的對話檔被刪掉就回到開始畫面
import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatView } from "../src/chatview";
import { convHeader } from "../src/chat";
import { makeApp, NO_MEMORY } from "./helpers/app";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ob = require("obsidian");

function setup() {
	const conv = (n: number) =>
		[`conversations/2026-11-2${n}-ipad-1-1.md`, convHeader({ user: "kid", level: "kid", topic: "free", topicLabel: `聊天${n}`, device: "ipad-1", started: `2026-11-2${n}T10:00:00Z` })] as [string, string];
	const { app, files } = makeApp(new Map([conv(1), conv(2), ["logs/kid/ipad-1.jsonl", ""]]));
	const handlers: Record<string, ((...a: any[]) => void)[]> = {};
	const on = (name: string, fn: (...a: any[]) => void) => ((handlers[name] ??= []).push(fn), {});
	app.vault.on = on;
	app.metadataCache.on = (name: string, fn: any) => on("meta:" + name, fn);
	const fire = (name: string, ...a: any[]) => (handlers[name] ?? []).forEach((fn) => fn(...a));
	const plugin: any = {
		app,
		user: "kid",
		lang: "en",
		deviceId: "ipad-1",
		settings: { users: ["kid"] },
		userNames: () => ["kid"],
		chatMemoryOf: () => 50,
		...NO_MEMORY,
		levelOf: () => "kid",
		getApiKey: () => "k",
		fastBackend: () => ({ chat: async () => ({ text: JSON.stringify({ correction: null, howto: [], reply: "Hi!", replyZh: "嗨" }), usage: {}, model: "m" }), complete: async () => ({ text: "{}", usage: {}, model: "m" }) }),
		appendText: async (f: any, s: string) => void files.set(f.path, String(files.get(f.path) ?? "") + s),
		makeEntry: (type: string, extra: any) => ({ id: "e" + Math.random(), ts: new Date().toISOString(), type, ...extra }),
		appendLog: async () => undefined,
		addPhrase: async () => undefined,
		debug: () => undefined,
		triggerSync: () => undefined,
	};
	app.saveLocalStorage("english-learning:chat-voice", "off");
	const view: any = new ChatView({ app } as any, plugin);
	const titles = () => [...view.contentEl.querySelectorAll(".el-card .el-title")].map((e: any) => e.textContent);
	return { view, files, fire, titles, conv };
}

test("刪掉、新增、改名對話檔：開始畫面的「之前的對話」馬上更新", async () => {
	const { view, files, fire, titles, conv } = setup();
	await view.onOpen();
	assert.deepEqual(titles(), ["聊天2", "聊天1"]);

	const gone = "conversations/2026-11-21-ipad-1-1.md";
	files.delete(gone);
	fire("delete", new ob.TFile(gone, 0));
	await sleep(350);
	assert.deepEqual(titles(), ["聊天2"], "刪掉的不見了");

	const [p3, md3] = conv(3);
	files.set(p3, md3); // 別台裝置同步過來（frontmatter 讀好時會有 changed）
	fire("meta:changed", new ob.TFile(p3, md3.length));
	await sleep(350);
	assert.deepEqual(titles(), ["聊天3", "聊天2"]);

	fire("delete", new ob.TFile("english/bank/x.md", 0)); // 不是對話檔：不重畫
	fire("rename", new ob.TFile("notes/a.md", 0), "notes/b.md");
	const before = view.contentEl.firstElementChild;
	await sleep(350);
	assert.equal(view.contentEl.firstElementChild, before);
});

test("正在聊的對話檔被刪掉：回到開始畫面，不會再寫進那個檔", async () => {
	const { view, files, fire, titles } = setup();
	await view.onOpen();
	await view.startNew({ id: "free", label: "自由聊天", prompt: "x" }, undefined, false);
	const path = view.file.path;
	assert.equal(view.phase, "chat");
	files.delete(path);
	fire("delete", new ob.TFile(path, 0));
	assert.equal(view.phase, "start");
	assert.equal(view.file, null);
	assert.ok(!files.has(path), "沒有被重新建立");
	assert.ok(titles().length >= 1, "開始畫面畫出來了");
	assert.match(ob.__notices.at(-1), /這個對話檔已經刪除/);
});
