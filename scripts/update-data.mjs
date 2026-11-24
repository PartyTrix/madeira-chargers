// Refreshes data/chargers.geojson with every public charger in Portugal
// (mainland, Madeira, Azores), from the official MOBI.E feed published on Portugal's National
// Access Point (NAP, AFIR), with each charging point's operator price.
// No dependencies: needs Node 20+ (built-in fetch).
//
//   node scripts/update-data.mjs                 # download live data
//   node scripts/update-data.mjs static.xml status.xml # use local files instead
//
// Manual additions live in data/extra.geojson; price overrides in data/tariffs.json.

import { readFile, writeFile } from "node:fs/promises";

const NAP_URL = "https://pgm.mobie.pt/integration/nap/evChargingInfra";
const NAP_STATUS_URL = "https://pgm.mobie.pt/integration/nap/evActualStatus";
const OUT = new URL("../data/chargers.geojson", import.meta.url);
const EXTRA = new URL("../data/extra.geojson", import.meta.url);

// All of Portugal: mainland, Madeira and the Azores.
const BOX = { latMin: 32.3, latMax: 42.2, lonMin: -31.5, lonMax: -6.1 };
// Region decides the VAT rate (22% Madeira, 16% Azores, 23% mainland).
const region = (lat, lon) =>
  lat < 33.2 && lon < -16 ? "madeira" : lon < -24.5 ? "azores" : "mainland";

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
      // How you can start a session. creditCard/debitCard = pay at the charger.
      auth: [...new Set([...s.matchAll(/authenticationAndIdentificationMethods>(\w+)</g)].map((x) => x[1]))],
      // Charging-app (CEME) brands accepted, e.g. MOB, EDP, GLP. Any = works with MOBI.E apps like Miio.
      ceme: new Set([...s.matchAll(/brandsAccepted>(\w+)</g)].map((x) => x[1])).size,
      lat, lon, points, region: region(lat, lon),
    });
  }
  return sites;
}

// ---------- tariffs (NAP dynamic feed, DATEX II 3.3) ----------
// Each charging point lists its operator rates, before VAT:
//   pricePerDeliveryUnit -> € per kWh, pricePerChargingTime -> € per minute,
//   flatRate -> € per session.
function parseRates(xml, codes) {
  const out = {}; // point id -> { kwh, min, start }
  const re = /<(\w+:)?refillPointStatus\b[^>]*>([\s\S]*?)<\/\1?refillPointStatus>/g;
  for (const m of xml.matchAll(re)) {
    const p = m[2];
    const id = p.match(/\bid="([^"]+)"/)?.[1];
    if (!id || !codes.has(id.replace(/-\d+$/, ""))) continue;
    const t = {};
    for (const r of p.matchAll(/pricingPolicy>(\w+)<\/(?:\w+:)?pricingPolicy>\s*<(?:\w+:)?minimumDeliveryFee>([\d.]+)</g)) {
      const v = parseFloat(r[2]);
      if (r[1] === "pricePerDeliveryUnit") t.kwh = v;
      else if (r[1] === "pricePerChargingTime") t.min = v;
      else if (r[1] === "flatRate") t.start = v;
    }
    if (Object.keys(t).length) out[id] = t;
  }
  return out;
}

// ---------- build ----------
async function readJson(url, fallback) {
  try { return JSON.parse(await readFile(url, "utf8")); } catch { return fallback; }
}

const [napArg, statusArg] = process.argv.slice(2);
console.log("Downloading NAP inventory…");
const xml = napArg ? await readFile(napArg, "utf8") : await get(NAP_URL);
const sites = parseSites(xml);
console.log(`NAP: ${sites.length} sites in Portugal (${sites.filter((s) => s.region === "madeira").length} in Madeira)`);

let rates = {};
try {
  console.log("Downloading NAP prices…");
  const dyn = statusArg ? await readFile(statusArg, "utf8") : await get(NAP_STATUS_URL);
  rates = parseRates(dyn, new Set(sites.map((s) => s.code)));
  console.log(`Prices for ${Object.keys(rates).length} charging points`);
} catch (e) {
  console.warn(`Prices unavailable, continuing without them: ${e}`);
}

const features = sites.map((s) => {
  const sockets = s.points.map((p) => ({ type: p.type, kw: p.kw, tariff: rates[p.id] || null }));

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
      region: s.region,
      // Many sites are named only by their code: show the street instead.
      name: s.name && s.name !== s.code ? s.name : s.street || s.code,
      operator: s.operator,
      address: [s.street, s.city].filter(Boolean).join(", ") || null,
      opening_hours: s.open24h ? "24/7" : null,
      // Sites outside MOBI.E publish no payment info: leave it unknown.
      pay: !s.ceme && !s.auth.length ? null : {
        apps: s.ceme > 0,
        card: s.auth.includes("creditCard") || s.auth.includes("debitCard"),
        rfid: s.auth.includes("rfid"),
      },
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
  console.error("No chargers found in the NAP feed; not writing.");
  process.exit(1);
}

await writeFile(OUT, JSON.stringify({
  type: "FeatureCollection",
  attribution: "MOBI.E data via NAP Portugal (IMT).",
  features: all,
}) + "\n"); // compact: thousands of chargers, phones download this
const priced = features.filter((f) => f.properties.tariff).length;
console.log(`Wrote ${all.length} chargers (${features.length} MOBI.E, ${priced} with price, ${extra.length} manual).`);
