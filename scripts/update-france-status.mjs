// Writes data/fr/status.json: free / in use / out of order plugs per station,
// from France's consolidated live status file (IRVE dynamique,
// transport.data.gouv.fr). Needs data/fr/pdc-index.json from
// update-france.mjs. Run every 15 min by the France site's workflow; never
// committed.
//
//   node scripts/update-france-status.mjs            # download
//   node scripts/update-france-status.mjs dyn.csv    # local file
import { readFile, writeFile } from "node:fs/promises";
import { parseCsv } from "./csv.mjs";

const URL_DYN = "https://transport.data.gouv.fr/resources/84098/download";
const DIR = new URL("../data/fr/", import.meta.url);
// A point's own report older than this is not "now" any more.
const MAX_AGE_H = 2;

async function get(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "chargers-site (GitHub Actions)" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      console.warn(`${url} attempt ${attempt}: ${e}`);
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

const file = process.argv[2];
const index = JSON.parse(await readFile(new URL("pdc-index.json", DIR), "utf8"));
const rows = parseCsv(file ? await readFile(file, "utf8") : await get(URL_DYN));
const now = file ? rows.reduce((m, r) => Math.max(m, Date.parse(r.horodatage.replace(" ", "T")) || 0), 0) : Date.now();
const sites = {};
let points = 0;
for (const r of rows) {
  const station = index[r.id_pdc_itinerance];
  if (!station) continue;
  const t = Date.parse(r.horodatage.replace(" ", "T"));
  if (!(now - t < MAX_AGE_H * 3600e3)) continue;
  const k = r.etat_pdc === "hors_service" ? 2
    : r.etat_pdc !== "en_service" ? -1
    : r.occupation_pdc === "libre" ? 0 : /occupe|reserve/.test(r.occupation_pdc) ? 1 : -1;
  if (k < 0) continue;
  (sites[station] ||= [0, 0, 0])[k]++;
  points++;
}
if (points < 1000 && !file) {
  console.error(`Only ${points} recent plug statuses; not writing.`);
  process.exit(1);
}
await writeFile(new URL("status.json", DIR), JSON.stringify({ time: new Date(now).toISOString(), sites }) + "\n");
console.log(`${points} plugs with a recent status at ${Object.keys(sites).length} stations.`);
