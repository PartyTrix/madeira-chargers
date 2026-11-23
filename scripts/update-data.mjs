// Refreshes data/chargers.geojson from OpenStreetMap (Overpass API).
// No dependencies: needs Node 20+ (built-in fetch).
// Run: node scripts/update-data.mjs
//
// Manual additions live in data/extra.geojson and are merged in.
// Prices live in data/tariffs.json and are applied in the browser.

import { readFile, writeFile } from "node:fs/promises";

const OUT = new URL("../data/chargers.geojson", import.meta.url);
const EXTRA = new URL("../data/extra.geojson", import.meta.url);

// Madeira + Porto Santo (autonomous region PT-30).
const QUERY = `
[out:json][timeout:90];
area["ISO3166-2"="PT-30"]->.a;
nwr["amenity"="charging_station"](area.a);
out center tags;
`;

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// Socket keys we care about, mapped to short labels.
const SOCKETS = {
  type2_combo: "CCS",
  chademo: "CHAdeMO",
  type2: "Type 2",
  type2_cable: "Type 2 (cable)",
  schuko: "Schuko",
  tesla_supercharger: "Tesla",
  tesla_supercharger_ccs: "Tesla CCS",
};

async function overpass() {
  let lastErr;
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "madeira-chargers-static-site (GitHub Actions)",
        },
        body: new URLSearchParams({ data: QUERY }),
      });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      const json = await res.json();
      console.log(`Got ${json.elements.length} elements from ${url}`);
      return json.elements;
    } catch (e) {
      console.warn(String(e));
      lastErr = e;
    }
  }
  throw lastErr;
}

function parseKw(v) {
  if (!v) return null;
  // "50 kW", "22kW", "7.4", "150 kW;50 kW"
  const nums = String(v)
    .split(/[;,]/)
    .map((s) => parseFloat(s.replace(",", ".")))
    .filter((n) => !Number.isNaN(n));
  if (!nums.length) return null;
  let kw = Math.max(...nums);
  if (/\bW\b/.test(v) && !/kW/i.test(v) && kw > 1000) kw = kw / 1000;
  return kw;
}

function toFeature(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;

  const sockets = [];
  let maxKw = parseKw(t["charging_station:output"]) ?? parseKw(t["maxpower"]);
  for (const [key, label] of Object.entries(SOCKETS)) {
    const count = t[`socket:${key}`];
    if (!count || count === "no") continue;
    const kw = parseKw(t[`socket:${key}:output`]);
    if (kw && (!maxKw || kw > maxKw)) maxKw = kw;
    sockets.push({ type: label, count: parseInt(count, 10) || 1, kw });
  }

  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [+lon.toFixed(6), +lat.toFixed(6)] },
    properties: {
      id: `osm-${el.type}-${el.id}`,
      name: t.name || t["name:pt"] || null,
      operator: t.operator || null,
      network: t.network || null,
      ref: t["ref:mobie"] || t.ref || null,
      capacity: t.capacity ? parseInt(t.capacity, 10) || null : null,
      max_kw: maxKw,
      sockets,
      opening_hours: t.opening_hours || null,
      fee: t.fee || null,
      charge: t.charge || null,
      address: [t["addr:street"], t["addr:housenumber"], t["addr:city"]]
        .filter(Boolean)
        .join(" ") || null,
      source: "osm",
    },
  };
}

async function readJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch {
    return fallback;
  }
}

const elements = await overpass();
const osm = elements.map(toFeature).filter(Boolean);
const extra = (await readJson(EXTRA, { features: [] })).features.map((f) => ({
  ...f,
  properties: { ...f.properties, source: "manual" },
}));

const features = [...osm, ...extra].sort((a, b) =>
  a.properties.id.localeCompare(b.properties.id)
);

// Safety net: never wipe the map because an API hiccuped.
const previous = await readJson(OUT, { features: [] });
if (previous.features.length > 10 && osm.length < previous.features.length * 0.5) {
  console.error(
    `Refusing to write: only ${osm.length} OSM chargers vs ${previous.features.length} before.`
  );
  process.exit(1);
}

const out = {
  type: "FeatureCollection",
  attribution: "© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)",
  features,
};
await writeFile(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`Wrote ${features.length} chargers (${osm.length} OSM, ${extra.length} manual).`);
