// 英文對話：提示詞、回覆格式、對話檔、句子本。這個檔案不碰 Vault（除了型別），方便測試。
import type { ChatTurn } from "./ai";
import type { ChoiceQ, Level, Question, TranslateQ } from "./generate";
import { fillBlank } from "./generate";
import { audioKey } from "./pronounce";
import { LANG, Lang, langOf, learnerLine, normSentence, persona } from "./lang";

export const CONV_DIR = "conversations";
export const PHRASE_PREFIX = "phrase:";

export interface Correction {
	original: string;
	corrected: string;
	explanation: string; // 繁中
	zh: string; // 學習者想表達的意思（繁中）——之後當句子練習的題目
	reading?: string; // 日文：修正句的平假名
	romaji?: string;
}

export interface HowTo {
	zh: string;
	en: string; // 外語說法（欄位名稱沿用英文版）
	alt?: string;
	note?: string; // 繁中：語氣、場合
	reading?: string; // 日文：平假名
	romaji?: string;
}

export interface ChatReply {
	correction: Correction | null;
	howto: HowTo[];
	reply: string;
	replyZh: string;
	replyReading?: string; // 日文：回覆的平假名
	replyRomaji?: string; // 日文：回覆的羅馬拼音
}

export interface Topic {
	id: string;
	label: string;
	prompt: string; // 給 AI 的情境說明
}

export const TOPICS: Topic[] = [
	{ id: "free", label: "自由聊天", prompt: "Free conversation about anything the learner likes. Start by asking how their day is going." },
	{ id: "article", label: "聊一篇文章", prompt: "Discuss the article below with the learner: ask what they think, ask about details, and invite their opinion." },
	{ id: "daily", label: "日常生活", prompt: "Everyday life: family, hobbies, weekend plans, food, weather." },
	{ id: "travel", label: "旅行", prompt: "Travel situations: airport, hotel check-in, asking for directions, sightseeing." },
	{ id: "restaurant", label: "餐廳點餐", prompt: "Role-play: you are a friendly waiter at a restaurant and the learner is a customer." },
	{ id: "work", label: "工作與面試", prompt: "Work situations: meetings, small talk with colleagues, or a job interview where you are the interviewer." },
	{ id: "school", label: "學校（小孩）", prompt: "School life for a child: classes, friends, teachers, lunch, after-school activities." },
];

export function chatSystemPrompt(level: Level, topic: Topic, article?: string, lang: Lang = "en"): string {
	if (lang !== "en") return foreignChatPrompt(level, topic, article, lang);
	const learner =
		level === "kid"
			? "The learner is a Taiwanese primary-school child (CEFR A1–A2). Use very simple, short English sentences, be warm and encouraging. Only correct errors that change the meaning or are basic grammar (e.g. verb tense, subject-verb agreement)."
			: "The learner is a Taiwanese adult (CEFR B1–B2). Speak naturally but clearly. Correct grammar mistakes, wrong word choices and clearly unnatural phrasing. Ignore capitalization, punctuation and tiny typos.";
	return `${persona("en", level)}
${learner}
Scenario: ${topic.prompt}
(If the scenario gives you a role, such as a waiter or an interviewer, play that role with the same natural personality.)

How to talk (this matters a lot — the learner said your replies felt robotic):
- React to the specific details the learner just said; show real interest, curiosity or humor.
- Sometimes share a short opinion, story or experience of your own, then pass the turn back.
- Do NOT open with generic praise ("That's great!", "That's awesome!", "Sounds fun!") and do not echo their sentence back. Vary how you start.
- Use everyday spoken English with contractions and natural fillers when they fit ("Oh nice", "Honestly", "Wait, really?"). Avoid formal or textbook phrasing.
- Ask at most ONE question per reply, and not every reply has to end with a question.
- Keep it short like a chat message: usually 1–3 sentences.

Every learner message may be in English, in Chinese, or English mixed with Chinese words.
For EVERY learner message, return ONLY a JSON object:
{
 "correction": null | {"original": "<the learner's sentence(s) that need fixing>", "corrected": "<natural, correct English for what they meant>", "explanation": "<繁體中文（台灣用語）1–2 句：錯在哪、為什麼>", "zh": "<繁體中文：學習者想表達的意思>"},
 "howto": [ {"zh": "<繁中 phrase the learner asked about or wrote in Chinese>", "en": "<natural English way to say it>", "alt": "<optional second way>", "note": "<繁中：比較口語或正式、使用場合>"} ],
 "reply": "<your natural spoken-English reply, following 'How to talk'>",
 "replyZh": "<繁體中文翻譯 of reply>"
}

Rules:
- correction: only when the learner wrote English with a real mistake. If their English is correct, use null. If they wrote Chinese words inside an English sentence, set "corrected" to the full English sentence AND add each Chinese part to "howto".
- howto: when the learner writes in Chinese (for example 「我要去一下廁所英文該怎麼說」 or just a Chinese sentence), teach 1–2 natural ways to say it in "howto", and in "reply" briefly encourage them to try using it. Otherwise use [].
- Never put corrections or teaching inside "reply"; "reply" is only your natural conversational turn.
- All Chinese must be Traditional Chinese as used in Taiwan.${article ? `\n\n<article>\n${article}\n</article>` : ""}`;
}

