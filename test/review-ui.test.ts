// v0.22.1：整份程式檢查後修正的問題（練習、對話、主畫面、生字本）
import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PracticeView } from "../src/practice";
import { ChatView, composing } from "../src/chatview";
import { HomeView, homeRelevant } from "../src/views";
import { WordsView } from "../src/wordviews";
import { settingsStepDone } from "../src/constants";
import { convBlock, convHeader, parseConvMessages } from "../src/chat";
import { renderBank } from "../src/generate";
import { makeApp } from "./helpers/app";
import { japaneseBank, sampleBank } from "./helpers/fixtures";
const ob = require("obsidian");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 假的外掛：makeEntry 會照指定的使用者記、appendLog 寫到那個人的檔案（和真的一樣）。 */
function fakePlugin(files: Map<string, string | ArrayBuffer>, app: any, over: Record<string, unknown> = {}) {
	let n = 0;
	const plugin: any = {
		app,
		user: "ray",
		lang: "en",
		deviceId: "ipad-1",
		settings: { users: ["ray", "kid"], newPerDay: 10 },
		userNames: () => ["ray", "kid"],
		chatMemoryOf: () => 50,
		levelOf: (u: string) => (u === "kid" ? "kid" : "adult"),
		getApiKey: () => "k",
		fastBackend() {
			return this.backend();
		},
		backend: () => ({ complete: async () => ({ text: '{"score":80,"feedback":"好","corrected":""}', usage: {}, model: "m" }) }),
		makeEntry(type: string, extra: Record<string, unknown> = {}, user?: string) {
			return { id: "e" + n++, ts: new Date().toISOString(), device: "ipad-1", user: user ?? this.user, type, ...extra };
		},
		appendLog: async (e: any) => {
			const path = `logs/${e.user}/ipad-1.jsonl`;
			files.set(path, String(files.get(path) ?? "") + JSON.stringify(e) + "\n");
		},
		appendText: async (f: any, s: string) => void files.set(f.path, String(files.get(f.path) ?? "") + s),
		addPhrase: async () => undefined,
		addWord: async () => undefined,
		say: () => undefined,
		syncAndWait: async () => true,
		fixQuestion: async () => null,
		triggerSync: () => undefined,
		debug: () => undefined,
		...over,
	};
	return plugin;
}

const linesOf = (files: Map<string, string | ArrayBuffer>, path: string) =>
	String(files.get(path) ?? "")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

function practice(lang: "en" | "ja" = "en", over: Record<string, unknown> = {}) {
	const { app, files } = makeApp(
		new Map([
			["english/bank/b1.md", renderBank(sampleBank(), "english/sources/Story")],
			["english/bank/ja1.md", renderBank(japaneseBank(), "english/sources/Tenki")],
			["logs/ray/ipad-1.jsonl", ""],
		]),
	);
	const plugin = fakePlugin(files, app, { lang, ...over });
	const view: any = new PracticeView({ app } as any, plugin);
	const btn = (t: string) => [...view.contentEl.querySelectorAll("button")].find((b: any) => b.textContent === t) as any;
	const card = (name: string) => [...view.contentEl.querySelectorAll(".el-type-card")].find((c: any) => c.querySelector(".el-title").textContent === name) as any;
	return { view, btn, card, plugin, files, app };
}

// ---------- 練習 ----------
test("練到一半在別的分頁換了使用者：作答還是記在開始練習的那個人", async () => {
	const { view, btn, card, plugin, files } = practice();
	await view.onOpen();
	await sleep(30);
	card("單字").querySelector("button").click();
	await sleep(30);
	assert.equal(view.contentEl.querySelector(".el-user-badge").textContent, "👤 ray");
	plugin.user = "kid"; // 爸爸在主畫面把使用者換成別人
	const q = view.items[0].q;
	view.contentEl.querySelectorAll("button.el-opt")[q.answer].click();
	const ray = linesOf(files, "logs/ray/ipad-1.jsonl").filter((e) => e.type === "answer");
	assert.equal(ray.length, 1, "記在 ray");
	assert.equal(ray[0].user, "ray");
	assert.equal(linesOf(files, "logs/kid/ipad-1.jsonl").length, 0, "kid 的紀錄沒有被寫到");
	btn("下一題").click();
	assert.equal(view.contentEl.querySelector(".el-user-badge").textContent, "👤 ray", "畫面上顯示的也是這場練習的人");
});

