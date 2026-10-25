// 執行測試：用 esbuild 把 test/*.test.ts 打包（obsidian 換成測試替身），再交給 node --test
import { build } from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const out = ".test-build";
rmSync(out, { recursive: true, force: true });
const tests = readdirSync("test").filter((f) => f.endsWith(".test.ts"));
await build({
	entryPoints: tests.map((f) => join("test", f)),
	outdir: out,
	outExtension: { ".js": ".cjs" },
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node18",
	alias: { obsidian: "./test/mocks/obsidian.cjs" },
	external: ["jsdom"],
	logLevel: "warning",
});
const r = spawnSync(process.execPath, ["--test", ...tests.map((f) => join(out, f.replace(/\.ts$/, ".cjs")))], { stdio: "inherit" });
process.exit(r.status ?? 1);
