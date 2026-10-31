// 學習的語言：英文、西班牙文（拉丁美洲／墨西哥）、日文（從零開始）。
// 分字、正規化、語音語系、AI 提示裡的語言說明都在這裡；這個檔案不碰 Vault，方便測試。
export type Lang = "en" | "es" | "ja";
export const LANGS: Lang[] = ["en", "es", "ja"];

export interface LangSpec {
	code: Lang;
	name: string; // 介面上的名稱
	english: string; // 給 AI 看的語言名稱
	tts: string; // 語音的語系（Google Cloud、系統語音）
	spaced: boolean; // 用空白分字
	sample: string; // 試聽句
}

export const LANG: Record<Lang, LangSpec> = {
	en: { code: "en", name: "英文", english: "English", tts: "en-US", spaced: true, sample: "Hi! This is how I sound." },
	es: { code: "es", name: "西班牙文", english: "Latin American Spanish (as spoken in Mexico)", tts: "es-US", spaced: true, sample: "¡Hola! Así suena mi voz." },
	ja: { code: "ja", name: "日文", english: "Japanese", tts: "ja-JP", spaced: false, sample: "こんにちは。これが私の声です。" },
};

export function langOf(v: unknown): Lang {
	return v === "es" || v === "ja" ? v : "en";
}

/** 生字、句子、聽力的 qid 前綴：英文沒有（相容舊紀錄），其他語言加 "es:"／"ja:"。 */
export function langTag(lang: Lang): string {
	return lang === "en" ? "" : `${lang}:`;
}

// ---------------------------------------------------------------------
// 分字

export interface Token {
	text: string;
	word: boolean; // 可以點的字（不是空白或標點）
}

