// 同一個字的不同形態（go / went / going）在生字本合併成一筆。
// 規則刻意保守：
//   1. AI 在加入生字時回報的原形（word-add 的 lemma）
//   2. 不規則變化表
//   3. 字尾規則（-s、-ed、-ing…）只有在「原形也已經在生字本裡」時才合併
// 片語（含空白）不合併。這個檔案不碰 Vault，方便測試。

const IRREGULAR_VERBS: Record<string, string[]> = {
	be: ["am", "is", "are", "was", "were", "been", "being"],
	have: ["has", "had", "having"],
	do: ["does", "did", "done", "doing"],
	go: ["goes", "went", "gone", "going"],
	arise: ["arose", "arisen"],
	awake: ["awoke", "awoken"],
	bear: ["bore", "borne", "born"],
	beat: ["beaten"],
	become: ["became"],
	begin: ["began", "begun", "beginning"],
	bend: ["bent"],
	bet: [],
	bind: ["bound"],
	bite: ["bit", "bitten"],
	bleed: ["bled"],
	blow: ["blew", "blown"],
	break: ["broke", "broken"],
	breed: ["bred"],
	bring: ["brought"],
	build: ["built"],
	burn: ["burnt"],
	buy: ["bought"],
	catch: ["caught"],
	choose: ["chose", "chosen"],
	cling: ["clung"],
	come: ["came", "coming"],
	creep: ["crept"],
	deal: ["dealt"],
	dig: ["dug"],
	draw: ["drew", "drawn"],
	dream: ["dreamt"],
	drink: ["drank", "drunk"],
	drive: ["drove", "driven"],
	eat: ["ate", "eaten"],
	fall: ["fell", "fallen"],
	feed: ["fed"],
	feel: ["felt"],
	fight: ["fought"],
	find: ["found"],
	flee: ["fled"],
	fly: ["flew", "flown", "flies"],
	forbid: ["forbade", "forbidden"],
	forget: ["forgot", "forgotten"],
	forgive: ["forgave", "forgiven"],
	freeze: ["froze", "frozen"],
	get: ["got", "gotten", "getting"],
	give: ["gave", "given"],
	grind: ["ground"],
	grow: ["grew", "grown"],
	hang: ["hung"],
	hear: ["heard"],
	hide: ["hid", "hidden"],
	hold: ["held"],
	keep: ["kept"],
	kneel: ["knelt"],
	know: ["knew", "known"],
	lay: ["laid"],
	lead: ["led"],
	lean: ["leant"],
	leap: ["leapt"],
	learn: ["learnt"],
	leave: ["left"],
	lend: ["lent"],
	lie: ["lay", "lain", "lying"],
	light: ["lit"],
	lose: ["lost"],
	make: ["made"],
	mean: ["meant"],
	meet: ["met"],
	mistake: ["mistook", "mistaken"],
	pay: ["paid"],
	prove: ["proven"],
	ride: ["rode", "ridden"],
	ring: ["rang", "rung"],
	rise: ["rose", "risen"],
	run: ["ran", "running"],
	say: ["said"],
	see: ["saw", "seen"],
	seek: ["sought"],
	sell: ["sold"],
	send: ["sent"],
	shake: ["shook", "shaken"],
	shine: ["shone"],
	shoot: ["shot"],
	show: ["shown"],
	shrink: ["shrank", "shrunk"],
	sing: ["sang", "sung"],
	sink: ["sank", "sunk"],
	sit: ["sat", "sitting"],
	sleep: ["slept"],
	slide: ["slid"],
	speak: ["spoke", "spoken"],
	speed: ["sped"],
	spend: ["spent"],
	spin: ["spun"],
	spit: ["spat"],
	spread: [],
	spring: ["sprang", "sprung"],
	stand: ["stood"],
	steal: ["stole", "stolen"],
	stick: ["stuck"],
	sting: ["stung"],
	stink: ["stank", "stunk"],
	strike: ["struck", "stricken"],
	strive: ["strove", "striven"],
	swear: ["swore", "sworn"],
	sweep: ["swept"],
	swim: ["swam", "swum", "swimming"],
	swing: ["swung"],
	take: ["took", "taken"],
	teach: ["taught"],
	tear: ["tore", "torn"],
	tell: ["told"],
	think: ["thought"],
	throw: ["threw", "thrown"],
	tread: ["trod", "trodden"],
	understand: ["understood"],
	undertake: ["undertook", "undertaken"],
	wake: ["woke", "woken"],
	wear: ["wore", "worn"],
	weave: ["wove", "woven"],
	weep: ["wept"],
	win: ["won", "winning"],
	wind: ["wound"],
	withdraw: ["withdrew", "withdrawn"],
	write: ["wrote", "written"],
	// 不規則複數
	child: ["children"],
	man: ["men"],
	woman: ["women"],
	foot: ["feet"],
	tooth: ["teeth"],
	goose: ["geese"],
	mouse: ["mice"],
	person: ["people"],
	knife: ["knives"],
	wife: ["wives"],
	life: ["lives"],
	leaf: ["leaves"],
	half: ["halves"],
	wolf: ["wolves"],
	shelf: ["shelves"],
	thief: ["thieves"],
	analysis: ["analyses"],
	crisis: ["crises"],
	phenomenon: ["phenomena"],
	criterion: ["criteria"],
	// 不規則比較級
	good: ["better", "best"],
	bad: ["worse", "worst"],
	far: ["farther", "farthest", "further", "furthest"],
};