test("答錯後回報這題、它又剛好是最後一題：按「下一題」直接看結果，不會壞掉", async () => {
	const { view, btn, card } = practice();
	await view.onOpen();
	await sleep(30);
	card("單字").querySelector("button").click();
	await sleep(30);
	const total = view.items.length;
	for (let i = 0; i < total - 1; i++) {
		const q = view.items[view.idx].q;
		view.contentEl.querySelectorAll("button.el-opt")[q.answer].click();
		btn("下一題").click();
	}
	btn("我不知道").click(); // 最後一題答錯：排到後面再練一次
	assert.equal(view.items.length, total + 1);
	assert.ok(btn("下一題"), "這時候按鈕寫的是下一題");
	await view.flagCurrent("答案標錯了"); // 回報：後面那個「再練一次」被拿掉
	assert.equal(view.items.length, total);
	assert.doesNotThrow(() => btn("下一題").click());
	assert.ok(btn("結束並同步"), "直接到結果畫面");
});

test("假名卡片沒有「回報」（那不是 AI 出的題目，不能請 AI 重出）", async () => {
	const { view, card } = practice("ja");
	await view.onOpen();
	await sleep(30);
	card("假名").querySelector("button").click();
	await sleep(30);
	assert.ok(view.contentEl.querySelector(".el-kana-big"));
	assert.equal(view.contentEl.querySelector(".el-flag"), null);
	// 一般題目還是有
	const en = practice();
	await en.view.onOpen();
	await sleep(30);
	en.card("單字").querySelector("button").click();
	await sleep(30);
	assert.ok(en.view.contentEl.querySelector(".el-flag"));
});

test("讀題庫失敗：回到開始畫面並提示，不會卡在「準備題目…」", async () => {
	const { view, card, app } = practice();
	await view.onOpen();
	await sleep(30);
	const start = card("單字").querySelector("button");
	const before = ob.__notices.length;
	const read = app.vault.cachedRead;
	app.vault.cachedRead = async () => {
		throw new Error("讀不到檔案");
	};
	start.click();
	await sleep(30);
	app.vault.cachedRead = read;
	assert.ok(ob.__notices.slice(before).some((m: string) => /讀取題庫或紀錄失敗：讀不到檔案/.test(m)));
	assert.equal(view.phase, "start");
	assert.equal(view.contentEl.querySelector(".el-busy"), null, "不再顯示「準備題目…」");
	view.render(); // 檔案讀得到之後（例如同步完成）畫面重畫
	await sleep(30);
	assert.ok(view.contentEl.querySelector(".el-type-card"), "開始畫面回來了，可以再按一次");
});

test("克漏字：輸入法選字時按的 Enter 不送出；選完字再按才送出", async () => {
	const { view, card } = practice("ja");
	await view.onOpen();
	await sleep(30);
	card("克漏字").querySelector("button").click();
	await sleep(30);
	const input = view.contentEl.querySelector("input.el-cloze-input");
	input.value = "さんぽ";
	const key = (keyCode: number, isComposing = false) => input.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", keyCode, isComposing, bubbles: true, cancelable: true }));
	key(229); // Safari：選字的 Enter 沒有 isComposing，但 keyCode 是 229
	assert.equal(view.contentEl.querySelector(".el-verdict"), null, "還在選字，不送出");
	key(13, true); // 其他瀏覽器：isComposing
	assert.equal(view.contentEl.querySelector(".el-verdict"), null);
	input.value = "さんぽします";
	key(13);
	assert.match(view.contentEl.querySelector(".el-verdict").textContent, /答對/);
});

