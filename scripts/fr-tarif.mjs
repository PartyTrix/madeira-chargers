// Reads a French operator's free-text price ("tarification" in the IRVE base)
// into { kwh, min, start } in euros including VAT, or null when there is no
// usable number (a link, "Payant", "selon abonnement"...). Until the schema's
// structured prices arrive (v3, 2027) this is the best there is: about a
// fifth of charging points publish something readable.
//
// Rules, from what operators actually write (see scripts/test-fr-tarif.mjs):
// - "0,29€ / kWh", "59 cts/kWh", "AC 36cts/KWh", "0.45€TTC/kWh"
// - "+ 0,03€/min", "0,025€ / min", "6.6667€ par heure de charge" (per hour of charging)
// - "2€ + 0.59€ / kWh", "frais de lancement : 0,5 €", "prix de départ 1.25€"
// - {"fixedPrice":0,"energyPrice":0.51,...} (JSON from some back-ends)
// - The machine-made "par kwh de charge" texts are before VAT (0.3333 = €0.40)
//   and so is anything marked HT: VAT (20%) is added.
// - Parking/idle fees ("occupation hors charge", "après 3 h", "stationnement")
//   and later or night-only rates are ignored: they don't apply to a normal top-up.
const VAT = 0.2;
const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const EURO = String.raw`\s*(€|eur\b|euros?\b|e\b|cts?\b|c€|centimes?)?\s*(?:ttc|ht)?\s*`;

const num = (s) => parseFloat(s.replace(",", "."));
function euros(value, unit) {
  let v = num(value);
  if (/^c/.test(unit || "")) v /= 100; // cents
  return v;
}
// Text just before a match that means "this is not the normal price".
const LATER = /(apr[eè]s?|au[- ]del[aà]|à partir|a partir|hors charge|occupation|stationnement|charg[ée]e? mais|branch[ée]e? sans|p[ée]nalit|d[ée]passement|nuit|abonn[ée]s?\s*:|pour les abonn)\s*[^,;.]{0,40}$/;

export function parseTarif(raw) {
  if (!raw) return null;
  let s = raw.toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/â‚¬|[ĆĀ\u0080\ufffd]/g, "€").replace(/ķ/g, "é").replace(/č/g, "è").replace(/kw\/h|kwh|kw h/g, "kwh");
  if (!/\d/.test(s) || /^https?:/.test(s)) return null;

  // JSON from some back-ends: energy price and a fixed session fee.
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(raw);
      const kwh = +j.energyPrice || 0, start = +j.fixedPrice || 0;
      return kwh || start ? sane({ kwh, min: 0, start }) : null;
    } catch { return null; }
  }

  const machine = /par kwh de charge/.test(s);
  const ht = machine || (/\bht\b|hors tax/.test(s) && !/\bttc\b/.test(s));
  // Machine texts list "par défaut" / time slots; the first slot is the day rate.
  if (machine) s = s.replace(/^par d[ée]faut\s*:\s*/, "");

  const first = (re, ok = () => true) => {
    for (const m of s.matchAll(re)) {
      if (LATER.test(s.slice(Math.max(0, m.index - 60), m.index))) continue;
      // "0,09€/min de parking", "6€ par heure d'occupation": not the charge itself.
      if (/^.{0,12}(parking|stationnement|occupation|hors charge)/.test(s.slice(m.index + m[0].length))) continue;
      if (ok(m)) return m;
    }
    return null;
  };

  let kwh = 0, min = 0, start = 0;
  const mk = first(new RegExp(`${NUM}${EURO}(?:\\/|par|per|le|du|the)?\\s*kwh`, "g"));
  if (mk) {
    kwh = euros(mk[1], mk[2]);
    // "59/kWh" or "36 kWh": a bare number above 3 is in cents.
    if (!mk[2] && kwh >= 3 && kwh < 100) kwh /= 100;
  }
  const mm = first(new RegExp(`${NUM}${EURO}(?:\\/|par|per)\\s*(?:min\\b|mn\\b|minute)`, "g"));
  if (mm) min = euros(mm[1], mm[2]);
  else {
    const mh = first(new RegExp(`${NUM}${EURO}(?:\\/|par|per)\\s*(?:h|heure)\\s*(?:de charge|de recharge)`, "g"));
    if (mh) min = euros(mh[1], mh[2]) / 60;
  }
  const ms = first(new RegExp(`(?:frais de (?:lancement|connexion|session|d[ée]marrage)[^\\d]{0,25}|prix de d[ée]part\\s*|forfait de connexion[^\\d]{0,10})${NUM}${EURO}`, "g"))
    || first(new RegExp(`(?:^|[:\\s])${NUM}\\s*(€|eur\\b|euros?\\b)\\s*(?:ttc|ht)?\\s*\\+`, "g"));
  const ms2 = !ms && first(new RegExp(`${NUM}${EURO}(?:de co[uû]t fixe|de frais fixe|par session|\\/\\s*session|par charge\\b|à la connexion)`, "g"));
  if (ms || ms2) start = euros((ms || ms2)[1], (ms || ms2)[2]);

  if (!kwh && !min && !start) {
    // "0,22" or "0.39" alone: a bare €/kWh price.
    const bare = s.match(/^(?:ac\s*|dc\s*)?(0[.,]\d{2,4})\s*(€)?\s*(ttc|ht)?$/);
    if (bare) kwh = num(bare[1]);
    else return null;
  }
  const k = ht ? 1 + VAT : 1;
  return sane({ kwh: kwh * k, min: min * k, start: start * k });
}

// Drop what can't be a public charging price (typos, wrong units).
function sane(t) {
  const r = (v) => Math.round(v * 10000) / 10000;
  t = { kwh: r(t.kwh), min: r(t.min), start: r(t.start) };
  if (t.kwh > 1.5 || t.min > 1.5 || t.start > 15 || (t.kwh && t.kwh < 0.05)) return null;
  if (!t.kwh && !t.min && !t.start) return null;
  for (const k of ["kwh", "min", "start"]) if (!t[k]) delete t[k];
  return t;
}
