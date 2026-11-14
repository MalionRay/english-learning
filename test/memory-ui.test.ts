// v0.23.0：跨對話記憶在對話畫面上的行為——結束時整理、開新對話時帶著、開始畫面看和刪、可以關掉
import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatView } from "../src/chatview";
import { MemEvent, MemoryManager } from "../src/memory";
import { convBlock, convHeader } from "../src/chat";
import { makeApp } from "./helpers/app";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(5);
const J = (o: object) => JSON.stringify(o);
const FREE = { id: "free", label: "自由聊天", prompt: "Free chat." };
const hi = { correction: null, howto: [], reply: "Hi! What did you do today?", replyZh: "嗨" };
const ago = (days: number) => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
const say = (r: string) => J({ correction: null, howto: [], reply: r, replyZh: "" });
let seq = 0;
const mem = (o: Partial<MemEvent>): string => J({ id: `m${seq++}`, ts: ago(2), device: "win-1", user: "ray", type: "mem", ...o }) + "\n";
const note = (key: string, text: string, at = ago(2)) => ({ key, text, at });

interface Opts {
	replies?: object[];
	summaries?: (object | string | Error)[];
	files?: [string, string][];
	remember?: Record<string, boolean>;
	delayMs?: number;
}

/** 假外掛＋真的 MemoryManager：對話的 AI 和整理記憶的 AI 分開記錄。 */
function setup(o: Opts = {}) {
	const { app, files } = makeApp(new Map<string, string>([["logs/ray/ipad-1.jsonl", ""], ...(o.files ?? [])]));
	const replies = o.replies ?? [hi];
	const queue = [...(o.summaries ?? [])];
	const systems: string[] = []; // 每次對話請求的系統提示
	const summaries: { prompt: string; system: string }[] = []; // 每次整理記憶的請求
	const synced: number[] = [];
	const remember: Record<string, boolean> = { ...(o.remember ?? {}) };
	let n = 0;
	let e = 0;
	const plugin: any = {
		app,
		user: "ray",
		lang: "en",
		deviceId: "ipad-1",
		settings: { users: ["ray", "kid"] },
		userNames: () => ["ray", "kid"],
		chatMemoryOf: () => 50,
		levelOf: (u: string) => (u === "kid" ? "kid" : "adult"),
		getApiKey: () => "k",
		fastBackend() {
			return this.backend();
		},
		backend: () => ({
			chat: async (_t: unknown[], opts: { system: string }) => {
				systems.push(opts.system);
				return { text: J(replies[Math.min(n++, replies.length - 1)]), usage: {}, model: "m" };
			},
			complete: async (prompt: string, opts: { system?: string }) => {
				if (!String(opts?.system ?? "").startsWith("You keep the memory notes")) return { text: '{"zh":[]}', usage: {}, model: "m" };
				summaries.push({ prompt, system: String(opts.system) });
				if (o.delayMs) await sleep(o.delayMs);
				const r = queue.shift() ?? { add: [] };
				if (r instanceof Error) throw r;
				return { text: typeof r === "string" ? r : J(r), usage: {}, model: "m" };
			},
		}),
		makeEntry(type: string, extra: Record<string, unknown> = {}, user?: string) {
			return { id: "e" + e++, ts: new Date().toISOString(), device: "ipad-1", user: user ?? this.user, type, ...extra };
		},
		appendLog: async (x: any) => {
			const path = `logs/${x.user}/ipad-1.jsonl`;
			files.set(path, String(files.get(path) ?? "") + J(x) + "\n");
		},
		appendText: async (f: any, s: string) => void files.set(f.path, String(files.get(f.path) ?? "") + s),
		addPhrase: async () => undefined,
		addWord: async () => undefined,
		say: () => undefined,
		triggerSync: () => void synced.push(Date.now()),
		debug: () => undefined,
		remembers: (u: string) => remember[u] !== false,
		setRemember: async (u: string, on: boolean) => {
			if (on) await plugin.memory.markSince(u);
			remember[u] = on;
		},
		appendMemory: async (x: MemEvent) => {
			const path = `english/memory/${x.user}/ipad-1.jsonl`;
			files.set(path, String(files.get(path) ?? "") + J(x) + "\n");
		},
		flushWrites: async () => undefined,
	};
	plugin.memory = new MemoryManager(plugin);
	app.saveLocalStorage("english-learning:chat-voice", "off");
	const view: any = new ChatView({ app } as any, plugin);
	const convs = () => [...files.keys()].filter((k) => k.startsWith("conversations/"));
	const events = (u = "ray") =>
		String(files.get(`english/memory/${u}/ipad-1.jsonl`) ?? "")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as MemEvent);
	const box = () => view.contentEl.querySelector(".el-memory") as HTMLElement;
	const summary = () => box().querySelector("summary")?.textContent ?? "";
	const notes = () => [...box().querySelectorAll(".el-mem-text")].map((x) => x.textContent as string);
	const toggle = () => box().querySelector('input[type="checkbox"]') as HTMLInputElement;
	const settle = async () => {
		await plugin.memory.settle(2000);
		await tick();
	};
	return { view, plugin, app, files, systems, summaries, synced, remember, convs, events, box, summary, notes, toggle, settle };
}

