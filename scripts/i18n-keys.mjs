// Lists every tr`...` string in app.js as its I18N key ("text with {0}"), and
// with --check fails if i18n-pt.js is missing any. Run after changing texts:
//   node scripts/i18n-keys.mjs --check
import { readFileSync } from "node:fs";
const root = new URL("..", import.meta.url);
const src = readFileSync(new URL("app.js", root), "utf8");
const keys = new Set();
for (let i = src.indexOf("tr`"); i !== -1; i = src.indexOf("tr`", i + 1)) {
  if (/[\w$]/.test(src[i - 1] || "")) continue;
  let j = i + 3, key = "", n = 0;
  while (src[j] !== "`") {
    if (src[j] === "\\") { key += src[j + 1]; j += 2; continue; }
    if (src[j] === "$" && src[j + 1] === "{") {
      let depth = 1; j += 2;
      while (depth) {
        const ch = src[j];
        if (ch === "`") { j++; while (src[j] !== "`") { if (src[j] === "\\") j++; j++; } }
        else if (ch === "{") depth++;
        else if (ch === "}") depth--;
        j++;
      }
      key += `{${n++}}`;
      continue;
    }
    key += src[j++];
  }
  keys.add(key);
}
if (process.argv.includes("--check")) {
  globalThis.window = {};
  new Function(readFileSync(new URL("i18n-pt.js", root), "utf8"))();
  const dict = window.I18N;
  const missing = [...keys].filter((k) => !(k in dict));
  const unused = Object.keys(dict).filter((k) => !keys.has(k));
  for (const k of missing) console.error("missing:", JSON.stringify(k));
  for (const k of unused) console.warn("unused:", JSON.stringify(k));
  for (const k of keys) if (k in dict) {
    const want = (k.match(/\{\d+\}/g) || []).sort().join(), got = (dict[k].match(/\{\d+\}/g) || []).sort().join();
    if (want !== got) { console.error("placeholders differ:", JSON.stringify(k)); missing.push(k); }
  }
  console.log(`${keys.size} strings, ${missing.length} missing`);
  process.exit(missing.length ? 1 : 0);
} else {
  for (const k of keys) console.log(JSON.stringify(k));
}
