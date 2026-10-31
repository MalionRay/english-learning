// 合成的題庫（不使用任何真實文章內容）
import type { Bank, Question } from "../../src/generate";

export function sampleQuestions(): Question[] {
	return [
		{ id: "v1", type: "vocab", direction: "en2zh", word: "harbor", ipa: "/ˈhɑrbər/", context: "The boat stayed in the harbor all winter.", contextZh: "那艘船整個冬天都停在港口。", prompt: "harbor", options: ["港口", "森林", "沙漠", "山谷"], answer: 0, explanation: "harbor 港口", marked: true },
		{ id: "v2", type: "vocab", direction: "en2zh", word: "gentle", context: "She spoke in a gentle voice to the puppy.", prompt: "gentle", options: ["溫柔的", "吵鬧的", "生氣的", "快速的"], answer: 0, explanation: "gentle 溫柔的" },
		{ id: "c1", type: "cloze", prompt: "Tom ____ the window because the room was hot.", promptZh: "湯姆打開窗戶，因為房間很熱。", options: ["opened", "ate", "sang", "drew"], optionsZh: ["打開", "吃", "唱", "畫"], answer: 0, explanation: "open the window" },
		{ id: "r1", type: "reading", prompt: "Why did Tom open the window?", promptZh: "湯姆為什麼開窗？", options: ["It was hot", "It was raining", "He was hungry", "He was sleepy"], answer: 0, explanation: "房間很熱" },
		{ id: "t1", type: "translate", prompt: "船停在港口。", reference: "The boat is in the harbor.", explanation: "harbor" },
	] as Question[];
}

export function sampleBank(over: Partial<Bank> = {}): Bank {
	return { version: 1, sourceId: "b1", sourcePath: "english/sources/Story.md", title: "Story", level: "adult", model: "m", generatedAt: "2026-01-01T00:00:00Z", device: "win-00000001", questions: sampleQuestions(), ...over };
}

/** 西班牙文的合成題庫（自己編的句子）。 */
export function spanishBank(over: Partial<Bank> = {}): Bank {
	return {
		version: 1,
		sourceId: "es1",
		sourcePath: "english/sources/Mercado.md",
		title: "Mercado",
		level: "adult",
		lang: "es",
		model: "m",
		generatedAt: "2026-01-02T00:00:00Z",
		device: "win-00000001",
		questions: [
			{ id: "es-v1", type: "vocab", direction: "en2zh", word: "mercado", context: "Mi abuela va al mercado los sábados.", contextZh: "我奶奶每週六去市場。", prompt: "mercado", options: ["市場", "學校", "醫院", "公園"], answer: 0, explanation: "mercado 市場", marked: true },
			{ id: "es-c1", type: "cloze", prompt: "Ella ____ muy cansada después del viaje.", promptZh: "旅行之後她非常累。", options: ["está", "es", "son", "tiene"], optionsZh: ["是（狀態）", "是（本質）", "是（複數）", "有"], answer: 0, explanation: "estar 表示狀態" },
			{ id: "es-t1", type: "translate", prompt: "我想買兩個芒果。", reference: "Quiero comprar dos mangos.", explanation: "querer + 原形動詞" },
		],
		...over,
	} as Bank;
}

/** 日文的合成題庫（自己編的句子）。 */
export function japaneseBank(over: Partial<Bank> = {}): Bank {
	return {
		version: 1,
		sourceId: "ja1",
		sourcePath: "english/sources/Tenki.md",
		title: "Tenki",
		level: "adult",
		lang: "ja",
		model: "m",
		generatedAt: "2026-01-03T00:00:00Z",
		device: "win-00000001",
		questions: [
			{ id: "ja-v1", type: "vocab", direction: "en2zh", word: "天気", reading: "てんき", romaji: "tenki", context: "今日はとても天気がいいです。", contextZh: "今天天氣非常好。", prompt: "天気", options: ["天氣", "電車", "朋友", "早餐"], answer: 0, explanation: "天気（てんき）天氣", marked: true },
			{ id: "ja-c1", type: "cloze", prompt: "毎朝、公園を____。", promptZh: "每天早上在公園散步。", options: ["散歩します", "食べます", "書きます", "読みます"], answer: 0, answerReading: "さんぽします", answerRomaji: "sanpo shimasu", explanation: "散歩（さんぽ）" },
			{ id: "ja-t1", type: "translate", prompt: "我喜歡貓。", reference: "私は猫が好きです。", explanation: "〜が好きです" },
		],
		...over,
	} as Bank;
}
