// 檢查 AGENTS.md 的硬性限制。npm run check
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const files = readdirSync("src").filter((f) => f.endsWith(".ts")).map((f) => join("src", f));
const rules = [
  [/\bfetch\s*\(/, "不得用 fetch，請用 requestUrl()"],
  [/from\s+["'](node:)?(fs|path|os|child_process|crypto)["']|require\(\s*["'](node:)?(fs|path|os|child_process)["']\)/, "不得用 Node API"],
  [/\bprocess\./, "不得用 process（iOS 沒有）"],
  [/\bwindow\.localStorage|\blocalStorage\./, "請用 app.saveLocalStorage / loadLocalStorage"],
  [/\bXMLHttpRequest\b|\bWebSocket\b/, "網路只用 requestUrl()"],
];
let bad = 0;
for (const f of files) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    for (const [re, msg] of rules) if (re.test(line)) { console.log(`${f}:${i + 1}: ${msg}\n  ${line.trim()}`); bad++; }
  });
}
const m = JSON.parse(readFileSync("manifest.json", "utf8"));
if (m.isDesktopOnly !== false) { console.log("manifest.isDesktopOnly 必須是 false"); bad++; }
const out = readFileSync("main.js", "utf8");
if (/require\(["'](fs|path|os|child_process)["']\)/.test(out)) { console.log("main.js 含 Node 模組"); bad++; }
console.log(bad ? `✗ ${bad} 個違規` : "✓ 符合 AGENTS.md 硬性限制");
process.exit(bad ? 1 : 0);