/** 西班牙文、日文的對話提示：和英文版同樣的格式，日文多了讀音欄位。 */
function foreignChatPrompt(level: Level, topic: Topic, article: string | undefined, lang: Lang): string {
	const T = LANG[lang].english;
	const W = lang === "ja" ? "Japanese" : "Spanish";
	const correct =
		level === "kid"
			? "Be warm and encouraging. Only correct errors that change the meaning or are basic grammar."
			: lang === "ja"
				? "Correct grammar mistakes (particles, verb forms, word order) and wrong word choices, but keep explanations simple — they are a beginner."
				: "Correct grammar mistakes (verb conjugation, gender and number agreement, ser/estar, prepositions), wrong word choices and clearly unnatural phrasing. Ignore capitalization, punctuation, missing ¿¡ and missing accent marks.";
	const jaInput =
		lang === "ja"
			? `\nThe learner is a beginner: they may write Japanese in kana, kanji or ROMAJI (Latin letters, e.g. "watashi wa gakusei desu"). Romaji is fine — never correct a message just for being in romaji; judge the Japanese it represents. In "corrected", write proper Japanese script.\nSpeak simple, polite Japanese (です／ます form) and use mostly very common words; prefer hiragana for words beginners would not know in kanji.`
			: "";
	const jaFields = lang === "ja" ? `,\n "replyReading": "<the whole reply in hiragana (no kanji)>",\n "replyRomaji": "<the whole reply in Hepburn romaji>"` : "";
	const jaCorr = lang === "ja" ? `, "reading": "<corrected in hiragana>", "romaji": "<corrected in romaji>"` : "";
	const jaHow = lang === "ja" ? `, "reading": "<hiragana>", "romaji": "<romaji>"` : "";
	return `${persona(lang, level)}
${learnerLine(lang, level)} ${correct}${jaInput}
Scenario: ${topic.prompt}
(Talk in ${T}. If the scenario gives you a role, such as a waiter or an interviewer, play that role with the same natural personality.)

How to talk (this matters a lot):
- React to the specific details the learner just said; show real interest, curiosity or humor.
- Sometimes share a short opinion, story or experience of your own, then pass the turn back.
- Do NOT open with generic praise and do not echo their sentence back. Vary how you start.
- ${lang === "ja" ? "Use natural spoken Japanese, the way a friendly person talks to a beginner (polite です／ます is fine); avoid stiff written phrasing." : "Use everyday spoken Spanish; avoid formal or textbook phrasing."}
- Ask at most ONE question per reply, and not every reply has to end with a question.
- Keep it short like a chat message: usually 1–3 sentences.

Every learner message may be in ${W}, in Chinese, or ${W} mixed with Chinese words.
For EVERY learner message, return ONLY a JSON object:
{
 "correction": null | {"original": "<the learner's sentence(s) that need fixing>", "corrected": "<natural, correct ${W} for what they meant>", "explanation": "<繁體中文（台灣用語）1–2 句：錯在哪、為什麼>", "zh": "<繁體中文：學習者想表達的意思>"${jaCorr}},
 "howto": [ {"zh": "<繁中 phrase the learner asked about or wrote in Chinese>", "en": "<natural ${W} way to say it>", "alt": "<optional second way>", "note": "<繁中：語氣、使用場合>"${jaHow}} ],
 "reply": "<your natural spoken-${W} reply, following 'How to talk'>",
 "replyZh": "<繁體中文翻譯 of reply>"${jaFields}
}

Rules:
- correction: only when the learner wrote ${W} with a real mistake. If their ${W} is correct, use null. If they wrote Chinese words inside a ${W} sentence, set "corrected" to the full ${W} sentence AND add each Chinese part to "howto".
- howto: when the learner writes in Chinese (for example 「我要去一下廁所${LANG[lang].name}該怎麼說」 or just a Chinese sentence), teach 1–2 natural ways to say it in "howto" (the field is named "en" but must contain ${W}), and in "reply" briefly encourage them to try using it. Otherwise use [].
- Never put corrections or teaching inside "reply"; "reply" is only your natural conversational turn.
- All Chinese must be Traditional Chinese as used in Taiwan.${article ? `\n\n<article>\n${article}\n</article>` : ""}`;
}

