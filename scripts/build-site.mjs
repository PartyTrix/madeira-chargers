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
const SHARED = ["index.html", "app.js", "i18n-pt.js", "style.css", "data", "vendor", "img", "robots.txt", "sitemap.xml", "manifest.webmanifest"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of SHARED) cpSync(join(root, f), join(out, f), { recursive: true });

const fail = (msg) => { console.error(`::error::build-site ${site}: ${msg}`); process.exit(1); };
const read = (f) => readFileSync(f, "utf8");
let html = read(join(out, "index.html"));

function swapIn(page, name, file) {
  const re = new RegExp(`([ \\t]*<!-- site:${name}\\b[^>]*-->\\n)[\\s\\S]*?([ \\t]*<!-- /site:${name} -->)`);
  if (!re.test(page)) fail(`marker <!-- site:${name} --> not found in index.html`);
  const body = read(file).replace(/\n?$/, "\n");
  return page.replace(re, (_, open, close) => open + body + close);
}
const swapBlock = (name, file) => { html = swapIn(html, name, file); };
function applyReplace(page, list, what) {
  for (const [from, to] of list || []) {
    if (!page.includes(from)) fail(`${what}: text not found in index.html: ${from}`);
    page = page.split(from).join(to);
  }
  return page;
}
const checkDomain = (page, domain, what) => {
  const tags = page.match(/<link rel="canonical"[^>]*>|<meta property="og:(url|image)"[^>]*>/g) || [];
  for (const tag of tags) if (!tag.includes(domain)) fail(`${what}: ${tag} does not point at ${domain}`);
};

if (site !== "madeira") {
  const dir = join(root, "sites", site);
  if (!existsSync(dir)) fail(`no sites/${site}/ folder`);
  const cfg = JSON.parse(read(join(dir, "site.json")));
  html = applyReplace(html, cfg.replace, "site.json");
  swapBlock("head", join(dir, "head.html"));
  swapBlock("about", join(dir, "about.html"));
  if (existsSync(join(dir, "site.css"))) appendFileSync(join(out, "style.css"), read(join(dir, "site.css")));
  if (existsSync(join(dir, "files"))) cpSync(join(dir, "files"), out, { recursive: true });
  // Nothing on this site may still point search engines at the other one.
  checkDomain(html, cfg.domain, "index.html");

  // Portuguese page at /pt/: same page with sites/<site>/pt/ blocks, the
  // static texts from sites/pt-ui.json and app.js texts from i18n-pt.js.
  const pt = join(dir, "pt");
  if (existsSync(pt)) {
    let page = html.replace(/<html lang="en"/, '<html lang="pt-PT" data-root="../"');
    page = applyReplace(page, JSON.parse(read(join(root, "sites", "pt-ui.json"))).replace, "pt-ui.json");
    for (const name of ["head", "about", "credits"]) if (existsSync(join(pt, `${name}.html`))) page = swapIn(page, name, join(pt, `${name}.html`));
    // Assets live one level up.
    page = page.replace(/\b(href|src)="(?!https?:|data:|#|\.\.\/|\/|mailto:)([^"]+)"/g, '$1="../$2"');
    page = page.replace('<script src="../app.js', '<script src="../i18n-pt.js?v=dev"></script>\n  <script src="../app.js');
    checkDomain(page, cfg.domain, "pt/index.html");
    if (!page.includes('lang="pt-PT"') || !page.includes("i18n-pt.js")) fail("pt page: language or script hook not found");
    mkdirSync(join(out, "pt"), { recursive: true });
    writeFileSync(join(out, "pt", "index.html"), page);
  }
}

// Cache-bust: phones otherwise mix a new page with old CSS/JS for a while.
const git = (cmd) => { try { return execSync(`git ${cmd}`, { cwd: root, encoding: "utf8" }).trim(); } catch { return ""; } };
const version = git("rev-parse --short HEAD") || "dev";
html = html.replaceAll("?v=dev", `?v=${version}`);
writeFileSync(join(out, "index.html"), html);
if (existsSync(join(out, "pt", "index.html")))
  writeFileSync(join(out, "pt", "index.html"), read(join(out, "pt", "index.html")).replaceAll("?v=dev", `?v=${version}`));
// Sitemap date = last time the site or its data changed.
const lastmod = git("log -1 --format=%cs") || new Date().toISOString().slice(0, 10);
writeFileSync(join(out, "sitemap.xml"), read(join(out, "sitemap.xml")).replaceAll("LASTMOD", lastmod));

for (const f of ["data/chargers.geojson", "data/extra.geojson", "data/pricing.json", "data/tariffs.json", "manifest.webmanifest"])
  try { JSON.parse(read(join(out, f))); } catch (e) { fail(`${f} is not valid JSON: ${e.message}`); }
console.log(`Built ${site} into ${out}`);