test("結束對話後把重點整理成記憶；開始畫面看得到；下一次開新對話 AI 就帶著這些記憶", async () => {
	const x = setup({ summaries: [{ add: ["12 月要去東京玩 5 天", "養了一隻貓叫 Mochi"], update: [], remove: [] }] });
	await x.view.onOpen();
	await tick();
	assert.equal(x.toggle().checked, true, "預設是開的");
	assert.match(x.box().textContent ?? "", /讓 Alex 記得以前聊過的事/);
	assert.equal(x.summary(), "🧠 Alex 記得的事（0）");
	assert.match(x.box().textContent ?? "", /還沒有。聊完按「結束對話」/);

	await x.view.startNew(FREE, undefined, false);
	assert.ok(!x.systems[0].includes("What you remember"), "還沒有記憶：系統提示不多加東西");
	await x.view.send("I will go to Tokyo next month for five days.");
	await x.view.send("My cat Mochi will stay with my sister.");
	const path = x.convs()[0];
	await x.view.end();
	assert.equal(x.synced.length, 0, "等記憶整理完再同步，對話和記憶一起上傳");
	await x.settle();

	assert.equal(x.summaries.length, 1);
	assert.match(x.summaries[0].system, /^You keep the memory notes of Alex/);
	assert.match(x.summaries[0].prompt, /Existing notes:\n\(none yet\)/);
	assert.match(x.summaries[0].prompt, /Alex: Hi! What did you do today\?\nLearner: I will go to Tokyo next month for five days\.\nAlex: .*\nLearner: My cat Mochi will stay with my sister\./);
	const ev = x.events();
	assert.equal(ev.length, 1);
	assert.deepEqual({ conv: ev[0].conv, count: ev[0].count, by: ev[0].by, lang: ev[0].lang }, { conv: path, count: 5, by: "ai", lang: undefined });
	assert.equal(x.synced.length, 1);

	// 開始畫面：整理完自動更新
	assert.equal(x.summary(), "🧠 Alex 記得的事（2）");
	assert.deepEqual(x.notes().sort(), ["12 月要去東京玩 5 天", "養了一隻貓叫 Mochi"]);
	assert.match(x.box().textContent ?? "", /這是英文對話的記憶（每種語言各記各的），最多 20 條/);

	// 下一次對話：從開場就帶著
	await x.view.startNew(FREE, undefined, false);
	const sys = x.systems[x.systems.length - 1];
	assert.match(sys, /What you remember about this learner from your earlier conversations/);
	assert.match(sys, /\) 12 月要去東京玩 5 天/);
	assert.match(sys, /\) 養了一隻貓叫 Mochi/);
	assert.match(sys, /Keep speaking English; never switch to Chinese/);
	await x.view.send("Hello again!");
	assert.ok(x.systems[x.systems.length - 1].includes("養了一隻貓叫 Mochi"), "聊天中每一次都帶著");
	// 只聊了一句就結束：不值得整理，不問 AI
	await x.view.end();
	await x.settle();
	assert.equal(x.summaries.length, 1);
	assert.equal(x.synced.length, 2);
});