const LATIN_WORD = /[A-Za-zÀ-ÖØ-öø-ÿ](?:[A-Za-zÀ-ÖØ-öø-ÿ'’-]*[A-Za-zÀ-ÖØ-öø-ÿ])?/g;

type SegmenterCtor = new (locale: string, o: { granularity: "word" }) => { segment(s: string): Iterable<{ segment: string; isWordLike?: boolean }> };

function segmenter(): SegmenterCtor | null {
	const I = (globalThis as { Intl?: { Segmenter?: SegmenterCtor } }).Intl;
	return I?.Segmenter ?? null;
}

const JA_SCRIPT = (ch: string): string => {
	if (/[぀-ゟ]/.test(ch)) return "h"; // 平假名
	if (/[゠-ヿｦ-ﾟー]/.test(ch)) return "k"; // 片假名
	if (/[一-鿿㐀-䶿々〆]/.test(ch)) return "c"; // 漢字
	if (/[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]/.test(ch)) return "l";
	return "p"; // 標點、空白
};

/** 沒有 Intl.Segmenter 時的退路：依文字種類切（漢字後面接的平假名算同一個字）。 */
function jaFallback(text: string): Token[] {
	const out: Token[] = [];
	let cur = "";
	let kind = "";
	const push = () => {
		if (cur) out.push({ text: cur, word: kind !== "p" });
		cur = "";
	};
	for (const ch of text) {
		const k = JA_SCRIPT(ch);
		const join = cur && (k === kind || (kind === "c" && k === "h")) && k !== "p";
		if (!join) {
			push();
			kind = k;
		} else if (kind === "c" && k === "h") kind = "c"; // 送り仮名
		cur += ch;
	}
	push();
	return out;
}

/** 把一段文字切成字與非字（顯示時逐字可點）。 */
export function tokenize(text: string, lang: Lang): Token[] {
	if (lang === "ja") {
		const S = segmenter();
		if (!S) return jaFallback(text);
		const out: Token[] = [];
		for (const s of new S("ja", { granularity: "word" }).segment(text)) out.push({ text: s.segment, word: !!s.isWordLike });
		return out;
	}
	const out: Token[] = [];
	let last = 0;
	const re = new RegExp(LATIN_WORD.source, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const i = m.index;
		if (i > last) out.push({ text: text.slice(last, i), word: false });
		out.push({ text: m[0], word: true });
		last = i + m[0].length;
	}
	if (last < text.length) out.push({ text: text.slice(last), word: false });
	return out;
}

/** 一段文字裡的字（正規化後）。 */
export function wordsOf(text: string, lang: Lang): string[] {
	return tokenize(text, lang)
		.filter((t) => t.word)
		.map((t) => normWord(t.text, lang))
		.filter(Boolean);
}

/** 字數（文章長度、聽力句子長度、對話程度用）。 */
export function countWords(text: string, lang: Lang): number {
	return wordsOf(text, lang).length;
}

/** 去掉重音符號（西班牙文比對用：esta ≈ está）。 */
export function stripAccents(s: string): string {
	return s.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC");
}

/** 字的正規化（生字本的 key）：英文、西班牙文小寫；日文 NFKC、去掉標點。 */
export function normWord(w: string, lang: Lang): string {
	if (lang === "ja")
		return w
			.normalize("NFKC")
			.replace(/[\s、。！？!?「」『』（）()・…〜~,.]/g, "")
			.trim();
	const s = w.normalize("NFC").toLowerCase().replace(/[’‘]/g, "'");
	if (lang === "es") return s.replace(/[^a-záéíóúüñ'\- ]/g, " ").replace(/\s+/g, " ").trim();
	return s.replace(/[^a-z'\- ]/g, " ").replace(/\s+/g, " ").trim();
}

/** 句子的正規化（句子本 key、去重）。 */
export function normSentence(s: string, lang: Lang): string {
	if (lang === "ja") return s.normalize("NFKC").replace(/[\s、。！？!?「」『』（）()・…〜~,.]/g, "");
	const t = s.normalize("NFC").toLowerCase();
	return (lang === "es" ? t.replace(/[^a-z0-9áéíóúüñ' ]/g, " ") : t.replace(/[^a-z0-9' ]/g, " ")).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------
// 日文：假名與羅馬拼音

/** 片假名轉平假名（比對讀音用）。 */
export function toHiragana(s: string): string {
	return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 羅馬拼音比對：小寫、去空白與符號、長音符號換成兩個母音（tōkyō＝toukyou＝tokyo 都算）。 */
export function normRomaji(s: string): string {
	return s
		.toLowerCase()
		.replace(/ā/g, "aa")
		.replace(/ī/g, "ii")
		.replace(/ū/g, "uu")
		.replace(/ē/g, "ee")
		.replace(/ō/g, "ou")
		.replace(/[^a-z]/g, "");
}

/** 長音寫法不同也算對：去掉重複母音、ou→o。 */
function looseRomaji(s: string): string {
	return normRomaji(s).replace(/ou/g, "o").replace(/([aiueo])\1+/g, "$1");
}

/**
 * 打字答案對不對：
 * - 英文：不分大小寫、忽略空白與句尾標點
 * - 西班牙文：同上；只差重音符號也算對（accentOnly 會是 true，畫面提醒正確寫法）
 * - 日文：漢字、平假名、片假名、羅馬拼音都可以（要有讀音或羅馬拼音資料）
 */
export function matchAnswer(typed: string, answer: string, lang: Lang, alt: { reading?: string; romaji?: string } = {}): { ok: boolean; accentOnly?: boolean } {
	const base = (s: string) =>
		s
			.normalize("NFC")
			.toLowerCase()
			.replace(/[’‘]/g, "'")
			.replace(/[“”]/g, '"')
			.replace(/\s+/g, " ")
			.replace(/^[\s"'(¿¡]+|[\s"'.,!?;:)]+$/g, "")
			.trim();
	if (lang === "ja") {
		const t = normWord(typed, "ja");
		if (!t) return { ok: false };
		const cands = [answer, alt.reading ?? ""].map((x) => toHiragana(normWord(x, "ja"))).filter(Boolean);
		if (cands.includes(toHiragana(t))) return { ok: true };
		if (alt.romaji && /^[a-zA-Zāīūēō\s'-]+$/.test(typed.trim())) {
			if (normRomaji(typed) === normRomaji(alt.romaji) || looseRomaji(typed) === looseRomaji(alt.romaji)) return { ok: true };
		}
		return { ok: false };
	}
	const a = base(typed);
	const b = base(answer);
	if (a && a === b) return { ok: true };
	if (lang === "es" && a && stripAccents(a) === stripAccents(b)) return { ok: true, accentOnly: true };
	return { ok: false };
}

// ---------------------------------------------------------------------
// AI 提示裡的語言說明

export function learnerLine(lang: Lang, level: "adult" | "kid"): string {
	if (lang === "es")
		return level === "kid"
			? "The learner is a Taiwanese primary-school child who is a beginner in Spanish (CEFR A1)."
			: "The learner is a Taiwanese adult learning Latin American Spanish, roughly CEFR A2–B1.";
	if (lang === "ja")
		return level === "kid"
			? "The learner is a Taiwanese primary-school child who is a COMPLETE BEGINNER in Japanese (still learning kana). They read Traditional Chinese, so kanji meanings are often guessable, but readings are not."
			: "The learner is a Taiwanese adult who is a COMPLETE BEGINNER in Japanese (absolute beginner, aiming for JLPT N5, still learning kana). They read Traditional Chinese, so kanji meanings are often guessable, but readings are not.";
	return level === "kid"
		? "The learner is a Taiwanese primary-school child (CEFR A1–A2)."
		: "The learner is a Taiwanese adult (CEFR B1–B2).";
}

/** 對話角色。 */
export function persona(lang: Lang, level: "adult" | "kid"): string {
	if (lang === "es")
		return level === "kid"
			? "You are Diego, a cheerful 12-year-old boy from Guadalajara, Mexico, who loves soccer (he is a big Chivas fan), his dog Chispa, video games and his grandma's tamales. Talk like a fun, kind friend, not a teacher. Use Mexican Spanish (tú, not vosotros)."
			: "You are Sofía, a 31-year-old friend from Mexico City who works as a graphic designer, loves tacos al pastor, salsa dancing, Mexican cinema and weekend trips to small towns, and once spent two weeks traveling in Taiwan. Talk like a real friend chatting, not like a teacher. Use natural Mexican Spanish (tú, ustedes; never vosotros) and everyday Mexican vocabulary.";
	if (lang === "ja")
		return level === "kid"
			? "You are Haruto (陽翔), a cheerful 12-year-old boy from Yokohama, Japan, who loves baseball, Pokémon, drawing manga and his cat Kuro. Talk like a kind friend. Use standard Japanese (not a dialect)."
			: "You are Yui (結衣), a 30-year-old friend from Tokyo who works at a café, loves ramen, anime, train trips and onsen, and once visited Taiwan (she loved 小籠包 and night markets). Talk like a kind friend. Use standard Japanese (not a dialect).";
	return level === "kid"
		? "You are Mia, a cheerful 12-year-old girl from Seattle who loves her cat Mochi, drawing, soccer and pancakes. Talk like a fun, kind friend, not a teacher."
		: "You are Alex, a 32-year-old friend from Portland who works as a product designer, loves hiking, coffee, cooking Asian food and sci-fi movies, and once spent a month traveling in Taiwan. Talk like a real friend chatting, not like a teacher or a customer-service bot.";
}

export function personaName(lang: Lang, level: "adult" | "kid"): string {
	return { en: { adult: "Alex", kid: "Mia" }, es: { adult: "Sofía", kid: "Diego" }, ja: { adult: "結衣", kid: "陽翔" } }[lang][level];
}