/** 變化形 → 原形。 */
export const IRREGULAR: Record<string, string> = (() => {
	const m: Record<string, string> = {};
	for (const [base, forms] of Object.entries(IRREGULAR_VERBS)) for (const f of forms) if (!(f in m)) m[f] = base;
	// 同時是原形的常用字：只在原形在生字本時才合併（交給字尾規則以外的檢查）
	return m;
})();

/** 本身就是常用原形、不能被當成變化形的字（例如 left 也是「左邊」、found 也是「建立」）。 */
const AMBIGUOUS = new Set(["left", "found", "lay", "bound", "ground", "wound", "lives", "saw", "lit", "rose", "fell", "felt", "shot", "stuck", "spoke", "ring", "wind", "bear", "born", "means", "best", "better"]);

/** 字尾規則會誤判的字。 */
const NOT_INFLECTED = new Set([
	"news", "this", "his", "is", "was", "has", "yes", "us", "bus", "gas", "plus", "thus", "series", "species", "politics", "physics", "always", "perhaps", "lens", "chaos",
	"seed", "need", "feed", "bleed", "speed", "breed", "weed", "deed", "bed", "red", "shed", "wed", "hundred", "sacred", "naked", "wicked", "beloved", "kindred",
	"thing", "king", "ring", "sing", "bring", "spring", "string", "swing", "sting", "wing", "ceiling", "evening", "morning", "during", "nothing", "something", "anything", "everything", "pudding", "darling", "sibling",
]);

const VOWEL = /[aeiou]/;

/** 依字尾規則可能的原形（不保證是真的字）。 */
export function suffixCandidates(w: string): string[] {
	if (!/^[a-z'-]+$/.test(w) || NOT_INFLECTED.has(w)) return [];
	const out: string[] = [];
	const add = (s: string) => {
		if (s.length >= 2 && s !== w && VOWEL.test(s) && !out.includes(s)) out.push(s);
	};
	const undouble = (s: string) => (s.length >= 3 && s[s.length - 1] === s[s.length - 2] && !/[aeiouslz]/.test(s[s.length - 1]) ? s.slice(0, -1) : "");
	if (w.length > 3 && w.endsWith("'s")) add(w.slice(0, -2));
	if (w.length > 4 && w.endsWith("ies")) add(w.slice(0, -3) + "y");
	if (w.length > 3 && w.endsWith("es")) add(w.slice(0, -2));
	if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) add(w.slice(0, -1));
	if (w.length > 4 && w.endsWith("ied")) add(w.slice(0, -3) + "y");
	if (w.length > 4 && w.endsWith("ed")) {
		const s = w.slice(0, -2);
		add(s);
		add(w.slice(0, -1)); // liked → like
		const u = undouble(s);
		if (u) add(u); // stopped → stop
	}
	if (w.length > 5 && w.endsWith("ing")) {
		const s = w.slice(0, -3);
		add(s);
		add(s + "e"); // making → make
		const u = undouble(s);
		if (u) add(u); // running → run
		if (s.endsWith("y")) add(s.slice(0, -1) + "ie"); // lying → lie
	}
	return out;
}

/** 單一個字是不是像變化形（用來決定要不要請 AI 查原形）。 */
export function looksInflected(key: string): boolean {
	if (key.includes(" ")) return false;
	return key in IRREGULAR || suffixCandidates(key).length > 0;
}

/**
 * 每個 key 對應的合併後 key。
 * @param keys 生字本裡所有的 key（已經過 wordKey 正規化）
 * @param explicit AI 回報的原形（key → lemma key）
 */
export function lemmaMap(keys: Iterable<string>, explicit: Map<string, string> = new Map()): Map<string, string> {
	const set = new Set(keys);
	const direct = (k: string): string => {
		if (k.includes(" ")) return k;
		const e = explicit.get(k);
		if (e && e !== k && !e.includes(" ")) return e;
		const irr = IRREGULAR[k];
		// 有歧義的字（left、found…）只有在原形也在生字本時才合併
		if (irr && (!AMBIGUOUS.has(k) || set.has(irr))) return irr;
		for (const c of suffixCandidates(k)) if (set.has(c)) return c;
		return k;
	};
	const out = new Map<string, string>();
	for (const k of set) {
		let cur = k;
		for (let i = 0; i < 3; i++) {
			const next = direct(cur);
			if (next === cur) break;
			cur = next;
		}
		out.set(k, cur);
	}
	return out;
}

/** 請 AI 查原形（只在字看起來像變化形時呼叫）。查不到就回傳 undefined。 */
export async function aiLemma(ai: { complete(p: string, o?: { system?: string; json?: boolean; maxOutputTokens?: number; temperature?: number }): Promise<{ text: string }> }, word: string, context?: string): Promise<string | undefined> {
	const system = `Return the dictionary base form (lemma) of the English word as used in the sentence: verbs → infinitive (went → go, studying → study), nouns → singular (children → child), adjectives → positive (happier → happy). If it is already a base form, or its meaning as used is a different word (e.g. "left" meaning the direction), return it unchanged.
Return ONLY JSON {"lemma": "<word>"}`;
	const res = await ai.complete(`Word: ${word}${context ? `\nSentence: ${context}` : ""}`, { system, json: true, maxOutputTokens: 64, temperature: 0 });
	try {
		const l = JSON.parse(res.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")).lemma;
		return typeof l === "string" && /^[A-Za-z'-]+$/.test(l.trim()) ? l.trim().toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}
