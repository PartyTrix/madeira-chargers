// Refreshes data/chargers.geojson with every public charger in Madeira and
// Porto Santo, from the official MOBI.E feed published on Portugal's National
// Access Point (NAP, AFIR), plus each socket's operator (OPC) tariff from MOBI.E.
// No dependencies: needs Node 20+ (built-in fetch).
//
//   node scripts/update-data.mjs                 # download live data
//   node scripts/update-data.mjs nap.xml tar.csv # use local files instead
//
// Manual additions live in data/extra.geojson; price overrides in data/tariffs.json.

import { readFile, writeFile } from "node:fs/promises";

const NAP_URL = "https://pgm.mobie.pt/integration/nap/evChargingInfra";
const TARIFF_URL = "https://www.mobie.pt/documents/42032/106470/Tarifas";
const OUT = new URL("../data/chargers.geojson", import.meta.url);
const EXTRA = new URL("../data/extra.geojson", import.meta.url);

// Madeira + Porto Santo bounding box.
const BOX = { latMin: 32.3, latMax: 33.2, lonMin: -17.4, lonMax: -16.2 };

const CONNECTORS = {
  iec62196T2COMBO: "CCS",
  chademo: "CHAdeMO",
  iec62196T2: "Type 2",
  domesticF: "Schuko",
  domesticE: "Schuko",
  iec62196T1COMBO: "CCS1",
  iec62196T1: "Type 1",
  teslaS: "Tesla",
};