/** 語音訊息：和錄音一起送出的指示。AI 要先逐字聽寫到 "heard"，再照平常的方式回覆。 */
export const VOICE_TURN = `(The learner's message is the attached audio recording.
First write exactly what they said into "heard": verbatim, keeping their grammar mistakes and word choices (do NOT correct them there); write any Chinese they spoke in Traditional Chinese characters; if a word is unclear, choose the most likely word from context — do not treat accent or pronunciation as a grammar mistake.
Then reply to "heard" exactly as you would to a typed message, using the same JSON plus the "heard" field. If the audio has no speech, set "heard" to "" and reply asking them to say it again.)`;

export function voiceTurn(lang: Lang): string {
	if (lang === "en") return VOICE_TURN;
	return VOICE_TURN.replace("write any Chinese they spoke in Traditional Chinese characters;", `write ${lang === "ja" ? "Japanese in normal Japanese script (kanji and kana)" : "Spanish with correct accents"} and any Chinese they spoke in Traditional Chinese characters;`);
}

/** 語音訊息時 AI 聽到的內容。 */
export function parseHeard(text: string): string | null {
	try {
		const h = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")).heard;
		return typeof h === "string" ? h.trim() : null;
	} catch {
		return null;
	}
}

/** 第一輪：請 AI 開場（不是學習者說的話）。 */
export const OPENING = "(The learner has just opened the chat. Greet them and start the conversation according to the scenario. Use correction null and howto [].)";

function str(v: unknown): string {
	return typeof v === "string" ? v.trim() : "";
}

