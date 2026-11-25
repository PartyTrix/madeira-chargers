// Builds one of the two sites from the shared code and data.
//
//   node scripts/build-site.mjs madeira _site    -> madeirachargers.com
//   node scripts/build-site.mjs portugal _site   -> chargeportugal.com
//
// madeira is the repo as it is. Any other site lives in sites/<name>/:
//   site.json   text replacements in index.html (build fails if one misses)
//   head.html   replaces <!-- site:head --> ... <!-- /site:head --> (title, SEO, JSON-LD)
//   about.html  replaces <!-- site:about --> ... <!-- /site:about --> (visible About/FAQ)
//   site.css    appended to style.css (colours)
//   files/      copied over the output (icons, share image, manifest, robots, sitemap)
// No dependencies; Node 18+.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const [site = "madeira", out = "_site"] = process.argv.slice(2);
const root = new URL("..", import.meta.url).pathname;
const SHARED = ["index.html", "app.js", "style.css", "data", "vendor", "img", "robots.txt", "sitemap.xml", "manifest.webmanifest"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of SHARED) cpSync(join(root, f), join(out, f), { recursive: true });

const fail = (msg) => { console.error(`::error::build-site ${site}: ${msg}`); process.exit(1); };
const read = (f) => readFileSync(f, "utf8");
let html = read(join(out, "index.html"));

function swapBlock(name, file) {
  const re = new RegExp(`([ \\t]*<!-- site:${name}\\b[^>]*-->\\n)[\\s\\S]*?([ \\t]*<!-- /site:${name} -->)`);
  if (!re.test(html)) fail(`marker <!-- site:${name} --> not found in index.html`);
  const body = read(file).replace(/\n?$/, "\n");
  html = html.replace(re, (_, open, close) => open + body + close);
}

if (site !== "madeira") {
  const dir = join(root, "sites", site);
  if (!existsSync(dir)) fail(`no sites/${site}/ folder`);
  const cfg = JSON.parse(read(join(dir, "site.json")));
  for (const [from, to] of cfg.replace || []) {
    if (!html.includes(from)) fail(`replace text not found in index.html: ${from}`);
    html = html.split(from).join(to);
  }
  swapBlock("head", join(dir, "head.html"));
  swapBlock("about", join(dir, "about.html"));
  if (existsSync(join(dir, "site.css"))) appendFileSync(join(out, "style.css"), read(join(dir, "site.css")));
  if (existsSync(join(dir, "files"))) cpSync(join(dir, "files"), out, { recursive: true });
  // Nothing on this site may still point search engines at the other one.
  const leftovers = html.match(/<link rel="canonical"[^>]*>|<meta property="og:(url|image)"[^>]*>/g) || [];
  for (const tag of leftovers) if (!tag.includes(cfg.domain)) fail(`${tag} does not point at ${cfg.domain}`);
}

// Cache-bust: phones otherwise mix a new page with old CSS/JS for a while.
const git = (cmd) => { try { return execSync(`git ${cmd}`, { cwd: root, encoding: "utf8" }).trim(); } catch { return ""; } };
html = html.replaceAll("?v=dev", `?v=${git("rev-parse --short HEAD") || "dev"}`);
writeFileSync(join(out, "index.html"), html);
// Sitemap date = last time the site or its data changed.
const lastmod = git("log -1 --format=%cs") || new Date().toISOString().slice(0, 10);
writeFileSync(join(out, "sitemap.xml"), read(join(out, "sitemap.xml")).replace("LASTMOD", lastmod));

for (const f of ["data/chargers.geojson", "data/extra.geojson", "data/pricing.json", "data/tariffs.json", "manifest.webmanifest"])
  try { JSON.parse(read(join(out, f))); } catch (e) { fail(`${f} is not valid JSON: ${e.message}`); }
console.log(`Built ${site} into ${out}`);