test("每種語言各記各的：英文的記憶不會出現在西班牙文對話，西班牙文聊的記在西班牙文", async () => {
	const x = setup({
		files: [["english/memory/ray/win-1.jsonl", mem({ add: [note("k1", "12 月要去東京玩 5 天")] })]],
		summaries: [{ add: ["喜歡吃墨西哥捲餅"], update: [], remove: [] }],
	});
	x.plugin.lang = "es";
	await x.view.onOpen();
	await tick();
	assert.equal(x.summary(), "🧠 Sofía 記得的事（0）");
	await x.view.startNew(FREE, undefined, false);
	assert.ok(!x.systems[0].includes("What you remember"));
	assert.ok(!x.systems[0].includes("東京"));
	await x.view.send("Me gustan mucho los tacos.");
	await x.view.send("Los como cada semana.");
	await x.view.end();
	await x.settle();
	assert.match(x.summaries[0].system, /^You keep the memory notes of Sofía/);
	assert.match(x.summaries[0].prompt, /Existing notes:\n\(none yet\)/, "英文的記憶不交給西班牙文的整理");
	assert.equal(x.events()[0].lang, "es");
	assert.deepEqual(x.notes(), ["喜歡吃墨西哥捲餅"]);
	assert.match(x.box().textContent ?? "", /這是西班牙文對話的記憶/);

	// 回到英文：Alex 只知道英文那邊聊過的
	x.plugin.lang = "en";
	x.view.render();
	await tick();
	assert.equal(x.summary(), "🧠 Alex 記得的事（1）");
	assert.deepEqual(x.notes(), ["12 月要去東京玩 5 天"]);
	await x.view.startNew(FREE, undefined, false);
	const sys = x.systems[x.systems.length - 1];
	assert.ok(sys.includes("12 月要去東京玩 5 天"));
	assert.ok(!sys.includes("墨西哥捲餅"));
});

test("每個帳號各記各的；練到一半在別的地方換了使用者，記憶還是記在這場對話的人身上", async () => {
	const x = setup({
		files: [["english/memory/kid/win-1.jsonl", mem({ user: "kid", add: [note("kk", "喜歡恐龍")] })]],
		summaries: [{ add: ["週末常去爬山"], update: [], remove: [] }],
	});
	await x.view.onOpen();
	await x.view.startNew(FREE, undefined, false);
	assert.ok(!x.systems[0].includes("恐龍"), "kid 的記憶不會給 ray 的對話");
	await x.view.send("I go hiking every weekend.");
	x.plugin.user = "kid"; // 在別的分頁換了使用者
	await x.view.send("Last week I climbed a small mountain.");
	await x.view.end();
	await x.settle();
	assert.equal(x.events("ray").length, 1);
	assert.equal(x.events("ray")[0].add![0].text, "週末常去爬山");
	assert.equal(x.events("kid").length, 0);
	// 現在畫面是 kid 的開始畫面
	assert.equal(x.summary(), "🧠 Mia 記得的事（1）");
	assert.deepEqual(x.notes(), ["喜歡恐龍"]);
});

test("關掉：不整理、聊天也不帶記憶；以前記的還看得到、可以刪；開關按下去會存", async () => {
	const x = setup({
		remember: { ray: false },
		files: [["english/memory/ray/win-1.jsonl", mem({ add: [note("k1", "12 月要去東京玩 5 天"), note("k2", "在工廠當工程師", ago(9))] })]],
	});
	await x.view.onOpen();
	await tick();
	assert.equal(x.toggle().checked, false);
	assert.equal(x.summary(), "🧠 Alex 記得的事（2）");
	assert.match(x.box().textContent ?? "", /已關閉：不會再記新的，聊天時也不會用到/);
	await x.view.startNew(FREE, undefined, false);
	assert.ok(!x.systems[0].includes("What you remember"));
	await x.view.send("I am going to Tokyo.");
	await x.view.send("I will stay five days.");
	await x.view.end();
	await x.settle();
	assert.equal(x.summaries.length, 0, "關掉了就不請 AI 整理");
	assert.equal(x.synced.length, 1, "照常同步");
	assert.equal(x.events().length, 0);

	// 打開：寫一筆「從現在開始」，剛剛那個關掉時聊的對話不會被補整理
	x.toggle().checked = true;
	x.toggle().dispatchEvent(new (window as any).Event("change"));
	await tick();
	assert.equal(x.remember.ray, true);
	assert.equal(x.toggle().checked, true);
	assert.equal(typeof x.events()[0].since, "string");
	x.view.render();
	await x.settle();
	assert.equal(x.summaries.length, 0);
	// 再關掉
	x.toggle().checked = false;
	x.toggle().dispatchEvent(new (window as any).Event("change"));
	await tick();
	assert.equal(x.remember.ray, false);
});

