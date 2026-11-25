// Writes data/status.json: how many plugs at each MOBI.E site are free right
// now, from the NAP "actual status" feed (refreshed by MOBI.E every few
// minutes). Run by .github/workflows/status.yml every 15 minutes; the file is
// only deployed, never committed, so git history stays clean.
// No dependencies: Node 20+.
//
//   node scripts/update-status.mjs              # download live feed
//   node scripts/update-status.mjs status.xml   # use a local file
import { readFile, writeFile } from "node:fs/promises";

const URL_STATUS = "https://pgm.mobie.pt/integration/nap/evActualStatus";
const OUT = new URL("../data/status.json", import.meta.url);

async function get(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "madeira-chargers (GitHub Actions)" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      console.warn(`${url} attempt ${attempt}: ${e}`);
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

// DATEX II status values -> free / busy / broken. unknown and planned are left out.
const KIND = { available: 0, charging: 1, occupied: 1, reserved: 1, outOfOrder: 2, inoperative: 2, blocked: 2, faulted: 2 };

const file = process.argv[2];
const xml = file ? await readFile(file, "utf8") : await get(URL_STATUS);
const time = xml.match(/<(?:\w+:)?publicationTime>([^<]+)</)?.[1] || new Date().toISOString();
const sites = {};
let points = 0;
const re = /<(\w+:)?refillPointStatus\b[^>]*>([\s\S]*?)<\/\1?refillPointStatus>/g;
for (const m of xml.matchAll(re)) {
  const p = m[2];
  const id = p.match(/\bid="([^"]+)"/)?.[1];
  const st = p.match(/<(?:\w+:)?status>(\w+)</)?.[1];
  if (!id || !(st in KIND)) continue;
  const code = id.replace(/-\d+$/, ""); // AMD-00051-1 -> AMD-00051, the site id on the map
  (sites[code] ||= [0, 0, 0])[KIND[st]]++;
  points++;
}
if (points < 1000) {
  console.error(`Only ${points} plugs with a status; not writing.`);
  process.exit(1);
}
// [free, in use, out of order] per site.
await writeFile(OUT, JSON.stringify({ time, sites }) + "\n");
console.log(`Status at ${time}: ${points} plugs at ${Object.keys(sites).length} sites.`);
