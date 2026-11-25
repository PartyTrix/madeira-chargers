// Writes data/fr/chargers.json: every public charger in mainland France and
// Corsica, from France's national charging-point base (IRVE, consolidated and
// de-duplicated by transport.data.gouv.fr, Licence Ouverte 2.0, refreshed
// nightly), with an ad hoc price per kWh parsed from the operators' free-text
// "tarification" where possible. Only deployed by the France site's workflow,
// never committed: the source is 130 MB and changes every night.
// No dependencies: Node 20+.
//
//   node scripts/update-france.mjs               # download the national file
//   node scripts/update-france.mjs irve.csv      # use a local copy
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseTarif } from "./fr-tarif.mjs";
import { parseCsv } from "./csv.mjs";

const URL_IRVE = "https://transport.data.gouv.fr/resources/84013/download";
const OUT_DIR = new URL("../data/fr/", import.meta.url);
// Mainland France and Corsica. The overseas departments are left out for now.
const BOX = { latMin: 41.3, latMax: 51.2, lonMin: -5.3, lonMax: 9.7 };

async function get(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "chargers-site (GitHub Actions)" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      console.warn(`${url} attempt ${attempt}: ${e}`);
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 10000 * attempt));
    }
  }
}

// Publishers' files come in several encodings; undo the usual mojibake.
const MOJI = { "\u0080": "€", "Ć": "€", "ķ": "é", "Ķ": "è", "č": "è", "ŕ": "à", "ā": "à", "Ź": "è", "Ã©": "é", "Ã¨": "è", "Ã ": "à", "â‚¬": "€" };
const fix = (s) => (s || "").replace(/Ã©|Ã¨|Ã |â‚¬|[\u0080ĆķĶčŕāŹ]/g, (m) => MOJI[m]).replace(/\s+/g, " ").trim();
const yes = (v) => /^(true|1|oui|yes)$/i.test((v || "").trim());

function kw(v) {
  let p = parseFloat(String(v).replace(",", "."));
  if (!(p > 0)) return 0;
  if (p >= 1000) p /= 1000; // some publishers give watts
  return Math.round(p * 10) / 10;
}
function plugTypes(r) {
  const t = [];
  if (yes(r.prise_type_combo_ccs)) t.push("CCS");
  if (yes(r.prise_type_chademo)) t.push("CHAdeMO");
  if (yes(r.prise_type_2)) t.push("Type 2");
  if (yes(r.prise_type_ef)) t.push("Schuko");
  return t;
}
// "Allée des Tilleuls, 04200 SISTERON" -> keep as is; collapse doubled commas and spaces.
const tidyAddr = (s) => fix(s).replace(/\s*,\s*,/g, ",").replace(/^[\s,]+|[\s,]+$/g, "");
function opName(r) {
  const n = fix(r.nom_enseigne) || fix(r.nom_operateur) || fix(r.nom_amenageur);
  return n.replace(/\s*\|\s*FR\*\w+$/i, "").replace(/\s+FR\*\w+$/i, "").trim() || null;
}

// Usual prices of the big networks, for chargers that publish none.
const NETS = JSON.parse(await readFile(new URL("../sites/france/networks.json", import.meta.url), "utf8"));
for (const n of NETS.networks) n.re = new RegExp(n.match, "i");
function network(r) {
  for (const field of [r.nom_enseigne, r.nom_operateur, r.nom_amenageur]) {
    const v = fix(field);
    const n = v && NETS.networks.find((n) => n.re.test(v));
    if (n) return n;
  }
  return null;
}
// The network's usual price for this power, as a tariff marked "est" with its range.
function estimate(n, kw) {
  const range = kw >= 100 && n.dc_fast ? n.dc_fast : kw >= 50 ? n.dc : n.ac;
  if (!range) return null;
  const [lo, hi] = range;
  return { kwh: Math.round((lo + hi) / 2 * 1000) / 1000, est: [lo, hi], net: n.name };
}

