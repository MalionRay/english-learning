// 文章（english/sources）與題庫（english/bank）的檔案操作。只用 Vault API。
import { App, TFile, normalizePath } from "obsidian";
import {
	Bank,
	Level,
	MAX_WORDS,
	cleanText,
	extractMarked,
	markWords,
	missingMarked,
	planWithMarked,
	stripMarks,
	parseQuestions,
	planTotal,
	renderBank,
	systemPrompt,
	userPrompt,
	wordCount,
} from "./generate";
import { AIBackend, AIUsage } from "./ai";
import { uuid } from "./logs";

export const SOURCES_DIR = "english/sources";
export const BANK_DIR = "english/bank";

export type SourceStatus = "new" | "generating" | "generated";
/** 「出題中」超過這個時間視為上次中斷，可以重試。 */
const STALE_GENERATING_MS = 10 * 60 * 1000;

export interface SourceInfo {
	file: TFile;
	id?: string;
	title: string;
	level?: Level;
	status: SourceStatus;
	importedOn?: string;
	generatingSince?: string;
	count?: number;
	bank?: string;
	lastError?: string;
}

async function ensureFolder(app: App, folder: string) {
	let cur = "";
	for (const p of normalizePath(folder).split("/")) {
		cur = cur ? `${cur}/${p}` : p;
		if (!(await app.vault.adapter.exists(cur))) {
			try {
				await app.vault.createFolder(cur);
			} catch {
				/* 已存在 */
			}
		}
	}
}

export function shortId(): string {
	return uuid().replace(/-/g, "").slice(0, 8);
}

function safeFileName(title: string): string {
	const s = title
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
	return s || "untitled";
}