/** 從不完整的 JSON 文字裡取出某個字串欄位（取不到回傳空字串；字串本身沒寫完也盡量取）。 */
export function salvageField(text: string, field: string): string {
	const m = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)("?)`).exec(text);
	if (!m) return "";
	const body = m[2] ? m[1] : m[1].replace(/\\[^"\\/bfnrtu]?$|\\u[0-9a-fA-F]{0,3}$/, ""); // 沒寫完：去掉尾巴半個跳脫字元
	try {
		return String(JSON.parse(`"${body}"`)).trim();
	} catch {
		return body.replace(/\\n/g, " ").replace(/\\(.)/g, "$1").trim();
	}
}

export function parseReply(text: string): ChatReply {
	let j: Record<string, unknown>;
	const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	try {
		j = JSON.parse(cleaned);
	} catch {
		// 看起來是 JSON 但不完整（回覆被截斷）：把 "reply" 救出來，不要把一堆大括號顯示給學習者
		if (/^\s*\{/.test(cleaned)) return { correction: null, howto: [], reply: salvageField(cleaned, "reply"), replyZh: salvageField(cleaned, "replyZh") };
		// 模型偶爾直接回純文字：當作一般回覆
		return { correction: null, howto: [], reply: text.trim(), replyZh: "" };
	}
	if (!j || typeof j !== "object" || Array.isArray(j)) return { correction: null, howto: [], reply: typeof j === "string" ? (j as string).trim() : "", replyZh: "" };
	const c = j.correction as Record<string, unknown> | null | undefined;
	const correction: Correction | null =
		c && str(c.corrected) && str(c.original) && str(c.corrected).toLowerCase() !== str(c.original).toLowerCase()
			? { original: str(c.original), corrected: str(c.corrected), explanation: str(c.explanation), zh: str(c.zh) }
			: null;
	if (correction && c) {
		if (str(c.reading)) correction.reading = str(c.reading);
		if (str(c.romaji)) correction.romaji = str(c.romaji);
	}
	const howto = (Array.isArray(j.howto) ? j.howto : [])
		.map((h: Record<string, unknown>) => {
			const o: HowTo = { zh: str(h?.zh), en: str(h?.en), alt: str(h?.alt) || undefined, note: str(h?.note) || undefined };
			if (str(h?.reading)) o.reading = str(h?.reading);
			if (str(h?.romaji)) o.romaji = str(h?.romaji);
			return o;
		})
		.filter((h) => h.zh && h.en);
	const out: ChatReply = { correction, howto, reply: str(j.reply), replyZh: str(j.replyZh) };
	if (str(j.replyReading)) out.replyReading = str(j.replyReading);
	if (str(j.replyRomaji)) out.replyRomaji = str(j.replyRomaji);
	return out;
}

// ---------------------------------------------------------------------
// 對話檔：Markdown（給人看）＋每則訊息一個 HTML 註解（給程式讀，續聊時重建歷史）

export interface ConvMeta {
	user: string;
	level: Level;
	lang?: Lang; // 沒有＝英文
	topic: string;
	topicLabel: string;
	article?: string; // 文章路徑
	device: string;
	started: string;
}

export interface ConvMessage {
	role: "user" | "model";
	text: string; // user：原文（語音訊息是 AI 聽到的內容）；model：AI 回傳的原始 JSON
	ts: string;
	voice?: boolean; // 用麥克風說的
}

/**
 * frontmatter 裡的使用者名字：像數字或 true／null 的名字（例如 "2026"、"no"）要加引號，
 * 不然 YAML 會讀成數字或布林，之後就對不上這位使用者。
 */
export function yamlName(name: string): string {
	return /^[a-z_][a-z0-9_-]*$/i.test(name) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(name) ? name : JSON.stringify(name);
}

export function convHeader(m: ConvMeta): string {
	return [
		"---",
		`user: ${yamlName(m.user)}`,
		`level: ${m.level}`,
		...(m.lang && m.lang !== "en" ? [`lang: ${m.lang}`] : []),
		`topic: ${m.topic}`,
		`topicLabel: ${JSON.stringify(m.topicLabel)}`,
		...(m.article ? [`article: ${JSON.stringify(m.article)}`] : []),
		`device: ${m.device}`,
		`started: ${m.started}`,
		"---",
		"",
		`# ${LANG[langOf(m.lang)].name}對話：${m.topicLabel}`,
		"",
	].join("\n");
}

/**
 * 讀對話檔開頭的 frontmatter（convHeader 寫的格式）。不靠 Obsidian 的索引：
 * 剛同步下來的檔可能還沒進索引，整理記憶時要直接從檔案內容讀。
 */
export function parseConvMeta(md: string): ConvMeta | null {
	const fm = md.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
	if (!fm) return null;
	const o: Record<string, string> = {};
	for (const line of fm[1].split("\n")) {
		const m = line.match(/^([A-Za-z]+):\s*(.*)$/);
		if (!m) continue;
		let v = m[2].trim();
		if (/^".*"$/.test(v)) {
			try {
				v = String(JSON.parse(v));
			} catch {
				v = v.slice(1, -1);
			}
		} else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
		o[m[1]] = v;
	}
	if (!o.user) return null;
	return {
		user: o.user,
		level: o.level === "kid" ? "kid" : "adult",
		lang: langOf(o.lang),
		topic: o.topic || "free",
		topicLabel: o.topicLabel || o.topic || "",
		...(o.article ? { article: o.article } : {}),
		device: o.device || "",
		started: o.started || "",
	};
}

const MSG_RE = /<!--el-msg (.*?) -->/g;

function encodeMsg(m: ConvMessage): string {
	// JSON 裡的 "--" 會提早結束 HTML 註解，先轉義
	return `<!--el-msg ${JSON.stringify(m).replace(/--/g, "-\\u002d")} -->`;
}

/** 一則訊息的 Markdown（append 到對話檔）。 */
export function convBlock(m: ConvMessage): string {
	const lines: string[] = [encodeMsg(m)];
	if (m.role === "user") {
		lines.push(`**You${m.voice ? " 🎤" : ""}:** ${m.text}`, "");
	} else {
		const r = parseReply(m.text);
		if (r.correction)
			lines.push(`> [!warning] 修正`, `> ${r.correction.original} → **${r.correction.corrected}**`, ...(r.correction.romaji ? [`> ${r.correction.reading ?? ""}（${r.correction.romaji}）`] : []), `> ${r.correction.explanation}`, "");
		for (const h of r.howto)
			lines.push(`> [!tip] 怎麼說：${h.zh}`, `> **${h.en}**${h.alt ? `／${h.alt}` : ""}`, ...(h.romaji ? [`> ${h.reading ?? ""}（${h.romaji}）`] : []), ...(h.note ? [`> ${h.note}`] : []), "");
		lines.push(`**AI:** ${r.reply}`, ...(r.replyRomaji ? [`${r.replyReading ?? ""}（${r.replyRomaji}）`] : []), ...(r.replyZh ? [`*${r.replyZh}*`] : []), "");
	}
	return lines.join("\n") + "\n";
}

export function parseConvMessages(md: string): ConvMessage[] {
	const out: ConvMessage[] = [];
	let m: RegExpExecArray | null;
	MSG_RE.lastIndex = 0;
	while ((m = MSG_RE.exec(md))) {
		try {
			out.push(JSON.parse(m[1]));
		} catch {
			/* 壞的略過 */
		}
	}
	return out;
}

/** 送給 AI 的歷史：開場指令 + 最近 N 則（N＝使用者的「對話記憶長度」；0＝整段對話）。 */
export function historyTurns(messages: ConvMessage[], max = 50): ChatTurn[] {
	// 空的訊息（以前 AI 沒回內容時留下的）不送：空白的內容會讓整個請求被拒絕
	const usable = messages.filter((m) => typeof m?.text === "string" && m.text.trim());
	const recent = max > 0 ? usable.slice(-max) : usable;
	const turns: ChatTurn[] = [];
	for (const m of recent) {
		// Gemini 要求 user/model 交替：合併連續同角色
		const last = turns[turns.length - 1];
		if (last && last.role === m.role) last.text += `\n${m.text}`;
		else turns.push({ role: m.role, text: m.text });
	}
	// 第一則必須是 user：還沒有訊息、或這段歷史從 AI 的訊息開始時，前面補上開場指令。
	// 從學習者的訊息開始就不用補（之前會把開場指令和那則訊息黏在一起，AI 可能又打一次招呼）
	if (!turns.length || turns[0].role === "model") turns.unshift({ role: "user", text: OPENING });
	return turns;
}

// ---------------------------------------------------------------------
// 句子本（每位使用者一本）：被糾正的句子、問「怎麼說」的句子

export interface PhraseLog {
	id: string;
	ts: string;
	device: string;
	user: string;
	type: "phrase-add" | "phrase-remove";
	key: string;
	zh?: string;
	en?: string;
	alt?: string;
	note?: string;
	source?: PhraseSource;
	original?: string;
	conv?: string;
	lang?: Lang; // 沒有＝英文
}

export interface PhraseItem {
	key: string;
	zh: string;
	en: string;
	alt?: string;
	note?: string;
	source: PhraseSource;
	original?: string;
	addedAt: string;
	bank?: string; // 題庫來的句子：來源題庫
	lang: Lang;
}

/** 句子本的來源：對話糾正、問怎麼說、錯誤分析練習句、答錯的克漏字／翻譯／聽力。 */
export type PhraseSource = "correction" | "howto" | "pattern" | "cloze" | "translate" | "listening";

export const PHRASE_SOURCE_LABEL: Record<PhraseSource, string> = {
	correction: "被糾正",
	howto: "問過怎麼說",
	pattern: "常見錯誤練習",
	cloze: "克漏字答錯",
	translate: "翻譯答錯",
	listening: "聽力沒聽懂",
};

/** 題目答錯時可以變成句子練習的句子（qid → 句子）。 */
export interface FailedSentence {
	en: string;
	zh: string; // 可能是空的（舊題庫沒有翻譯），練習時再即時翻譯
	note?: string;
	source: "cloze" | "translate" | "listening";
	bank: string;
	lang: Lang;
}

/** 從題目與聽力句子建立「答錯就進句子本」的對照表。 */
export function failedSentenceMap(
	items: { q: Question; bank: { sourceId: string; lang?: Lang } }[],
	listening: { id: string; text: string; zh?: string; bank: string; lang?: Lang }[] = [],
): Map<string, FailedSentence> {
	const m = new Map<string, FailedSentence>();
	for (const { q, bank } of items) {
		if (q.type === "cloze") {
			const c = q as ChoiceQ;
			const ans = c.options[c.answer];
			if (!ans || !c.prompt.includes("____")) continue;
			m.set(q.id, { en: fillBlank(c.prompt, ans).replace(/\s+/g, " ").trim(), zh: c.promptZh ?? "", note: c.explanation, source: "cloze", bank: bank.sourceId, lang: langOf(bank.lang) });
		} else if (q.type === "translate") {
			const t = q as TranslateQ;
			if (t.reference && t.prompt) m.set(q.id, { en: t.reference, zh: t.prompt, note: t.explanation, source: "translate", bank: bank.sourceId, lang: langOf(bank.lang) });
		}
	}
	for (const d of listening) m.set(d.id, { en: d.text, zh: d.zh ?? "", source: "listening", bank: d.bank, lang: langOf(d.lang) });
	return m;
}

export function phraseKey(en: string, lang: Lang = "en"): string {
	if (lang !== "en") return audioKey(normSentence(en, lang), lang);
	return audioKey(en.toLowerCase().replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim());
}

export function phraseQid(key: string): string {
	return PHRASE_PREFIX + key;
}

/**
 * 句子本：phrase-add／phrase-remove，加上答錯（或按「我不知道」）的克漏字、翻譯、聽力句子。
 * 依時間重播：移除後如果又答錯，會再出現。
 */
export function buildPhraseBook(logs: { type: string; ts: string; id: string }[], failed: Map<string, FailedSentence> = new Map(), lang: Lang = "en"): PhraseItem[] {
	const seen = new Set<string>();
	type Ev = PhraseLog | { type: "answer" | "grade"; id: string; ts: string; qid: string; correct?: boolean; relearn?: boolean };
	const list = (logs as Ev[])
		.filter((e) => e.id && !seen.has(e.id) && !!seen.add(e.id))
		.filter(
			(e) =>
				((e.type === "phrase-add" || e.type === "phrase-remove") && langOf((e as PhraseLog).lang) === lang) ||
				((e.type === "answer" || e.type === "grade") && e.correct === false && !("relearn" in e && e.relearn) && failed.get(e.qid)?.lang === lang),
		)
		.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const items = new Map<string, PhraseItem>();
	for (const e of list) {
		if (e.type === "phrase-remove") items.delete(e.key);
		else if (e.type === "phrase-add") {
			if (e.zh && e.en)
				items.set(e.key, { key: e.key, zh: e.zh, en: e.en, alt: e.alt, note: e.note, source: e.source ?? "howto", original: e.original, addedAt: items.get(e.key)?.addedAt ?? e.ts, lang });
		} else {
			const f = failed.get((e as { qid: string }).qid)!;
			const key = phraseKey(f.en, lang);
			if (!items.has(key)) items.set(key, { key, zh: f.zh, en: f.en, note: f.note, source: f.source, addedAt: e.ts, bank: f.bank, lang });
		}
	}
	return [...items.values()].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
}
