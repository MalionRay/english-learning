// 記憶體裡的假 Vault / App，給測試用
const ob = require("obsidian");

export type FileMap = Map<string, string | ArrayBuffer>;

function parseFm(s: string): Record<string, unknown> {
	const m = s.match(/^---\n([\s\S]*?)\n---/);
	const o: Record<string, unknown> = {};
	if (!m) return o;
	for (const l of m[1].split("\n")) {
		const i = l.indexOf(":");
		if (i < 0) continue;
		let v: unknown = l.slice(i + 1).trim();
		if (typeof v === "string" && /^".*"$/.test(v)) v = JSON.parse(v);
		else if (typeof v === "string" && /^\d+$/.test(v)) v = Number(v);
		o[l.slice(0, i)] = v;
	}
	return o;
}

function dumpFm(o: Record<string, unknown>): string {
	return "---\n" + Object.entries(o).map(([k, v]) => `${k}: ${typeof v === "string" && /[":[\]#]/.test(v) ? JSON.stringify(v) : v}`).join("\n") + "\n---\n";
}

export function makeApp(files: FileMap = new Map()) {
	const ls = new Map<string, unknown>();
	const size = (p: string) => {
		const v = files.get(p);
		return typeof v === "string" ? v.length : v ? v.byteLength : 0;
	};
	const tfile = (p: string) => new ob.TFile(p, size(p));
	const dirs = new Set<string>();
	const app: any = {
		loadLocalStorage: (k: string) => ls.get(k) ?? null,
		saveLocalStorage: (k: string, v: unknown) => (v === null ? ls.delete(k) : ls.set(k, v)),
		workspace: { getActiveFile: () => null, getLeaf: () => ({ openFile: async () => undefined }), onLayoutReady: (f: () => void) => f() },
		metadataCache: { getFileCache: (f: any) => ({ frontmatter: parseFm(String(files.get(f.path) ?? "")) }) },
		fileManager: {
			processFrontMatter: async (f: any, fn: (fm: Record<string, unknown>) => void) => {
				const s = String(files.get(f.path));
				const fm = parseFm(s);
				fn(fm);
				files.set(f.path, dumpFm(fm) + s.replace(/^---\n[\s\S]*?\n---\n/, ""));
			},
			trashFile: async (f: any) => files.delete(f.path),
		},
		vault: {
			getFiles: () => [...files.keys()].map(tfile),
			getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith(".md")).map(tfile),
			getAbstractFileByPath: (p: string) => (files.has(p) ? tfile(p) : null),
			read: async (f: any) => String(files.get(f.path)),
			cachedRead: async (f: any) => String(files.get(f.path)),
			readBinary: async (f: any) => files.get(f.path),
			create: async (p: string, t: string) => {
				if (files.has(p)) throw new Error("exists");
				files.set(p, t);
				return tfile(p);
			},
			createBinary: async (p: string, d: ArrayBuffer) => {
				files.set(p, d);
				return tfile(p);
			},
			modify: async (f: any, t: string) => void files.set(f.path, t),
			append: async (f: any, t: string) => void files.set(f.path, String(files.get(f.path) ?? "") + t),
			delete: async (f: any) => void files.delete(f.path),
			createFolder: async (p: string) => void dirs.add(p),
			adapter: {
				exists: async (p: string) => files.has(p) || dirs.has(p) || [...files.keys()].some((k) => k.startsWith(p + "/")),
				read: async (p: string) => String(files.get(p)),
				write: async (p: string, t: string) => void files.set(p, t),
				append: async (p: string, t: string) => void files.set(p, String(files.get(p) ?? "") + t),
				list: async (folder: string) => {
					const pre = folder + "/";
					const keys = [...files.keys()].filter((k) => k.startsWith(pre));
					const fl = keys.filter((k) => !k.slice(pre.length).includes("/"));
					const fo = [...new Set(keys.filter((k) => k.slice(pre.length).includes("/")).map((k) => pre + k.slice(pre.length).split("/")[0]))];
					return { files: fl, folders: fo };
				},
			},
		},
	};
	return { app, files, ls };
}
