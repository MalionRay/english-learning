// v0.24.0：像真人老師一樣在對話裡當場糾正（使用者 2026-11-22：文字批改和真人練習很不一樣、不實用）
// 順口重說／一句話提醒／請他再說一次；改對的字標粗；中文說明收起來；每位使用者可以選糾正方式（預設自動）
import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatSystemPrompt, convBlock, fixPrompt, focusRange, parseReply } from "../src/chat";
import { ChatView } from "../src/chatview";
import { CORRECTION_DEFAULT, normalizeCorrection, replayUsers } from "../src/users";
import { makeApp, NO_MEMORY } from "./helpers/app";

const FREE = { id: "free", label: "自由聊天", prompt: "Free chat." };

test("提示：不再規定糾正只能寫在文字卡片；回覆格式有 style、focus、retryResult", () => {
	for (const lang of ["en", "es", "ja"] as const) {
		const s = chatSystemPrompt("kid", FREE, undefined, lang);
		assert.doesNotMatch(s, /Never put corrections/, lang);
		assert.match(s, /"style": "recast" \| "tip" \| "retry" \| "silent"/, lang);
		assert.match(s, /"focus": /, lang);
		assert.match(s, /"retryResult": null \| "ok" \| "again" \| "skip"/, lang);
		assert.match(s, /except when you say a corrected version back/, lang);
	}
});

test("糾正的指示：依糾正方式、程度、語言與上一則的狀態", () => {
	const kid = fixPrompt("auto", "kid", "en");
	assert.match(kid, /fix AT MOST ONE thing out loud/);
	assert.match(kid, /prefer "recast" and "retry"/);
	assert.doesNotMatch(kid, /previous reply asked them/);
	assert.match(fixPrompt("auto", "adult", "en"), /wrong word choice → "tip"/);
	assert.match(fixPrompt("recast", "kid", "en"), /Only use "recast".*never ask them to say it again/);
	assert.match(fixPrompt("tip", "adult", "en"), /Always point at the most important mistake with "tip"/);
	// 西班牙文、日文：例子是英文，照樣用那個語言做；日文初學者少用一句話提醒
	assert.match(fixPrompt("auto", "adult", "es"), /do the same in Spanish/);
	assert.match(fixPrompt("auto", "adult", "ja"), /beginner in Japanese: prefer "recast" and "retry"/);
	// 上一則請他再說一次：告訴 AI 目標，這一則判斷有沒有改對，而且不能又要求一次
	const pending = fixPrompt("auto", "kid", "en", { retryTarget: "I like playing soccer.", retryFocus: "playing" });
	assert.match(pending, /The target: "I like playing soccer\." \(the part that was fixed: "playing"\)/);
	assert.match(pending, /"retryResult": "ok"/);
	assert.match(pending, /WITHOUT asking them to repeat it again/);
	assert.match(pending, /Do not use style "retry" in this reply/);
	assert.match(fixPrompt("auto", "kid", "en", { recentRetry: true }), /very recently, so do not use style "retry"/);
});

test("解析回覆：style、focus（一定要在回覆裡）、retryResult", () => {
	const r = parseReply(
		JSON.stringify({
			correction: { original: "I like play soccer.", corrected: "I like playing soccer.", explanation: "like 後面接 -ing", zh: "我喜歡踢足球", style: "recast", focus: "Playing" },
			howto: [],
			reply: "Oh, you like playing soccer? Me too!",
			replyZh: "喔，你喜歡踢足球？我也是！",
			retryResult: "ok",
		}),
	);
	assert.deepEqual([r.correction?.style, r.correction?.focus, r.retryResult], ["recast", "Playing", "ok"]);
	assert.deepEqual(focusRange(r.reply, r.correction?.focus), [13, 20], "不分大小寫");
	const bad = parseReply(
		JSON.stringify({
			correction: { original: "a", corrected: "b c", explanation: "", zh: "", style: "loud", focus: "not there" },
			howto: [],
			reply: "Hello!",
			replyZh: "",
			retryResult: "maybe",
		}),
	);
	assert.deepEqual([bad.correction?.style, bad.correction?.focus, bad.retryResult], [undefined, undefined, undefined], "不認得的值不用；抄錯的字不標");
	const silent = parseReply(JSON.stringify({ correction: { original: "a", corrected: "b", style: "silent", focus: "Hello" }, howto: [], reply: "Hello!" }));
	assert.equal(silent.correction?.focus, undefined, "沒說出來就沒有要標的字");
	assert.equal(focusRange("abc", ""), null);
});

