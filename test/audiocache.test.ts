import { test } from "node:test";
import assert from "node:assert/strict";
import { prefetchAudio } from "../src/audiocache";

test("預先產生錄音：遇到每分鐘上限會等一下再試，每日額度用完就停", async () => {
	const seq = ["gemini", "busy", "busy", "gemini", "quota", "gemini"];
	const asked: string[] = [];
	const pron: any = { has: () => false, ensure: async (t: string) => (asked.push(t), seq.shift()) };
	const texts = ["a", "b", "c", "d"].map((text) => ({ text, qids: [] }));
	const r = await prefetchAudio(pron, texts, undefined, undefined, 1);
	assert.deepEqual(asked, ["a", "b", "b", "b", "c"]);
	assert.equal(r.made, 2);
	assert.equal(r.stoppedByQuota, true);
});
