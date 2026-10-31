// 朗讀：使用系統內建語音（Web Speech API），免費、可離線。
// 語音選擇與語速存在 localStorage：每台裝置的可用語音不同，不應同步。
import { App } from "obsidian";
import { LANG, Lang } from "./lang";

export const LS_TTS_VOICE = "english-learning:tts-voice";
export const LS_TTS_RATE = "english-learning:tts-rate";

function synth(): SpeechSynthesis | null {
	return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

export function ttsAvailable(): boolean {
	return !!synth() && typeof SpeechSynthesisUtterance !== "undefined";
}

/** 這台裝置記住的語音（每種語言分開；英文沿用舊的 key）。 */
function voiceKey(lang: Lang): string {
	return lang === "en" ? LS_TTS_VOICE : `${LS_TTS_VOICE}:${lang}`;
}

/** 取得英文語音。有些平台一開始回傳空陣列，要等 voiceschanged。 */
export function englishVoices(): Promise<SpeechSynthesisVoice[]> {
	return voicesFor("en");
}

/** 取得某種語言的系統語音。 */
export function voicesFor(lang: Lang): Promise<SpeechSynthesisVoice[]> {
	const s = synth();
	if (!s) return Promise.resolve([]);
	const pick = () => s.getVoices().filter((v) => v.lang?.toLowerCase().startsWith(lang));
	const now = pick();
	if (now.length) return Promise.resolve(now);
	return new Promise((resolve) => {
		const done = () => {
			s.removeEventListener("voiceschanged", done);
			resolve(pick());
		};
		s.addEventListener("voiceschanged", done);
		setTimeout(done, 1500);
	});
}

const PREFERRED = [/samantha/i, /aria/i, /jenny/i, /natural/i, /google us english/i, /zira/i, /alex/i, /ava/i];

/** 語音品質：iOS／macOS 的 Premium（高品質）> Enhanced（優化）> 一般。 */
export function voiceQuality(v: Pick<SpeechSynthesisVoice, "name" | "voiceURI">): number {
	const id = `${v.voiceURI ?? ""} ${v.name ?? ""}`;
	if (/premium|高品質/i.test(id)) return 2;
	if (/enhanced|優化|增強/i.test(id)) return 1;
	return 0;
}

/** 偏好的地區：英文美式、西班牙文墨西哥／美國、日文日本。 */
function localeRe(lang: Lang): RegExp {
	return lang === "es" ? /es[-_](mx|us|419)/i : lang === "ja" ? /ja/i : /en[-_]us/i;
}

export function defaultVoice(voices: SpeechSynthesisVoice[], lang: Lang = "en"): SpeechSynthesisVoice | undefined {
	const local = voices.filter((v) => localeRe(lang).test(v.lang));
	const all = local.length ? local : voices;
	// 有下載高品質語音就優先用
	const best = Math.max(0, ...all.map(voiceQuality));
	const us = all.filter((v) => voiceQuality(v) === best);
	if (lang === "en")
		for (const re of PREFERRED) {
			const v = us.find((x) => re.test(x.name));
			if (v) return v;
		}
	return us.find((v) => v.localService) ?? us[0] ?? voices[0];
}

export function getRate(app: App): number {
	const r = Number(app.loadLocalStorage(LS_TTS_RATE));
	return r >= 0.5 && r <= 1.5 ? r : 0.9;
}

export async function speak(app: App, text: string, rate?: number, lang: Lang = "en"): Promise<SpeechSynthesisVoice | undefined> {
	const s = synth();
	if (!s || !ttsAvailable()) throw new Error("這台裝置不支援語音朗讀（speechSynthesis）");
	const t = text.replace(/\s+/g, " ").trim();
	if (!t) return;
	const voices = await voicesFor(lang);
	const name = app.loadLocalStorage(voiceKey(lang));
	const voice = voices.find((v) => v.name === name) ?? defaultVoice(voices, lang);
	s.cancel();
	const u = new SpeechSynthesisUtterance(t);
	u.lang = voice?.lang ?? LANG[lang].tts;
	if (voice) u.voice = voice;
	u.rate = getRate(app) * (rate ?? 1);
	s.speak(u);
	return voice;
}

/** iOS：第一次朗讀必須在點擊事件裡。在點擊時先唸一段無聲的內容，之後（AI 回覆後）才能自動朗讀。 */
export function primeSpeech() {
	const s = synth();
	if (!s || !ttsAvailable()) return;
	try {
		const u = new SpeechSynthesisUtterance(" ");
		u.volume = 0;
		s.speak(u);
	} catch {
		/* 不支援就算了 */
	}
}

export function stopSpeaking() {
	try {
		synth()?.cancel();
	} catch {
		/* ignore */
	}
}

/** 選單上顯示的名稱：標出高品質語音，美式英文排前面。 */
export function voiceLabel(v: Pick<SpeechSynthesisVoice, "name" | "voiceURI" | "lang">): string {
	const q = voiceQuality(v);
	return `${v.name}（${v.lang}${q === 2 ? "，高品質" : q === 1 ? "，優化" : ""}）`;
}

export function sortVoices(voices: SpeechSynthesisVoice[], lang: Lang = "en"): SpeechSynthesisVoice[] {
	const us = (v: SpeechSynthesisVoice) => (localeRe(lang).test(v.lang) ? 1 : 0);
	return [...voices].sort((a, b) => voiceQuality(b) - voiceQuality(a) || us(b) - us(a) || a.name.localeCompare(b.name));
}

/** 下拉選單：選系統語音（存在這台裝置、每種語言分開），選了就用該語音試唸。 */
export function voicePicker(app: App, parent: HTMLElement, sample?: string, lang: Lang = "en"): void {
	const sel = parent.createEl("select", { cls: "dropdown" });
	const text = sample ?? LANG[lang].sample;
	voicesFor(lang).then((voices) => {
		const def = defaultVoice(voices, lang);
		sel.createEl("option", { text: `自動${def ? `（${def.name}）` : ""}`, value: "" });
		for (const v of sortVoices(voices, lang)) sel.createEl("option", { text: voiceLabel(v), value: v.name });
		const cur = app.loadLocalStorage(voiceKey(lang));
		sel.value = typeof cur === "string" && voices.some((v) => v.name === cur) ? cur : "";
		if (!voices.length) sel.createEl("option", { text: `（找不到${LANG[lang].name}語音）`, value: "" });
	});
	sel.onchange = () => {
		app.saveLocalStorage(voiceKey(lang), sel.value || null);
		speak(app, text, undefined, lang).catch(() => undefined);
	};
}
