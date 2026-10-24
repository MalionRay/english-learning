import esbuild from "esbuild";
import { readFileSync } from "node:fs";
const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
const prod = process.argv[2] === "production";
const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2018",
  platform: "browser",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  define: { PLUGIN_VERSION: JSON.stringify(version) },
});
if (prod) { await ctx.rebuild(); process.exit(0); } else { await ctx.watch(); }
