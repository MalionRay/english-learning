import { test } from "node:test";
import assert from "node:assert/strict";
import { editRatio, estimateChatLevel, levelPrompt, messageScore } from "../src/chatlevel";
import type { ConvMessage } from "../src/chat";

const ok = '{"correction":null,"howto":[],"reply":"Nice.","replyZh":"不錯。"}';
const fix = (original: string, corrected: string) =>
	JSON.stringify({ correction: { original, corrected, explanation: "說明", zh: "意思" }, howto: [], reply: "OK.", replyZh: "好。" });

function conv(pairs: [string, string][]): ConvMessage[] {
	const out: ConvMessage[] = [];
	for (const [u, m] of pairs) out.push({ role: "user", text: u, ts: "" }, { role: "model", text: m, ts: "" });
	return out;
}

test("editRatio：小錯接近 0，整句重寫接近 1", () => {
	assert.equal(editRatio("I like cats", "I like cats"), 0);
	assert.ok(editRatio("I go to the park yesterday with my dog", "I went to the park yesterday with my dog") < 0.15);
	assert.ok(editRatio("me want buy thing", "I would like to buy something") > 0.6);
});

test("messageScore：中文、被大改、小錯、沒錯、太短", () => {
	assert.equal(messageScore("我想去廁所英文怎麼說", ok), 0.15);
	assert.ok(messageScore("me want buy thing", fix("me want buy thing", "I would like to buy something")) < 0.3);
	assert.equal(messageScore("I go to the park yesterday with my dog", fix("I go to the park yesterday with my dog", "I went to the park yesterday with my dog")), 0.75);
	assert.equal(messageScore("I went hiking with my sister last weekend", ok), 1);
	assert.equal(messageScore("Yes", ok), 0.6);
	assert.ok(messageScore("I want to eat 滷肉飯 tonight", ok) <= 0.5);
});

test("沒有紀錄：成人從「日常」、小孩從「簡單」開始", () => {
	assert.equal(estimateChatLevel([], "adult").level, 3);
	assert.equal(estimateChatLevel([], "kid").level, 2);
});

test("一直答得亂 → 降到最簡單；一直沒錯而且句子夠長 → 升到最自然；小孩最多到 4", () => {
	const bad = conv(Array.from({ length: 8 }, () => ["me no understand what you say", fix("me no understand what you say", "I don't understand what you're saying")] as [string, string]));
	assert.equal(estimateChatLevel(bad, "adult").level, 1);
	const good = conv(Array.from({ length: 8 }, () => ["We spent the whole afternoon cooking dumplings with my grandma", ok] as [string, string]));
	assert.equal(estimateChatLevel(good, "adult").level, 5);
	assert.equal(estimateChatLevel(good, "kid").level, 4);
});

test("慢慢變：一兩句不會跳很多級；最近的句子比較重", () => {
	const good = ["We spent the whole afternoon cooking dumplings with my grandma", ok] as [string, string];
	const bad = ["me no understand what you say", fix("me no understand what you say", "I don't understand what you're saying")] as [string, string];
	assert.ok(estimateChatLevel(conv([good]), "adult").level <= 4);
	// 前面都錯、最近都對：比前面都對、最近都錯高
	const improving = estimateChatLevel(conv([bad, bad, bad, bad, good, good, good, good]), "adult");
	const worsening = estimateChatLevel(conv([good, good, good, good, bad, bad, bad, bad]), "adult");
	assert.ok(improving.fluency > worsening.fluency);
});

test("只回很短的句子：最多到「日常」；還沒有 AI 回覆的訊息不算", () => {
	const short = conv(Array.from({ length: 8 }, () => ["Yes, I do", ok] as [string, string]));
	assert.ok(estimateChatLevel(short, "adult").level <= 3);
	const pending: ConvMessage[] = [{ role: "user", text: "我不知道怎麼說", ts: "" }];
	assert.equal(estimateChatLevel(pending, "adult").samples, 0);
});

test("levelPrompt：說明程度、強調自然不等於困難", () => {
	const p1 = levelPrompt({ level: 1, fluency: 0.1, samples: 5, avgWords: 4 }, "adult");
	assert.match(p1, /very short, simple sentences/);
	const p5 = levelPrompt({ level: 5, fluency: 0.95, samples: 8, avgWords: 10 }, "adult");
	assert.match(p5, /native-speaker friend/);
	assert.match(p5, /never pick rare words/);
	assert.match(levelPrompt({ level: 2, fluency: 0.3, samples: 3, avgWords: 5 }, "kid"), /of 4 .*\n.*child/);
});
