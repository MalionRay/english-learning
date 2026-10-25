// 拍照匯入：把書本或講義的照片縮小後交給 Gemini 辨識文字。
// 照片不存進 Vault（只用來辨識），辨識結果填進匯入視窗讓使用者確認。
import type { AIBackend, InlineImage } from "./ai";

export const MAX_EDGE = 1600; // 長邊上限（px）：字還看得清楚，上傳又不會太大
const JPEG_QUALITY = 0.85;

export interface OcrResult {
	title: string;
	text: string;
	marked: string[]; // 照片上用螢光筆、底線或圈起來的字
}

const SYSTEM = `You transcribe English reading material from a photo (a book page, worksheet or handout) for a language learner.
- Copy the main English text exactly as printed. Do not translate, summarize or correct it.
- Join words hyphenated across line breaks, and join lines that belong to the same paragraph. Separate paragraphs with one blank line.
- Leave out page numbers, running headers/footers, and exercise instructions that are not part of the reading text. Leave out Chinese text.
- If the page has a heading, put it in "title" (otherwise "").
- If some words or phrases are highlighted, underlined or circled by hand, list them in "marked" exactly as printed (otherwise []).
- If there is no readable English text, return empty "text".
Return ONLY JSON: {"title": "...", "text": "...", "marked": ["..."]}`;

export function parseOcr(raw: string): OcrResult {
	let j: Record<string, unknown>;
	try {
		j = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
	} catch {
		// 模型偶爾直接回純文字
		return { title: "", text: raw.trim(), marked: [] };
	}
	const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
	const marked = (Array.isArray(j.marked) ? j.marked : []).map(str).filter((w) => w && w.length <= 60);
	return {
		title: str(j.title),
		text: str(j.text).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n"),
		marked: [...new Set(marked)],
	};
}

export async function ocrImage(ai: AIBackend, image: InlineImage): Promise<OcrResult> {
	const res = await ai.complete("Transcribe the English text in this photo.", { system: SYSTEM, json: true, images: [image], maxOutputTokens: 8192, temperature: 0 });
	if (res.finishReason === "SAFETY") throw new Error("這張照片無法辨識");
	return parseOcr(res.text);
}

/** 把多張照片的結果接起來（頁與頁之間空一行）。 */
export function mergeOcr(results: OcrResult[]): OcrResult {
	return {
		title: results.find((r) => r.title)?.title ?? "",
		text: results.map((r) => r.text).filter(Boolean).join("\n\n"),
		marked: [...new Set(([] as string[]).concat(...results.map((r) => r.marked)))],
	};
}

/** 等比縮小：長邊不超過 max。 */
export function fitSize(w: number, h: number, max = MAX_EDGE): { w: number; h: number } {
	const s = Math.min(1, max / Math.max(w, h));
	return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

function readAsDataUrl(file: Blob): Promise<string> {
	return new Promise((ok, fail) => {
		const r = new FileReader();
		r.onload = () => ok(String(r.result));
		r.onerror = () => fail(r.error ?? new Error("讀不到照片"));
		r.readAsDataURL(file);
	});
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((ok, fail) => {
		const img = new Image();
		img.onload = () => ok(img);
		img.onerror = () => fail(new Error("無法開啟這張照片"));
		img.src = src;
	});
}

/** 照片 → 縮小後的 JPEG（base64）。縮小失敗時直接送原圖。 */
export async function imageForAI(file: Blob): Promise<InlineImage> {
	const dataUrl = await readAsDataUrl(file);
	try {
		const img = await loadImage(dataUrl);
		const { w, h } = fitSize(img.naturalWidth || img.width, img.naturalHeight || img.height);
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no canvas");
		ctx.fillStyle = "#fff"; // 透明背景（PNG 截圖）轉成白底
		ctx.fillRect(0, 0, w, h);
		ctx.drawImage(img, 0, 0, w, h);
		const out = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
		if (!out.startsWith("data:image/jpeg")) throw new Error("no jpeg");
		return { mimeType: "image/jpeg", data: out.slice(out.indexOf(",") + 1) };
	} catch {
		const m = /^data:([^;,]+)[^,]*,(.*)$/.exec(dataUrl);
		if (!m) throw new Error("讀不到照片");
		return { mimeType: m[1], data: m[2] };
	}
}