test("開始畫面：一條一條刪；全部忘記要按兩次", async () => {
	const x = setup({
		files: [["english/memory/ray/win-1.jsonl", mem({ add: [note("k1", "12 月要去東京玩 5 天", ago(1)), note("k2", "在工廠當工程師", ago(5)), note("k3", "常把 since 和 for 用錯", ago(9))] })]],
	});
	await x.view.onOpen();
	await tick();
	assert.deepEqual(x.notes(), ["12 月要去東京玩 5 天", "在工廠當工程師", "常把 since 和 for 用錯"], "最新的在前面");
	const del = [...x.box().querySelectorAll(".el-mem-item button")] as HTMLButtonElement[];
	assert.equal(del[1].getAttribute("aria-label"), "忘記這一條");
	del[1].click();
	await tick();
	assert.deepEqual(x.notes(), ["12 月要去東京玩 5 天", "常把 since 和 for 用錯"]);
	assert.deepEqual({ remove: x.events()[0].remove, by: x.events()[0].by }, { remove: ["k2"], by: "user" });
	assert.equal(x.summary(), "🧠 Alex 記得的事（2）");

	const all = () => [...x.box().querySelectorAll("button")].find((b) => /全部忘記|確定忘記/.test(b.textContent ?? "")) as HTMLButtonElement;
	all().click();
	await tick();
	assert.equal(all().textContent, "確定忘記這 2 條？再按一次");
	assert.equal(x.notes().length, 2, "按一次還不會刪");
	all().click();
	await tick();
	assert.deepEqual(x.notes(), []);
	assert.equal(x.summary(), "🧠 Alex 記得的事（0）");
	assert.deepEqual(x.events()[1].remove?.sort(), ["k1", "k3"]);
	// 刪掉的不會再交給 AI
	await x.view.startNew(FREE, undefined, false);
	assert.ok(!x.systems[0].includes("What you remember"));
});

const leftOpen = (o: { started: string; device?: string; user?: string; lines?: string[] }) =>
	convHeader({ user: o.user ?? "ray", level: "adult", topic: "free", topicLabel: "自由聊天", device: o.device ?? "ipad-1", started: o.started }) +
	[
		convBlock({ role: "model", text: say("Hey! Any plans for the weekend?"), ts: o.started }),
		...(o.lines ?? ["I will visit my grandmother in Tainan.", "She will be ninety years old."]).flatMap((t) => [
			convBlock({ role: "user", text: t, ts: o.started }),
			convBlock({ role: "model", text: say("That sounds lovely!"), ts: o.started }),
		]),
	].join("");

test("沒按「結束對話」就離開：下次打開對話的開始畫面時補整理", async () => {
	const x = setup({
		delayMs: 30,
		files: [
			["conversations/2026-11-01-ipad-1-1.md", leftOpen({ started: ago(1) })],
			["conversations/2026-11-01-ipad-1-2.md", leftOpen({ started: ago(1), user: "kid" })],
		],
		summaries: [{ add: ["週末要去台南看 90 歲的阿嬤"], update: [], remove: [] }],
	});
	// 檔名的日期要在最近 30 天內：換成今天的日期
	const today = new Date();
	const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
	for (const k of [...x.files.keys()].filter((k) => k.startsWith("conversations/"))) {
		x.files.set(k.replace("2026-11-01", day), x.files.get(k)!);
		x.files.delete(k);
	}
	await x.view.onOpen();
	await tick();
	assert.equal(x.summary(), "🧠 Alex 記得的事（0）・整理中…");
	await x.settle();
	assert.equal(x.summaries.length, 1, "只整理 ray 的英文對話，kid 的不會記到 ray 身上");
	assert.match(x.summaries[0].prompt, /Learner: I will visit my grandmother in Tainan\./);
	assert.equal(x.summary(), "🧠 Alex 記得的事（1）");
	assert.deepEqual(x.notes(), ["週末要去台南看 90 歲的阿嬤"]);
	assert.equal(x.events()[0].conv, `conversations/${day}-ipad-1-1.md`);
	// 畫面重畫（同步、換設定都會）不會再整理一次
	x.view.render();
	await x.settle();
	assert.equal(x.summaries.length, 1);
});

