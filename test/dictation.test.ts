import { test } from "node:test";
import assert from "node:assert/strict";
import { diffWords, dictationItems, tokens } from "../src/dictation";
import { sampleBank } from "./helpers/fixtures";

test("聽力句子來源與長度", () => {
	const b = sampleBank();
	const items = dictationItems(b.questions.map((q) => ({ q, bank: b })));
	assert.ok(items.every((i) => i.id.startsWith("listen:")));
	assert.ok(items.some((i) => i.text === "Tom opened the window because the room was hot."));
});

test("逐字比對寬鬆規則", () => {
	assert.deepEqual(tokens("It’s a well-known “city”."), ["its", "a", "well", "known", "city"]);
	assert.equal(diffWords("It's the most high-profile case.", "its the most high profile case").score, 1);
	const r = diffWords("He planned to leave.", "he plan to leave now");
	assert.ok(r.score < 0.9);
	assert.ok(r.parts.some((p) => p.kind === "wrong" && p.typed === "plan"));
});