test("對話檔：修正標出怎麼糾正的、當場改對了也記下來", () => {
	const md = convBlock({
		role: "model",
		ts: "2026-11-22T13:00:00.000Z",
		text: JSON.stringify({
			correction: { original: "I go park.", corrected: "I went to the park.", explanation: "過去式", zh: "我去了公園", style: "retry", focus: "went" },
			howto: [],
			reply: "Yesterday I... go or went? Say it again!",
			replyZh: "",
			retryResult: "ok",
		}),
	});
	assert.match(md, /> \[!success\] 當場改對了/);
	assert.match(md, /> \[!warning\] 修正・請你再說一次/);
});

test("每位使用者的糾正方式：預設自動、存在使用者清單裡（user-set）", () => {
	assert.equal(CORRECTION_DEFAULT, "auto");
	assert.deepEqual(["tip", "recast", "auto", undefined, "loud", 3].map(normalizeCorrection), ["tip", "recast", "auto", "auto", "auto", "auto"]);
	const users = replayUsers([
		{ id: "1", ts: "2026-11-01T00:00:00Z", device: "d", type: "user-add", name: "kid", level: "kid" },
		{ id: "2", ts: "2026-11-22T00:00:00Z", device: "d", type: "user-set", name: "kid", key: "correction", value: "recast" },
	] as any);
	assert.equal(users[0].prefs.correction, "recast");
});

/** 對話畫面；AI 依序回 replies，記下每次的系統提示。 */
function chat(replies: object[], mode = "auto") {
	const { app, files } = makeApp(new Map([["logs/kid/ipad-1.jsonl", ""]]));
	const systems: string[] = [];
	const prefs: [string, string, unknown][] = [];
	let n = 0;
	const plugin: any = {
		app,
		user: "kid",
		lang: "en",
		deviceId: "ipad-1",
		settings: { users: ["kid"] },
		userNames: () => ["ray", "kid"],
		chatMemoryOf: () => 50,
		...NO_MEMORY,
		correctionOf: () => mode,
		setUserPref: async (u: string, k: string, v: unknown) => void prefs.push([u, k, v]),
		levelOf: (u: string) => (u === "kid" ? "kid" : "adult"),
		getApiKey: () => "k",
		fastBackend() {
			return {
				chat: async (_t: unknown, o: any) => (systems.push(o.system), { text: JSON.stringify(replies[n++]), usage: {}, model: "m" }),
				complete: async () => ({ text: '{"zh":[]}', usage: {}, model: "m" }),
			};
		},
		appendText: async (f: any, s: string) => void files.set(f.path, String(files.get(f.path) ?? "") + s),
		makeEntry: (type: string, extra: Record<string, unknown>) => ({ id: "e" + Math.random(), ts: new Date().toISOString(), device: "ipad-1", user: "kid", type, ...extra }),
		appendLog: async () => undefined,
		addPhrase: async () => undefined,
		debug: () => undefined,
		triggerSync: () => undefined,
	};
	app.saveLocalStorage("english-learning:chat-voice", "off");
	const view: any = new ChatView({ app } as any, plugin);
	return { view, systems, prefs };
}

const hi = { correction: null, howto: [], reply: "Hi! I'm Mia. What do you like to do?", replyZh: "嗨" };