// ---------- download ----------
async function get(url, binary = false) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "madeira-chargers (GitHub Actions)" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (e) {
      console.warn(`${url} attempt ${attempt}: ${e}`);
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

// MOBI.E's document server sometimes answers with an HTML page instead of
// the CSV. Try the download form, and follow a tariff link if one is on the page.
async function getTariffCsv() {
  const H = { "User-Agent": "madeira-chargers (GitHub Actions)", Accept: "text/csv,*/*" };
  for (const url of [TARIFF_URL, TARIFF_URL + "?download=true"]) {
    const res = await fetch(url, { headers: H }).catch((e) => ({ ok: false, statusText: String(e) }));
    if (!res.ok) { console.warn(`${url}: ${res.status} ${res.statusText}`); continue; }
    const body = decode(Buffer.from(await res.arrayBuffer()));
    if (body.includes("UID_TOMADA")) return body;
    console.warn(`${url} (${res.headers.get("content-type")}) is not the CSV. Title: ${body.match(/<title>([^<]*)/i)?.[1]}`);
    const links = [...new Set(body.match(/\/documents\/[^"'\s<>]*/g) || [])].filter((l) => /tarif/i.test(l));
    console.warn(`Tariff-like links on that page: ${links.slice(0, 10).join(" ")}`);
    for (const l of links) {
      const r2 = await fetch(new URL(l.replace(/&amp;/g, "&"), "https://www.mobie.pt"), { headers: H }).catch(() => null);
      if (!r2?.ok) continue;
      const b2 = decode(Buffer.from(await r2.arrayBuffer()));
      if (b2.includes("UID_TOMADA")) { console.log(`Tariffs found at ${l}`); return b2; }
    }
  }
  throw new Error("Could not download the MOBI.E tariff CSV");
}

function decode(buf) {
  // The tariff CSV has been seen as both UTF-8 and Windows-1252.
  const utf = buf.toString("utf8");
  return utf.includes("�") ? new TextDecoder("windows-1252").decode(buf) : utf;
}

// ---------- NAP (DATEX II 3.3) ----------
const tag = (s, name) => {
  const m = s.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? m[1] : null;
};
const tags = (s, name) =>
  [...s.matchAll(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "g"))].map((m) => m[1]);
const text = (s) => (s ? (s.match(/<value(?:\s[^>]*)?>([\s\S]*?)<\/value>/)?.[1] ?? s).trim() : null);
const unxml = (s) => s == null ? null :
  s?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function parseSites(xml) {
  const sites = [];
  const re = /<(\w+:)?energyInfrastructureSite\b[^>]*>([\s\S]*?)<\/\1?energyInfrastructureSite>/g;
  for (const m of xml.matchAll(re)) {
    const s = m[2];
    const lat = parseFloat(tag(s, "latitude"));
    const lon = parseFloat(tag(s, "longitude"));
    if (!(lat >= BOX.latMin && lat <= BOX.latMax && lon >= BOX.lonMin && lon <= BOX.lonMax)) continue;

    // Site-level fields sit before the first station.
    const head = s.split(/<(?:\w+:)?energyInfrastructureStation\b/)[0];
    const code = text(tag(head, "externalIdentifier"));
    const operatorBlock = tag(head, "operator") || "";
    const addr = tag(head, "address") || "";
    const points = [];
    for (const pm of s.matchAll(/<(\w+:)?refillPoint\b([^>]*)>([\s\S]*?)<\/\1?refillPoint>/g)) {
      const id = pm[2].match(/\bid="([^"]+)"/)?.[1] || "";
      const p = pm[3];
      for (const c of tags(p, "connector")) {
        const watts = parseFloat(tag(c, "maxPowerAtSocket"));
        points.push({
          id,
          type: CONNECTORS[tag(c, "connectorType")] || tag(c, "connectorType"),
          kw: Number.isFinite(watts) ? Math.round(watts / 100) / 10 : null,
          cable: tag(c, "connectorFormat") === "cableMode3",
        });
      }
    }
    sites.push({
      code,
      name: unxml(text(tag(head, "name"))),
      operator: unxml(text(tag(operatorBlock, "name"))),
      operatorCode: tag(operatorBlock, "nationalOrganisationNumber"),
      street: unxml(text(tag(addr, "text"))),
      city: unxml(text(tag(addr, "city"))),
      open24h: /OpenAllHours/.test(head),
      lat, lon, points,
    });
  }
  return sites;
}

// ---------- MOBI.E tariffs (CSV) ----------
function parseCsv(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const sep = lines[0].includes(";") ? ";" : ",";
  const head = lines[0].split(sep).map((h) => h.trim().replace(/^"|"$/g, "").replace(/^﻿/, ""));
  return lines.slice(1).map((l) => {
    const cells = l.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
}

const num = (s) => parseFloat(String(s).replace(",", "."));

// '€ 0.1 /kWh', '€ 0.261 /charge', '€ 0.03 /min até 120 min', '€ 0.2 /min após 60 min'
function parseTariffText(s) {
  const m = String(s).match(/([\d]+(?:[.,]\d+)?)\s*\/\s*(\w+)/);
  if (!m) return null;
  return {
    eur: num(m[1]),
    unit: m[2].toLowerCase(),
    from: num(String(s).match(/ap[oó]s\s+([\d.,]+)\s*min/i)?.[1] ?? 0),
  };
}

// station code -> socket number -> { kwh, min, start, minLater }
function buildTariffs(rows, codes) {
  const out = {};
  for (const r of rows) {
    if (!codes.has(r.ID)) continue;
    if ((r.TIPO_TARIFARIO || "REGULAR") !== "REGULAR") continue;
    const p = parseTariffText(r.TARIFA);
    if (!p) continue;
    const parts = String(r.UID_TOMADA).split("-");
    const sock = parts.length >= 3 ? String(parseInt(parts.at(-2), 10)) : String(parseInt(r.UID_TOMADA, 10));
    const t = ((out[r.ID] ||= {})[sock] ||= {});
    if (r.TIPO_TARIFA === "ENERGY") t.kwh = Math.max(t.kwh || 0, p.eur);
    else if (r.TIPO_TARIFA === "FLAT") t.start = Math.max(t.start || 0, p.eur);
    else if (r.TIPO_TARIFA === "TIME") {
      if (p.from === 0) t.min = Math.max(t.min || 0, p.eur);
      else t.later = `+€${p.eur}/min after ${p.from} min`;
    }
  }
  return out;
}

// ---------- build ----------
async function readJson(url, fallback) {
  try { return JSON.parse(await readFile(url, "utf8")); } catch { return fallback; }
}

const [napArg, csvArg] = process.argv.slice(2);
console.log("Downloading NAP inventory…");
const xml = napArg ? await readFile(napArg, "utf8") : await get(NAP_URL);
const sites = parseSites(xml);
console.log(`NAP: ${sites.length} sites in Madeira`);

let tariffRows = [];
try {
  const csv = csvArg ? decode(await readFile(csvArg)) : await getTariffCsv();
  tariffRows = parseCsv(csv);
  console.log(`Tariff CSV: ${tariffRows.length} rows. Columns: ${Object.keys(tariffRows[0] || {}).join(", ")}`);
  const sample = tariffRows.filter((r) => /^(RBR|FNC|CML)-/.test(r.ID)).slice(0, 4);
  console.log("Sample Madeira rows:", JSON.stringify(sample));
} catch (e) {
  console.warn(`Tariffs unavailable, continuing without them: ${e}`);
}
const tariffs = buildTariffs(tariffRows, new Set(sites.map((s) => s.code)));

const features = sites.map((s) => {
  const t = tariffs[s.code] || {};
  const sockets = s.points.map((p) => {
    const n = String(parseInt(p.id.split("-").at(-1), 10));
    return { type: p.type, kw: p.kw, tariff: t[n] || null };
  });
  // If socket numbers don't line up but the whole site has one tariff, use it.
  const distinct = [...new Set(Object.values(t).map((x) => JSON.stringify(x)))];
  if (distinct.length === 1) for (const so of sockets) so.tariff ||= JSON.parse(distinct[0]);

  const maxKw = Math.max(0, ...sockets.map((x) => x.kw || 0)) || null;
  // Headline price = the tariff of the most powerful socket.
  const best = [...sockets].sort((a, b) => (b.kw || 0) - (a.kw || 0)).find((x) => x.tariff);
  // Group identical sockets: "2× CCS 60 kW".
  const grouped = {};
  for (const so of sockets) {
    const k = `${so.type}|${so.kw}|${JSON.stringify(so.tariff)}`;
    (grouped[k] ||= { ...so, count: 0 }).count++;
  }
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [+s.lon.toFixed(6), +s.lat.toFixed(6)] },
    properties: {
      id: s.code,
      ref: s.code,
      // Many sites are named only by their code: show the street instead.
      name: s.name && s.name !== s.code ? s.name : s.street || s.code,
      operator: s.operator,
      address: [s.street, s.city].filter(Boolean).join(", ") || null,
      opening_hours: s.open24h ? "24/7" : null,
      max_kw: maxKw,
      sockets: Object.values(grouped),
      tariff: best?.tariff || null,
      source: "mobie",
    },
  };
});

const extra = (await readJson(EXTRA, { features: [] })).features.map((f) => ({
  ...f, properties: { ...f.properties, source: "manual" },
}));
const all = [...features, ...extra].sort((a, b) => String(a.properties.id).localeCompare(String(b.properties.id)));

// Safety net: never wipe the map because a feed hiccuped.
const previous = await readJson(OUT, { features: [] });
if (previous.features.length > 10 && features.length < previous.features.length * 0.5) {
  console.error(`Refusing to write: only ${features.length} chargers vs ${previous.features.length} before.`);
  process.exit(1);
}
if (!features.length) {
  console.error("No Madeira chargers found in the NAP feed; not writing.");
  process.exit(1);
}

await writeFile(OUT, JSON.stringify({
  type: "FeatureCollection",
  attribution: "MOBI.E data via NAP Portugal (IMT). Tariffs © MOBI.E.",
  features: all,
}, null, 1) + "\n");
const priced = features.filter((f) => f.properties.tariff).length;
console.log(`Wrote ${all.length} chargers (${features.length} MOBI.E, ${priced} with price, ${extra.length} manual).`);