test("續聊之後再結束：只把新聊的部分交給 AI 整理；續聊時也帶著記憶", async () => {
	const path = "conversations/2026-11-10-ipad-1-1.md";
	const x = setup({
		files: [
			[path, leftOpen({ started: ago(3) })],
			["english/memory/ray/ipad-1.jsonl", mem({ device: "ipad-1", conv: path, count: 5, add: [note("k1", "週末要去台南看 90 歲的阿嬤")], by: "ai" })],
		],
		summaries: [{ add: [], update: [{ id: "m1", text: "去台南幫阿嬤過了 90 歲生日" }], remove: [] }],
	});
	await x.view.onOpen();
	const f = x.app.vault.getAbstractFileByPath(path);
	await x.view.resume(f, x.app.metadataCache.getFileCache(f).frontmatter, false);
	await x.view.send("I am back from Tainan. The party was great.");
	assert.ok(x.systems[0].includes("週末要去台南看 90 歲的阿嬤"));
	await x.view.send("We ate a big cake together.");
	await x.view.end();
	await x.settle();
	assert.equal(x.summaries.length, 1);
	const p = x.summaries[0].prompt;
	assert.match(p, /Existing notes:\nm1 \(\d{4}-\d\d-\d\d\) 週末要去台南看 90 歲的阿嬤/);
	assert.match(p, /\(The earlier part of this conversation was already processed; only the new part is below\.\)\nLearner: I am back from Tainan\. The party was great\./);
	assert.ok(!p.includes("I will visit my grandmother"), "整理過的部分不再送");
	const last = x.events().pop()!;
	assert.deepEqual({ conv: last.conv, count: last.count, remove: last.remove }, { conv: path, count: 9, remove: ["k1"] });
	assert.deepEqual(x.notes(), ["去台南幫阿嬤過了 90 歲生日"]);
});

test("上一個對話還在整理就開新對話：先等它整理完（最多 8 秒），這次開場就用得上", async () => {
	const x = setup({ delayMs: 60, summaries: [{ add: ["下週要考多益"], update: [], remove: [] }] });
	await x.view.onOpen();
	await x.view.startNew(FREE, undefined, false);
	await x.view.send("I have a TOEIC test next week.");
	await x.view.send("I am a little nervous.");
	await x.view.end();
	assert.equal(x.plugin.memory.busy, true);
	const before = x.systems.length;
	await x.view.startNew(FREE, undefined, false); // 整理還沒好就按開始
	assert.equal(x.systems.length, before + 1);
	assert.ok(x.systems[before].includes("下週要考多益"), "等到了，開場的系統提示已經有剛整理好的記憶");
	assert.equal(x.view.contentEl.querySelectorAll(".el-chat-typing").length, 0, "「整理上次聊天的重點…」的提示拿掉了");
});

test("整理失敗（AI 回的不是 JSON）：對話照常結束、照常同步，記憶不變", async () => {
	const x = setup({
		files: [["english/memory/ray/win-1.jsonl", mem({ add: [note("k1", "在工廠當工程師")] })]],
		summaries: ["Sorry, I cannot do that."],
	});
	await x.view.onOpen();
	await x.view.startNew(FREE, undefined, false);
	await x.view.send("I changed my job last week.");
	await x.view.send("Now I work in a bank.");
	await x.view.end();
	await x.settle();
	assert.equal(x.summaries.length, 1);
	assert.equal(x.events().length, 0);
	assert.equal(x.synced.length, 1);
	assert.deepEqual(x.notes(), ["在工廠當工程師"]);
	assert.equal(x.summary(), "🧠 Alex 記得的事（1）", "「整理中…」不會卡著");
});

test("開始畫面選的情境、複習開關一改就存：畫面因為同步或整理記憶重畫時不會跳回去", async () => {
	const x = setup();
	await x.view.onOpen();
	await tick();
	const sel = x.view.contentEl.querySelector("select.dropdown:not(.el-lang-select)") as HTMLSelectElement;
	const topic = [...x.view.contentEl.querySelectorAll("select")].find((s: any) => [...s.options].some((op: any) => op.value === "travel")) as HTMLSelectElement;
	assert.ok(sel && topic);
	topic.value = "travel";
	topic.dispatchEvent(new (window as any).Event("change"));
	x.view.render(); // 例如同步觸發的重畫
	await tick();
	const again = [...x.view.contentEl.querySelectorAll("select")].find((s: any) => [...s.options].some((op: any) => op.value === "travel")) as HTMLSelectElement;
	assert.equal(again.value, "travel");
	assert.deepEqual(x.app.loadLocalStorage("english-learning:chat")?.ray?.topic, "travel");
});
