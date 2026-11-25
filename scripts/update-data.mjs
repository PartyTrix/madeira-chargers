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

// ---------- OpenStreetMap: chargers outside MOBI.E ----------
// Tesla Superchargers (many open to all cars) and other fast chargers that
// aren't on MOBI.E, so the NAP doesn't list them. No prices. OSM data is ODbL
// (© OpenStreetMap contributors); credited on the page and in the README.
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
// Bounding boxes (mainland, Madeira, Azores) instead of the country area:
// the area lookup is slow and busy servers time out on it.
const OSM_QUERY = `[out:json][timeout:120];
(
  nwr["amenity"="charging_station"](36.8,-9.6,42.2,-6.1);
  nwr["amenity"="charging_station"](32.3,-17.4,33.2,-16.2);
  nwr["amenity"="charging_station"](36.8,-31.4,39.8,-24.9);
);
out center tags;`;
// Rough outline of mainland Portugal (lat, lon), generous on the coast side.
// The mainland box above also covers bits of Spain; this keeps them out.
const MAINLAND = [
  [41.87, -9.6], [41.87, -8.87], [42.05, -8.65], [42.16, -8.2], [41.9, -8.05], [41.83, -7.9],
  [41.95, -7.2], [41.99, -6.6], [41.68, -6.18], [41.5, -6.2], [41.38, -6.3], [41.2, -6.6],
  [41.05, -6.78], [40.95, -6.85], [40.6, -6.8], [40.0, -6.85], [39.66, -7.0], [39.66, -7.53],
  [39.45, -7.3], [39.05, -7.0], [38.85, -7.02], [38.75, -7.2], [38.45, -7.3], [38.2, -6.93],
  [38.05, -6.93], [37.95, -7.25], [37.55, -7.45], [37.4, -7.45], [37.17, -7.4], [36.8, -7.4],
  [36.8, -9.6],
];
function inPolygon(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPortugal = (lat, lon) => lon < -12 || lat < 34 || inPolygon(lat, lon, MAINLAND);
const NEAR_MOBIE_M = 150; // an OSM station this close to a MOBI.E site is that site
const OSM_MIN_KW = 50;    // non-Tesla OSM stations: only fast ones (slow ones are mostly MOBI.E or private)

async function overpass() {
  for (let round = 0; round < 3; round++) {
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "User-Agent": "madeira-chargers (GitHub Actions; daily)", "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(OSM_QUERY),
          signal: AbortSignal.timeout(150_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!Array.isArray(json.elements)) throw new Error("no elements");
        return json.elements;
      } catch (e) {
        console.warn(`Overpass ${url}: ${e}`);
      }
    }
    await new Promise((r) => setTimeout(r, 30_000 * (round + 1)));
  }
  throw new Error("all Overpass servers failed");
}

