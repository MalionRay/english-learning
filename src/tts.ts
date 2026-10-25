// 朗讀：使用系統內建語音（Web Speech API），免費、可離線。
// 語音選擇與語速存在 localStorage：每台裝置的可用語音不同，不應同步。
import { App } from "obsidian";

export const LS_TTS_VOICE = "english-learning:tts-voice";
export const LS_TTS_RATE = "english-learning:tts-rate";

function synth(): SpeechSynthesis | null {
	return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

export function ttsAvailable(): boolean {
	return !!synth() && typeof SpeechSynthesisUtterance !== "undefined";
}

/** 取得英文語音。有些平台一開始回傳空陣列，要等 voiceschanged。 */
export function englishVoices(): Promise<SpeechSynthesisVoice[]> {
	const s = synth();
	if (!s) return Promise.resolve([]);
	const pick = () => s.getVoices().filter((v) => v.lang?.toLowerCase().startsWith("en"));
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

export function defaultVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
	const us = voices.filter((v) => /en[-_]us/i.test(v.lang));
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

export async function speak(app: App, text: string, rate?: number): Promise<SpeechSynthesisVoice | undefined> {
	const s = synth();
	if (!s || !ttsAvailable()) throw new Error("這台裝置不支援語音朗讀（speechSynthesis）");
	const t = text.replace(/\s+/g, " ").trim();
	if (!t) return;
	const voices = await englishVoices();
	const name = app.loadLocalStorage(LS_TTS_VOICE);
	const voice = voices.find((v) => v.name === name) ?? defaultVoice(voices);
	s.cancel();
	const u = new SpeechSynthesisUtterance(t);
	u.lang = voice?.lang ?? "en-US";
	if (voice) u.voice = voice;
	u.rate = getRate(app) * (rate ?? 1);
	s.speak(u);
	return voice;
}
