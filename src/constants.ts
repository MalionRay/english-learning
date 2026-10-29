// 共用常數與設定型別
export const VERIFY_VIEW = "english-learning-verify";
export const HOME_VIEW = "english-learning-home";

// 以下都存在 localStorage（app.saveLocalStorage），不在 Vault 檔案裡，不會被同步
export const LS_DEVICE_ID = "english-learning:device-id";
export const LS_USER = "english-learning:user";
export const LS_FALLBACK_KEY = "english-learning:fallback-api-key"; // 僅在沒有 SecretStorage 時使用

export const REMOTELY_SAVE_SYNC = "remotely-save:start-sync";

/** data.json 只放非機密設定。不得放 API key 或裝置 ID。 */
export interface Settings {
	users: string[];
	backend: "gemini";
	geminiModel: string;
	fastModel: string; // 對話、批改、翻譯這類要即時回應的呼叫（空白＝跟 geminiModel 一樣）
	apiKeySecretName: string; // SecretStorage 裡的 secret 名稱，不是金鑰本身
	syncAfterGenerate: boolean;
	// 發音
	dictAudio: boolean; // 單字先用字典真人錄音
	geminiTts: boolean; // 再用 Gemini 語音
	ttsModel: string;
	ttsVoice: string;
	ttsDailyCap: number; // 每台裝置每天最多產生幾段 Gemini 語音
	prefetchAudio: boolean; // 出題後預先產生錄音
	prefetchGemini: boolean; // 預先產生時也用 Gemini 語音（免費版每天只有 10 段，預設只用字典真人錄音）
	newPerDay: number; // 每種題型每天最多幾題新題（0＝不限）
}

export const DEFAULTS: Settings = {
	users: ["ray", "kid"],
	backend: "gemini",
	geminiModel: "gemini-3.5-flash-lite",
	// iPad 實測（2026-10-29）：3.5-flash-lite 的對話大小請求常要 20～37 秒，3.1-flash-lite 約 1.6 秒
	fastModel: "gemini-3.1-flash-lite",
	apiKeySecretName: "",
	syncAfterGenerate: true,
	dictAudio: true,
	geminiTts: true,
	ttsModel: "gemini-3.8-flash-lite-tts",
	ttsVoice: "Kore",
	ttsDailyCap: 10, // Gemini 語音免費版：每天 10 段（2026-10-29 實測 429 訊息）
	prefetchAudio: true,
	prefetchGemini: false,
	newPerDay: 10,
};