test("對話：改對的字在 AI 說的話裡標粗，中文說明收在「為什麼？」；請他再說一次、說對了標「改對了」", async () => {
	const { view, systems } = chat([
		hi,
		{
			correction: { original: "I like play soccer.", corrected: "I like playing soccer.", explanation: "like 後面接動詞要加 -ing", zh: "我喜歡踢足球", style: "recast", focus: "playing" },
			howto: [],
			reply: "Oh, you like playing soccer? Me too!",
			replyZh: "喔，你喜歡踢足球？我也是！",
		},
		{
			correction: { original: "Yesterday I go park.", corrected: "Yesterday I went to the park.", explanation: "昨天要用過去式 went", zh: "我昨天去公園", style: "retry", focus: "went" },
			howto: [],
			reply: "Yesterday I... go or went? Say it again!",
			replyZh: "昨天我……go 還是 went？再說一次！",
		},
		{ correction: null, howto: [], reply: "Yes! You went to the park. What did you do there?", replyZh: "", retryResult: "ok" },
		{ correction: null, howto: [], reply: "Cool!", replyZh: "酷！" },
	]);
	await view.onOpen();
	await view.startNew(FREE, undefined, false);
	assert.doesNotMatch(systems[0], /previous reply asked them/);

	await view.send("I like play soccer.");
	const ai = () => [...view.contentEl.querySelectorAll(".el-bubble-ai")] as HTMLElement[];
	const bubble = ai()[1];
	assert.deepEqual([...bubble.querySelectorAll(".el-fix-word")].map((w: any) => w.textContent), ["playing"]);
	const why = bubble.nextElementSibling as HTMLDetailsElement;
	assert.equal(why.tagName, "DETAILS", "說明在 AI 的話下面，而且收起來");
	assert.equal(why.open, false);
	assert.equal(why.querySelector("summary")!.textContent, "📝 為什麼？");
	assert.match(why.textContent!, /like 後面接動詞要加 -ing/);
	assert.match(systems[1], /fix AT MOST ONE thing out loud/);

	await view.send("Yesterday I go park.");
	assert.match(ai()[2].textContent!, /🎤 換你再說一次/);
	assert.deepEqual([...ai()[2].querySelectorAll(".el-fix-word")].map((w: any) => w.textContent), ["went"]);

	await view.send("Yesterday I went to the park.");
	assert.match(systems[3], /The target: "Yesterday I went to the park\." \(the part that was fixed: "went"\)/, "這一則是重說：告訴 AI 要判斷");
	const mine = [...view.contentEl.querySelectorAll(".el-bubble-user")] as HTMLElement[];
	assert.equal(mine[2].querySelector(".el-retry-ok")?.textContent, "✓ 改對了");
	assert.equal(mine[1].querySelector(".el-retry-ok"), null);

	await view.send("We played tag.");
	assert.match(systems[4], /very recently, so do not use style "retry"/, "剛請過就先不要又請他重說");
	assert.doesNotMatch(systems[4], /The target:/);
});

test("糾正方式照這位使用者的設定；開始畫面可以改，改了就存", async () => {
	const { view, systems, prefs } = chat([hi], "recast");
	await view.onOpen();
	const row = view.contentEl.querySelector(".el-fix-mode") as HTMLElement;
	const sel = row.querySelector("select") as HTMLSelectElement;
	assert.deepEqual(
		[...sel.options].map((o) => o.textContent),
		["自動（預設）", "順口帶過就好", "每次都提醒"],
	);
	assert.equal(sel.value, "recast");
	assert.match(row.textContent!, /只在回話時順口用對的說法重說/);
	sel.value = "tip";
	sel.dispatchEvent(new (window as any).Event("change"));
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(prefs, [["kid", "correction", "tip"]]);
	assert.match(row.textContent!, /每個錯都用一句話提醒/);
	await view.startNew(FREE, undefined, false);
	assert.match(systems[0], /Only use "recast"/, "送出時用這位使用者的設定（這個假的設定一直是 recast）");
});