const OSM_SOCKETS = {
  type2_combo: "CCS", chademo: "CHAdeMO", type2: "Type 2", type2_cable: "Type 2",
  tesla_supercharger: "Tesla", tesla_supercharger_ccs: "CCS", type1_combo: "CCS1",
};
const kwOf = (v) => {
  const m = String(v || "").match(/([\d.]+)\s*(kW|W)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return /^W$/i.test(m[2] || "") || n > 2000 ? n / 1000 : n;
};

function osmFeatures(elements, mobieSites) {
  // Grid of MOBI.E sites for a quick "is there one nearby" check.
  const cell = (lat, lon) => `${Math.floor(lat * 100)}:${Math.floor(lon * 100)}`;
  const grid = new Map();
  for (const s of mobieSites) (grid.get(cell(s.lat, s.lon)) || grid.set(cell(s.lat, s.lon), []).get(cell(s.lat, s.lon))).push(s);
  const nearMobie = (lat, lon) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
      for (const s of grid.get(cell(lat + dy / 100, lon + dx / 100)) || [])
        if (Math.hypot((s.lat - lat) * 111_320, (s.lon - lon) * 111_320 * Math.cos(lat * Math.PI / 180)) < NEAR_MOBIE_M) return true;
    return false;
  };
  const out = [];
  for (const e of elements) {
    const t = e.tags || {};
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat == null || !(lat >= BOX.latMin && lat <= BOX.latMax && lon >= BOX.lonMin && lon <= BOX.lonMax)) continue;
    if (!inPortugal(lat, lon)) continue;
    if (/^(private|no|customers|permit|delivery)$/.test(t.access || "")) continue;
    if (t["disused:amenity"] || /^(construction|planned|disused)$/.test(t.lifecycle || "")) continue;
    const who = [t.brand, t.operator, t.network, t.name].filter(Boolean).join(" ");
    const tesla = /tesla/i.test(who);
    const sockets = [];
    for (const [k, v] of Object.entries(t)) {
      const m = k.match(/^socket:([a-z0-9_]+)$/);
      if (!m || !OSM_SOCKETS[m[1]]) continue;
      const count = parseInt(v, 10) || 1;
      sockets.push({ type: OSM_SOCKETS[m[1]], kw: kwOf(t[`socket:${m[1]}:output`]) || null, tariff: null, count });
    }
    const maxKw = Math.max(0, ...sockets.map((s) => s.kw || 0), kwOf(t["charging_station:output"]) || 0) || (tesla ? 150 : null);
    if (!tesla && !(maxKw >= OSM_MIN_KW)) continue;
    if (nearMobie(lat, lon)) continue;
    if (tesla && !sockets.length) sockets.push({ type: "Tesla", kw: maxKw, tariff: null, count: parseInt(t.capacity, 10) || 1 });
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [+lon.toFixed(6), +lat.toFixed(6)] },
      properties: {
        id: `osm-${e.type[0]}${e.id}`,
        region: region(lat, lon),
        name: t.name || (tesla ? "Tesla Supercharger" : t.operator || t.brand || "EV charger"),
        operator: t.operator || t.brand || t.network || null,
        address: [t["addr:street"] && `${t["addr:street"]}${t["addr:housenumber"] ? " " + t["addr:housenumber"] : ""}`, t["addr:city"]].filter(Boolean).join(", ") || null,
        opening_hours: t.opening_hours === "24/7" ? "24/7" : null,
        pay: null,
        max_kw: maxKw,
        sockets,
        tariff: null,
        network: tesla ? "Tesla" : null,
        source: "osm",
      },
    });
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

const previous = await readJson(OUT, { features: [] });
let osm;
try {
  console.log("Downloading OpenStreetMap chargers…");
  osm = osmFeatures(await overpass(), sites);
  console.log(`OSM: ${osm.length} chargers outside MOBI.E (${osm.filter((f) => f.properties.network === "Tesla").length} Tesla)`);
} catch (e) {
  // Overpass is often busy: keep yesterday's OSM chargers rather than none.
  osm = previous.features.filter((f) => f.properties.source === "osm");
  console.warn(`OSM unavailable (${e}); keeping ${osm.length} from the last run.`);
}

const extra = (await readJson(EXTRA, { features: [] })).features.map((f) => ({
  ...f, properties: { ...f.properties, source: "manual" },
}));
const all = [...features, ...osm, ...extra].sort((a, b) => String(a.properties.id).localeCompare(String(b.properties.id)));

// Safety net: never wipe the map because a feed hiccuped.
const prevMobie = previous.features.filter((f) => f.properties.source === "mobie").length;
if (prevMobie > 10 && features.length < prevMobie * 0.5) {
  console.error(`Refusing to write: only ${features.length} chargers vs ${previous.features.length} before.`);
  process.exit(1);
}
if (!features.length) {
  console.error("No chargers found in the NAP feed; not writing.");
  process.exit(1);
}

await writeFile(OUT, JSON.stringify({
  type: "FeatureCollection",
  attribution: "MOBI.E data via NAP Portugal (IMT). Chargers outside MOBI.E: © OpenStreetMap contributors (ODbL).",
  features: all,
}) + "\n"); // compact: thousands of chargers, phones download this
const priced = features.filter((f) => f.properties.tariff).length;
console.log(`Wrote ${all.length} chargers (${features.length} MOBI.E, ${priced} with price, ${osm.length} OpenStreetMap, ${extra.length} manual).`);