// Motorway service areas: "Aire de Vémars", "Electra A9 - Aire de ...", "A10 - Aire".
const MOTORWAY = /\baires? (de|d'|d’|du|des)\b(?! ?(covoiturage|camping|jeux|stationnement))|\bautoroute\b|(?:^|[\s(,])A\s?\d{1,3}(?=[\s),\-]|$)(?!\s*\d)/;
const STREET = /^\s*\d*\s*(rue|avenue|av\.|boulevard|bd|chemin|impasse|place|allée|route|zone|za|zac|quai|cours)\b/i;

const file = process.argv[2];
const csv = file ? await readFile(file, "utf8") : await get(URL_IRVE);
const rows = parseCsv(csv);
console.log(`${rows.length} charging points in the file`);

const stations = new Map();
let skipped = { box: 0, reserved: 0, dup: 0 };
const seenPdc = new Set();
for (const r of rows) {
  const lat = parseFloat(r.consolidated_latitude), lon = parseFloat(r.consolidated_longitude);
  if (!(lat >= BOX.latMin && lat <= BOX.latMax && lon >= BOX.lonMin && lon <= BOX.lonMax)) { skipped.box++; continue; }
  // Reserved = customers or residents only (hotels, dealers, car parks with a barrier).
  // Some public networks (Ionity, Electra) mark every station reserved, so
  // those are kept.
  const net = network(r);
  if (/r[ée]serv/i.test(fix(r.condition_acces)) && !net?.public) { skipped.reserved++; continue; }
  const pdc = r.id_pdc_itinerance.trim();
  if (pdc && pdc !== "Non concerné") {
    if (seenPdc.has(pdc)) { skipped.dup++; continue; }
    seenPdc.add(pdc);
  }
  let sid = r.id_station_itinerance.trim();
  if (!sid || /non concern/i.test(sid)) sid = `X${lat.toFixed(5)},${lon.toFixed(5)}`;
  let s = stations.get(sid);
  if (!s) {
    s = {
      id: sid, lat: +lat.toFixed(6), lon: +lon.toFixed(6),
      name: fix(r.nom_station), address: tidyAddr(r.adresse_station), operator: net?.name || opName(r),
      hours: fix(r.horaires).replace(/^24\/7$/, ""), points: [], card: false, acte: false, other: false, free: false,
    };
    const where = `${s.name} | ${fix(r.nom_enseigne)}`;
    s.motorway = MOTORWAY.test(where) || (!STREET.test(s.address) && MOTORWAY.test(s.address));
    // Some operators put a code in the name ("Lfr3722evcp05"): use "Lidl Dijon".
    if (!s.name || (/\d/.test(s.name) && !/\s/.test(s.name)) || s.name === sid) {
      const city = s.address.match(/\b\d{5}\s*,?\s*([^,\d][^,]*)$/)?.[1]?.trim();
      s.name = [s.operator, city].filter(Boolean).join(" ") || s.address || "EV charger";
    }
    stations.set(sid, s);
  }
  const p = { kw: kw(r.puissance_nominale), types: plugTypes(r), pdc };
  // AC-only plugs above 43 kW are a data error (often the station's total): call it 22 kW.
  if (p.kw > 43 && p.types.length && !p.types.some((t) => t === "CCS" || t === "CHAdeMO")) p.kw = 22;
  const free = yes(r.gratuit);
  p.tariff = free ? { free: true } : parseTarif(r.tarification) || (net && estimate(net, p.kw));
  if (!free && r.tarification.trim()) p.text = fix(r.tarification).slice(0, 300);
  s.points.push(p);
  s.card ||= yes(r.paiement_cb);
  s.acte ||= yes(r.paiement_acte);
  s.other ||= yes(r.paiement_autre);
  s.free ||= free;
}

// One row per station. Tariffs and the operators' price texts are stored once
// in lookup tables to keep the file small (it's downloaded by every visitor).
const ops = [], opIdx = new Map();
const tariffs = [], tariffIdx = new Map();
const texts = [], textIdx = new Map();
const intern = (v, arr, idx) => {
  if (v == null || v === "") return -1;
  const k = typeof v === "string" ? v : JSON.stringify(v);
  if (!idx.has(k)) { idx.set(k, arr.length); arr.push(v); }
  return idx.get(k);
};
const out = [], details = [];
const pdcToStation = {};
let priced = 0, estimated = 0, points = 0;
for (const s of stations.values()) {
  // Sockets: one entry per (plug type, power, tariff).
  const sock = new Map();
  for (const p of s.points) {
    const t = intern(p.tariff, tariffs, tariffIdx);
    for (const type of p.types.length ? p.types : ["?"]) {
      const k = `${type}|${p.kw}|${t}`;
      const e = sock.get(k) || { type, kw: p.kw, t, count: 0 };
      e.count++;
      sock.set(k, e);
    }
    if (p.pdc) pdcToStation[p.pdc] = s.id;
  }
  points += s.points.length;
  const maxKw = Math.max(0, ...s.points.map((p) => p.kw));
  // Headline price: the most powerful point that has one (what you'd plug into).
  // A published price beats a network estimate.
  const best = s.points.filter((p) => p.tariff).sort((a, b) => !!a.tariff.est - !!b.tariff.est || b.kw - a.kw)[0];
  if (best) best.tariff.est ? estimated++ : priced++;
  const text = (best || s.points.find((p) => p.text))?.text;
  out.push([
    s.id, s.lon, s.lat, s.name, intern(s.operator, ops, opIdx), maxKw,
    (s.card ? 1 : 0) | (s.acte ? 2 : 0) | (s.other ? 4 : 0) | (s.free ? 8 : 0) | (s.motorway ? 16 : 0),
    best ? intern(best.tariff, tariffs, tariffIdx) : -1,
    [...sock.values()].filter((e) => e.type !== "?").map((e) => [e.type, e.kw, e.count, e.t]),
  ]);
  details.push([s.id, s.address === s.name ? "" : s.address, s.hours || "", intern(text, texts, textIdx)]);
}
if (out.length < 10000 && !file) {
  console.error(`Only ${out.length} stations; not writing.`);
  process.exit(1);
}
await mkdir(OUT_DIR, { recursive: true });
// What the map needs on first load:
// [id, lon, lat, name, operator#, max kW, flags (1 card, 2 pay without
// subscription, 4 other cards/apps, 8 free, 16 motorway), tariff#,
// sockets [[type, kW, count, tariff#]]]
const time = new Date().toISOString();
const attribution = "Base nationale des IRVE, transport.data.gouv.fr (Licence Ouverte 2.0)";
await writeFile(new URL("chargers.json", OUT_DIR), JSON.stringify({ format: 1, time, attribution, ops, tariffs, stations: out }));
// Loaded after the map is drawn: [id, address ("" = same as name), opening hours, operator's price text#]
await writeFile(new URL("details.json", OUT_DIR), JSON.stringify({ format: 1, time, texts, stations: details }));
// Live status maps charging points to stations; kept for update-france-status.mjs.
await writeFile(new URL("pdc-index.json", OUT_DIR), JSON.stringify(pdcToStation));
console.log(`${out.length} stations, ${points} points, ${priced} with a published price (${Math.round(priced / out.length * 100)}%), ${estimated} with a network estimate.`,
  `Skipped: ${skipped.box} outside mainland France/Corsica, ${skipped.reserved} reserved access, ${skipped.dup} duplicates.`);