// ---------- 對話 ----------
function chat(replies: (object | string)[], over: Record<string, unknown> = {}, extraFiles: [string, string][] = []) {
	const { app, files } = makeApp(new Map<string, string>([["logs/ray/ipad-1.jsonl", ""], ...extraFiles]));
	const turns: any[][] = [];
	let n = 0;
	const plugin = fakePlugin(files, app, {
		backend: () => ({
			chat: async (t: any[]) => {
				turns.push(JSON.parse(JSON.stringify(t)));
				const r = replies[Math.min(n++, replies.length - 1)];
				if (r instanceof Error) throw r;
				return typeof r === "string" ? { text: r, usage: {}, model: "m", finishReason: "MAX_TOKENS" } : { text: JSON.stringify(r), usage: {}, model: "m" };
			},
			complete: async () => ({ text: '{"zh":[]}', usage: {}, model: "m" }),
		}),
		...over,
	});
	app.saveLocalStorage("english-learning:chat-voice", "off");
	const view: any = new ChatView({ app } as any, plugin);
	const conv = () => [...files.keys()].filter((k) => k.startsWith("conversations/"));
	return { view, plugin, files, app, turns, conv };
}
const FREE = { id: "free", label: "自由聊天", prompt: "Free chat." };
const hi = { correction: null, howto: [], reply: "Hi! What did you do today?", replyZh: "嗨" };

test("AI 回了空白的內容：當作沒有回應、不存進對話，下一次送出照常", async () => {
	const { view, files, turns, conv } = chat([hi, "", { correction: null, howto: [], reply: "Sounds fun!", replyZh: "聽起來很好玩" }]);
	await view.onOpen();
	await view.startNew(FREE, undefined, false);
	await view.send("I played basketball.");
	assert.match(view.contentEl.querySelector(".el-chat-typing").textContent, /AI 沒有回應：AI 的回覆太長被截斷了（可以再送一次）/);
	const stored = parseConvMessages(String(files.get(conv()[0])));
	assert.deepEqual(
		stored.map((m) => m.role),
		["model", "user"],
		"空白的 AI 訊息沒有寫進對話檔",
	);
	assert.equal(view.messages.length, 2);
	await view.send("I played basketball.");
	const last = turns[turns.length - 1];
	assert.ok(last.every((t: any) => t.text.trim()), "送給 AI 的每一則都有內容");
	assert.deepEqual(
		last.map((t: any) => t.role),
		["user", "model", "user"],
	);
	assert.match(view.contentEl.textContent, /Sounds fun!/);
});

test("以前留下的空白 AI 訊息（舊版寫進對話檔的）：續聊時不會再送出去", async () => {
	const head = convHeader({ user: "ray", level: "adult", topic: "free", topicLabel: "自由聊天", device: "ipad-1", started: "2026-11-01T00:00:00.000Z" });
	const body = [
		convBlock({ role: "model", text: JSON.stringify(hi), ts: "1" }),
		convBlock({ role: "user", text: "I went hiking.", ts: "2" }),
		convBlock({ role: "model", text: "", ts: "3" }),
	].join("");
	const { view, turns, app } = chat([{ correction: null, howto: [], reply: "Nice!", replyZh: "不錯" }], {}, [["conversations/2026-11-01-ipad-1-1.md", head + body]]);
	await view.onOpen();
	const f = app.vault.getAbstractFileByPath("conversations/2026-11-01-ipad-1-1.md");
	await view.resume(f, app.metadataCache.getFileCache(f).frontmatter, false);
	await view.send("It was great.");
	assert.ok(turns[0].every((t: any) => t.text.trim()));
	assert.equal(turns[0][turns[0].length - 1].text, "I went hiking.\nIt was great.");
});

test("「開始對話」連點兩下只開一個對話", async () => {
	const { view, conv, turns } = chat([hi]);
	await view.onOpen();
	await Promise.all([view.startNew(FREE, undefined, false), view.startNew(FREE, undefined, false)]);
	assert.equal(conv().length, 1);
	assert.equal(turns.length, 1, "AI 只開場一次");
});

test("開新對話：同名的檔案已經在磁碟上（還沒進索引）就用下一個序號；建檔失敗會提示", async () => {
	const { view, conv, app, files } = chat([hi]);
	await view.onOpen();
	const d = new Date();
	const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	// 假裝這個檔案剛同步下來：磁碟上有，但 Obsidian 的索引還沒有
	const existing = `conversations/${day}-ipad-1-1.md`;
	files.set(existing, "x");
	const indexed = app.vault.getAbstractFileByPath;
	app.vault.getAbstractFileByPath = (p: string) => (p === existing ? null : indexed(p));
	await view.startNew(FREE, undefined, false);
	app.vault.getAbstractFileByPath = indexed;
	assert.deepEqual(conv().sort(), [existing, `conversations/${day}-ipad-1-2.md`]);
	assert.equal(files.get(existing), "x", "原本的檔案沒被動到");

	const failing = chat([hi]);
	await failing.view.onOpen();
	failing.app.vault.create = async () => {
		throw new Error("磁碟滿了");
	};
	const before = ob.__notices.length;
	await failing.view.startNew(FREE, undefined, false);
	assert.ok(ob.__notices.slice(before).some((m: string) => /無法開始對話：磁碟滿了/.test(m)));
	assert.equal(failing.view.phase, "start");
	// 失敗後可以再試
	assert.equal(failing.view.starting, false);
});