export function stripFrontmatter(md: string): string {
	return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** 匯入：在 english/sources 建立新筆記。 */
export async function importArticle(
	app: App,
	opts: { title: string; level: Level; text: string; deviceId: string; unknownWords?: string[] },
): Promise<{ file: TFile; notFound: string[] }> {
	await ensureFolder(app, SOURCES_DIR);
	const base = safeFileName(opts.title);
	let path = normalizePath(`${SOURCES_DIR}/${base}.md`);
	for (let i = 2; await app.vault.adapter.exists(path); i++) path = normalizePath(`${SOURCES_DIR}/${base} ${i}.md`);
	const fm = [
		"---",
		`id: "${shortId()}"`, // 加引號：避免 YAML 把 "12345678" 或 "1e234567" 讀成數字
		`title: ${JSON.stringify(opts.title.trim() || base)}`,
		`level: ${opts.level}`,
		`status: new`,
		`importedOn: ${opts.deviceId}`,
		`importedAt: ${new Date().toISOString()}`,
		"---",
		"",
	].join("\n");
	const { text, notFound } = markWords(cleanText(opts.text).trim(), opts.unknownWords ?? []);
	const file = await app.vault.create(path, fm + text + "\n");
	return { file, notFound };
}

export function readSource(app: App, file: TFile): SourceInfo {
	const fm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
	const st = fm.status;
	return {
		file,
		id: typeof fm.id === "string" ? fm.id : fm.id != null ? String(fm.id) : undefined,
		title: typeof fm.title === "string" && fm.title ? fm.title : file.basename,
		level: fm.level === "kid" || fm.level === "adult" ? fm.level : undefined,
		status: st === "generated" || st === "generating" ? st : "new",
		importedOn: typeof fm.importedOn === "string" ? fm.importedOn : undefined,
		generatingSince: typeof fm.generatingSince === "string" ? fm.generatingSince : undefined,
		count: typeof fm.count === "number" ? fm.count : undefined,
		bank: typeof fm.bank === "string" ? fm.bank : undefined,
		lastError: typeof fm.lastError === "string" ? fm.lastError : undefined,
	};
}

export function listSources(app: App): SourceInfo[] {
	const prefix = SOURCES_DIR + "/";
	return app.vault
		.getMarkdownFiles()
		.filter((f) => f.path.startsWith(prefix))
		.map((f) => readSource(app, f))
		.sort((a, b) => b.file.stat.ctime - a.file.stat.ctime);
}

export function bankPath(sourceId: string): string {
	return normalizePath(`${BANK_DIR}/${sourceId}.md`);
}

/**
 * 重新出題前的重置：把舊題庫移到垃圾桶（依使用者的刪除設定），來源筆記改回 status: new。
 * 只能在匯入的裝置執行（單一寫入者）。舊題目的答題紀錄仍留在 log 裡，只是不再對應到題目。
 */
export async function resetSource(app: App, file: TFile, deviceId: string): Promise<void> {
	const s = readSource(app, file);
	if (s.importedOn && s.importedOn !== deviceId) throw new Error(`只能在匯入的裝置（${s.importedOn}）重新出題`);
	if (s.id) {
		const old = app.vault.getAbstractFileByPath(bankPath(s.id));
		if (old instanceof TFile) await app.fileManager.trashFile(old);
	}
	await app.fileManager.processFrontMatter(file, (fm) => {
		fm.status = "new";
		delete fm.count;
		delete fm.bank;
		delete fm.generatedAt;
		delete fm.generatingSince;
		delete fm.lastError;
	});
}

/** 等 metadataCache 反映 frontmatter 的變更（processFrontMatter 之後快取是非同步更新的）。 */
export async function waitForStatus(app: App, file: TFile, status: SourceStatus, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (readSource(app, file).status !== status) {
		if (Date.now() - start > timeoutMs) return;
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** 這篇文章現在能不能在這台裝置出題；不能的話回傳原因。 */
export function canGenerate(s: SourceInfo, deviceId: string): { ok: boolean; reason?: string } {
	if (s.status === "generated") return { ok: false, reason: "已經出過題" };
	if (s.status === "generating") {
		const since = s.generatingSince ? Date.parse(s.generatingSince) : 0;
		if (Date.now() - since < STALE_GENERATING_MS) return { ok: false, reason: "出題中" };
	}
	if (s.importedOn && s.importedOn !== deviceId) return { ok: false, reason: `只能在匯入的裝置（${s.importedOn}）出題` };
	return { ok: true };
}

export interface GenerateResult {
	bankFile: TFile;
	count: number;
	planned: number;
	dropped: number;
	marked: number;
	missing: string[];
	model: string;
	usage: AIUsage;
	ms: number;
}

/**
 * 出題。防重複：
 * 1. status 必須不是 generated（也不是進行中的 generating）
 * 2. 只在匯入的裝置執行（importedOn）
 * 3. 題庫檔已存在就不覆寫
 */
export async function generateForSource(
	app: App,
	file: TFile,
	ai: AIBackend,
	deviceId: string,
	levelIfMissing: Level = "adult",
): Promise<GenerateResult> {
	const info = readSource(app, file);
	const check = canGenerate(info, deviceId);
	if (!check.ok) throw new Error(check.reason);

	const raw = cleanText(stripFrontmatter(await app.vault.read(file))).trim();
	const marked = extractMarked(raw);
	const article = stripMarks(raw);
	const words = wordCount(article);
	if (words < 30) throw new Error(`文章太短（${words} 個英文字），至少需要 30 個字`);
	if (words > MAX_WORDS) throw new Error(`文章太長（${words} 個英文字），請分段匯入，每段最多 ${MAX_WORDS} 字`);

	const id = info.id ?? shortId();
	const level = info.level ?? levelIfMissing;
	const bp = bankPath(id);
	if (await app.vault.adapter.exists(bp)) throw new Error(`題庫檔已存在：${bp}（不覆寫）`);

	// 上鎖
	await app.fileManager.processFrontMatter(file, (fm) => {
		fm.id = id;
		fm.title = fm.title ?? info.title;
		fm.level = level;
		fm.importedOn = fm.importedOn ?? deviceId;
		fm.status = "generating";
		fm.generatingSince = new Date().toISOString();
		delete fm.lastError;
	});

	const started = Date.now();
	try {
		const plan = planWithMarked(words, marked.length);
		const res = await ai.complete(userPrompt(article, plan, marked), {
			system: systemPrompt(level),
			json: true,
			maxOutputTokens: 8192,
			temperature: 0.7,
		});
		if (!res.text) throw new Error(`AI 沒有回傳內容（finishReason=${res.finishReason ?? "?"}）`);
		if (res.finishReason === "MAX_TOKENS") throw new Error("AI 回覆被截斷（超過長度上限），請把文章分段再試");
		const parsed = parseQuestions(res.text);
		const planned = planTotal(plan);
		const markedSet = new Set(marked.map((m) => m.toLowerCase()));
		for (const q of parsed.questions)
			if (q.type === "vocab" && ((q.word && markedSet.has(q.word.toLowerCase())) || markedSet.has(q.prompt.toLowerCase()))) q.marked = true;
		const missing = missingMarked(parsed.questions, marked);
		if (parsed.questions.length < Math.ceil(planned / 2))
			throw new Error(`可用的題目太少（${parsed.questions.length}/${planned}），請再試一次`);

		const bank: Bank = {
			version: 1,
			sourceId: id,
			sourcePath: file.path,
			title: info.title,
			level,
			model: res.model,
			generatedAt: new Date().toISOString(),
			device: deviceId,
			questions: parsed.questions,
		};
		await ensureFolder(app, BANK_DIR);
		const linkTarget = file.path.replace(/\.md$/, "");
		const bankFile = await app.vault.create(bp, renderBank(bank, linkTarget));

		await app.fileManager.processFrontMatter(file, (fm) => {
			fm.status = "generated";
			fm.count = parsed.questions.length;
			fm.bank = `[[${bp.replace(/\.md$/, "")}]]`;
			fm.generatedAt = bank.generatedAt;
			delete fm.generatingSince;
		});
		return {
			bankFile,
			count: parsed.questions.length,
			planned,
			dropped: parsed.dropped.length,
			marked: marked.length,
			missing,
			model: res.model,
			usage: res.usage,
			ms: Date.now() - started,
		};
	} catch (e) {
		// 解鎖，讓使用者可以重試
		await app.fileManager
			.processFrontMatter(file, (fm) => {
				fm.status = "new";
				fm.lastError = String((e as Error)?.message ?? e).slice(0, 200);
				delete fm.generatingSince;
			})
			.catch(() => undefined);
		throw e;
	}
}
