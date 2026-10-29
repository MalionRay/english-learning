// 錄音（英文對話的語音輸入）：用 Web Audio 直接收 PCM，自己編成 16 kHz 單聲道 WAV。
// 不用 MediaRecorder：各平台輸出格式不同（webm／mp4），Gemini 與 iOS 播放都不一定支援；WAV 到處都能用。
// 必須在使用者點擊的事件裡呼叫 start()（iOS 需要在手勢中啟動 AudioContext）。

const TARGET_RATE = 16000;
const MAX_SECONDS = 60;

export function recordingSupported(): boolean {
	return (
		typeof navigator !== "undefined" &&
		!!navigator.mediaDevices?.getUserMedia &&
		typeof window !== "undefined" &&
		!!(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext)
	);
}

export class WavRecorder {
	private ctx: AudioContext | null = null;
	private stream: MediaStream | null = null;
	private node: ScriptProcessorNode | null = null;
	private chunks: Float32Array[] = [];
	private rate = 48000;
	private timer: number | null = null;
	onAutoStop?: () => void;

	get recording(): boolean {
		return !!this.node;
	}

	async start(): Promise<void> {
		const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
		this.ctx = new Ctx();
		if (this.ctx.state === "suspended") await this.ctx.resume();
		this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
		this.rate = this.ctx.sampleRate;
		const src = this.ctx.createMediaStreamSource(this.stream);
		this.node = this.ctx.createScriptProcessor(4096, 1, 1);
		this.chunks = [];
		this.node.onaudioprocess = (e) => this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
		src.connect(this.node);
		this.node.connect(this.ctx.destination);
		this.timer = window.setTimeout(() => this.onAutoStop?.(), MAX_SECONDS * 1000);
	}

	/** 停止並回傳 WAV。 */
	async stop(): Promise<{ wav: ArrayBuffer; seconds: number }> {
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = null;
		this.node?.disconnect();
		this.node = null;
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = null;
		await this.ctx?.close().catch(() => undefined);
		this.ctx = null;
		const total = this.chunks.reduce((n, c) => n + c.length, 0);
		const all = new Float32Array(total);
		let off = 0;
		for (const c of this.chunks) {
			all.set(c, off);
			off += c.length;
		}
		this.chunks = [];
		const pcm = downsample(trimSilence(all, this.rate), this.rate, TARGET_RATE);
		return { wav: encodeWav(pcm, TARGET_RATE), seconds: pcm.length / TARGET_RATE };
	}

	cancel() {
		void this.stop();
	}
}

/** 去掉頭尾的靜音（保留 0.2 秒緩衝），檔案小一點、評分也比較準。 */
export function trimSilence(x: Float32Array, rate: number, threshold = 0.015): Float32Array {
	const pad = Math.floor(rate * 0.2);
	let a = 0,
		b = x.length - 1;
	while (a < x.length && Math.abs(x[a]) < threshold) a++;
	while (b > a && Math.abs(x[b]) < threshold) b--;
	if (a >= b) return x;
	return x.subarray(Math.max(0, a - pad), Math.min(x.length, b + pad));
}

export function downsample(x: Float32Array, from: number, to: number): Float32Array {
	if (from === to) return x;
	const ratio = from / to;
	const n = Math.floor(x.length / ratio);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		// 區間平均（簡單低通）
		const s = Math.floor(i * ratio);
		const e = Math.min(x.length, Math.floor((i + 1) * ratio));
		let sum = 0;
		for (let k = s; k < e; k++) sum += x[k];
		out[i] = sum / Math.max(1, e - s);
	}
	return out;
}

export function encodeWav(pcm: Float32Array, rate: number): ArrayBuffer {
	const buf = new ArrayBuffer(44 + pcm.length * 2);
	const v = new DataView(buf);
	const w = (p: number, s: string) => {
		for (let i = 0; i < 4; i++) v.setUint8(p + i, s.charCodeAt(i));
	};
	w(0, "RIFF");
	v.setUint32(4, 36 + pcm.length * 2, true);
	w(8, "WAVE");
	w(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, rate, true);
	v.setUint32(28, rate * 2, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	w(36, "data");
	v.setUint32(40, pcm.length * 2, true);
	for (let i = 0; i < pcm.length; i++) {
		const s = Math.max(-1, Math.min(1, pcm[i]));
		v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
	}
	return buf;
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let bin = "";
	const CH = 0x8000;
	for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
	return btoa(bin);
}