test("名字是數字的使用者：之前的對話找得到、可以繼續聊", async () => {
	const head = convHeader({ user: "2026", level: "adult", topic: "free", topicLabel: "自由聊天", device: "ipad-1", started: "2026-11-01T00:00:00.000Z" });
	const old = "---\nuser: 7\nlevel: adult\ntopic: free\ntopicLabel: 自由聊天\ndevice: ipad-1\nstarted: 2026-10-01T00:00:00.000Z\n---\n"; // 舊版沒加引號，讀回來是數字
	const { view, plugin } = chat([hi], { user: "2026", userNames: () => ["2026", "7"] }, [
		["conversations/2026-11-01-ipad-1-1.md", head + convBlock({ role: "model", text: JSON.stringify(hi), ts: "1" })],
		["conversations/2026-10-01-ipad-1-1.md", old + convBlock({ role: "model", text: JSON.stringify(hi), ts: "1" })],
	]);
	await view.onOpen();
	await sleep(10);
	const rows = () => [...view.contentEl.querySelectorAll(".el-card")].filter((c: any) => /繼續聊|查看/.test(c.textContent));
	assert.equal(rows().length, 1, "看得到自己（2026）的那個對話");
	plugin.user = "7";
	view.render();
	await sleep(10);
	assert.equal(rows().length, 1, "舊版寫的（沒加引號、讀成數字 7）也對得上");
});

test("聊到一半換了使用者：複習紀錄、句子本、生字本還是記在開始對話的那個人", async () => {
	const phrases: any[] = [];
	const words: any[] = [];
	const { view, plugin, files } = chat(
		[hi, { correction: { original: "I go yesterday", corrected: "I went yesterday.", explanation: "過去式", zh: "我昨天去了" }, howto: [], reply: "Where did you go?", replyZh: "去哪" }],
		{
			addPhrase: async (p: any, user?: string) => void phrases.push({ en: p.en, user }),
			addWord: async (w: string, _c: unknown, _b: unknown, _l: unknown, user?: string) => void words.push({ w, user }),
		},
	);
	await view.onOpen();
	await view.startNew(FREE, undefined, false);
	plugin.user = "kid";
	await view.send("I go yesterday");
	assert.deepEqual(phrases, [{ en: "I went yesterday.", user: "ray" }]);
	assert.equal(view.contentEl.querySelector(".el-user-badge").textContent, "👤 ray");
	const api = linesOf(files, "logs/ray/ipad-1.jsonl").filter((e) => e.type === "api");
	assert.ok(api.length >= 1 && api.every((e) => e.user === "ray"));
	assert.equal(linesOf(files, "logs/kid/ipad-1.jsonl").length, 0);
	// 點字 → 加入生字本
	view.wordMenu(new (window as any).MouseEvent("click"), "yesterday", "I went yesterday.");
	const menu = (globalThis as any).__lastMenu;
	menu.items.find((i: any) => /加入生字本/.test(i.title)).cb();
	await sleep(5);
	assert.deepEqual(words, [{ w: "yesterday", user: "ray" }]);
});

