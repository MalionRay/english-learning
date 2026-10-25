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
