import { test } from "node:test";
import assert from "node:assert/strict";
import { DAY, computeStates, newIntroducedToday, pickSession } from "../src/srs";

const t0 = Date.parse("2026-01-01T10:00:00Z");
let n = 0;
const A = (qid: string, d: number, correct: boolean | undefined, extra: Record<string, unknown> = {}) =>
	({ id: "a" + n++, ts: new Date(t0 + d * DAY).toISOString(), device: "d", user: "u", type: "answer", qid, bank: "b", qtype: "vocab", session: "s", correct, ...extra }) as any;
const day = (ms: number) => Math.round(((ms - t0) / DAY) * 100) / 100;

test("答對沿階梯拉長、答錯回到隔天", () => {
	const st = computeStates([A("q", 0, true), A("q", 1, true), A("q", 4, true), A("w", 0, true), A("w", 1, false)]);
	assert.equal(st.get("q")!.step, 3);
	assert.equal(day(st.get("q")!.due), 10.83);
	assert.equal(st.get("w")!.step, 0);
	assert.equal(day(st.get("w")!.due), 1.83);
});

test("同場重答、提示答對、生字階梯", () => {
	const st = computeStates([A("a", 0, false), A("a", 0.01, true, { relearn: true }), A("h", 0, true), A("h", 1, true, { hint: true }), A("m", 0, true, { marked: true }), A("m", 1, true, { marked: true })]);
	assert.equal(st.get("a")!.step, 0);
	assert.equal(st.get("a")!.lastCorrect, false);
	assert.equal(st.get("h")!.step, 1);
	assert.equal(day(st.get("h")!.due), 1.83);
	assert.equal(day(st.get("m")!.due), 2.83);
});

test("翻譯題待批改、之後由 grade 決定；UUID 去重；亂序重播", () => {
	const p = A("t", 0, undefined, { pending: true });
	const dup = A("x", 0, true);
	const st = computeStates([{ id: "g", ts: new Date(t0 + 0.5 * DAY).toISOString(), type: "grade", answerId: p.id, qid: "t", score: 90, correct: true } as any, p, dup, { ...dup }, A("o", 3, false), A("o", 2, true)].reverse());
	assert.equal(st.get("t")!.step, 1);
	assert.equal(st.get("x")!.seen, 1);
	assert.equal(st.get("o")!.step, 0);
});

test("出題：答錯優先、新題受每日上限限制", () => {
	const st = computeStates([A("ok", 0, true), A("bad", 0, false)]);
	const qs = ["ok", "bad", "n1", "n2", "n3"].map((id) => ({ id }));
	const p = pickSession(qs, st, 10, t0 + 2 * DAY, 2);
	assert.deepEqual(p.due.map((q) => q.id), ["bad", "ok"]);
	assert.equal(p.fresh.length, 2);
	assert.equal(p.freshTotal, 3);
});

test("今天新練的題數", () => {
	const now = Date.now();
	const iso = (ms: number) => new Date(ms).toISOString();
	const logs = [
		{ id: "1", type: "answer", qid: "a", ts: iso(now) },
		{ id: "2", type: "answer", qid: "b", ts: iso(now - 3 * DAY) },
		{ id: "3", type: "answer", qid: "b", ts: iso(now) },
		{ id: "4", type: "answer", qid: "c", ts: iso(now), relearn: true },
		{ id: "5", type: "answer", qid: "z", ts: iso(now) },
	];
	assert.equal(newIntroducedToday(logs, new Set(["a", "b", "c"]), now), 1);
});