test("等 AI 回覆的時候結束對話、又開了新的：舊回覆存回舊對話檔，不會跑進新對話", async () => {
	const gates: ((v: unknown) => void)[] = [];
	const { view, files, conv } = chat([], { backend: () => ({ chat: () => new Promise((ok) => gates.push(ok)), complete: async () => ({ text: '{"zh":[]}', usage: {}, model: "m" }) }) });
	await view.onOpen();
	const reply = (text: string) => ({ text: JSON.stringify({ correction: null, howto: [], reply: text, replyZh: "" }), usage: {}, model: "m" });
	const first = view.startNew(FREE, undefined, false);
	await sleep(5);
	gates[0](reply("Hello from chat one."));
	await first;
	const sending = view.send("First question"); // AI 很慢，還沒回
	await sleep(5);
	view.end(); // 等不及，按了結束
	const second = view.startNew(FREE, undefined, false); // 又開一個新對話（開場也還在等）
	await sleep(5);
	gates[1](reply("Late answer for chat one.")); // 舊對話的回覆這時候才回來
	await sending;
	assert.equal(view.sending, true, "新對話的開場還在等：狀態不能被舊請求改掉");
	gates[2](reply("Hello from chat two."));
	await second;
	const [c1, c2] = conv().sort();
	assert.match(String(files.get(c1)), /Late answer for chat one/, "回覆還是存回原本的對話檔");
	assert.doesNotMatch(String(files.get(c2)), /Late answer/);
	assert.doesNotMatch(view.contentEl.textContent, /Late answer/, "不會出現在新對話的畫面上");
	assert.equal(view.messages.length, 1, "也不會進到新對話的歷史");
	assert.match(view.messages[0].text, /Hello from chat two/);
	assert.equal(view.sending, false);
});

test("輸入法選字的 Enter 不算送出", () => {
	assert.equal(composing({ isComposing: true, keyCode: 13 } as any), true);
	assert.equal(composing({ isComposing: false, keyCode: 229 } as any), true, "Safari");
	assert.equal(composing({ isComposing: false, keyCode: 13 } as any), false);
});

// ---------- 主畫面、生字本、設定 ----------
test("主畫面：錄音檔的變動不重畫；連續很多個檔案事件合併成一次", async () => {
	assert.equal(homeRelevant("english/audio/ipad-1/abc.mp3"), false);
	assert.equal(homeRelevant("english/users/ipad-1.jsonl"), false);
	assert.equal(homeRelevant("english/sources/Story.md"), true);
	assert.equal(homeRelevant("english/bank/b1.md"), true);
	assert.equal(homeRelevant("english/fixes/ipad-1.jsonl"), true);
	const { app, files } = makeApp(new Map([["logs/ray/ipad-1.jsonl", ""]]));
	const plugin = fakePlugin(files, app, { settings: { users: ["ray"], sourceLevel: "adult" } });
	const view: any = new HomeView({ app } as any, plugin);
	let renders = 0;
	view.render = () => void renders++;
	for (let i = 0; i < 50; i++) view.renderSoon(20);
	assert.equal(renders, 0, "不是每個事件都馬上重畫");
	await sleep(60);
	assert.equal(renders, 1);
	view.renderSoon(20);
	await view.onClose(); // 關掉畫面後不再重畫
	await sleep(40);
	assert.equal(renders, 1);
});

test("生字本：正在畫的時候又換了使用者，畫完會再畫一次（不會停在前一個人的內容）", async () => {
	const { app, files } = makeApp(
		new Map([
			["english/bank/b1.md", renderBank(sampleBank(), "english/sources/Story")],
			["logs/ray/ipad-1.jsonl", JSON.stringify({ id: "w1", ts: "2026-11-01T00:00:00.000Z", type: "word-add", word: "lantern", meaning: "燈籠" }) + "\n"],
			["logs/kid/ipad-1.jsonl", JSON.stringify({ id: "w2", ts: "2026-11-01T00:00:00.000Z", type: "word-add", word: "pebble", meaning: "小石頭" }) + "\n"],
		]),
	);
	const plugin = fakePlugin(files, app, { levelOf: () => "adult" });
	const view: any = new WordsView({ app } as any, plugin);
	const first = view.render(); // 開始畫 ray 的
	plugin.user = "kid";
	view.render(); // 還在畫的時候換成 kid
	await first;
	await sleep(10);
	const text = view.contentEl.textContent;
	assert.match(text, /pebble/, "最後顯示的是 kid 的生字本");
	assert.doesNotMatch(text, /lantern/);
});

test("設定頁上次有沒有畫完：Google Cloud 語音視窗的 done 也算", () => {
	assert.equal(settingsStepDone("done"), true);
	assert.equal(settingsStepDone("cloud-modal:done"), true, "之前會誤報成沒畫完");
	assert.equal(settingsStepDone("cloud-modal:key"), false);
	assert.equal(settingsStepDone("Gemini 語音"), false);
	assert.equal(settingsStepDone("start"), false);
});
