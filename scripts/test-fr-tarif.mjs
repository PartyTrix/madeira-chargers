// Checks the French price-text reader on real examples from the IRVE base.
//   node scripts/test-fr-tarif.mjs
import { parseTarif } from "./fr-tarif.mjs";
const cases = [
  ["0,29€ / kWh", { kwh: 0.29 }],
  ["59 cts/kWh", { kwh: 0.59 }],
  ["AC 36cts/KWh", { kwh: 0.36 }],
  ["0.45€TTC/kWh", { kwh: 0.45 }],
  ["0,42 € HT / kWh", { kwh: 0.504 }],
  ["Bornes rapides: 2€ + 0.59€ / kWh", { kwh: 0.59, start: 2 }],
  ["0,35€/kWh + 0,03€/min entre 6h et 18h, 15€ la session entre 18h et 6h", { kwh: 0.35, min: 0.03 }],
  ["entre 08:00 et 20:00 : 0.30916667€ par kwh de charge, 3.75€ par heure d'occupation hors charge, entre 20:00 et 08:00 : 0.30916667€ par kwh de charge", { kwh: 0.371 }],
  ["par défaut : 0.4667€ par kwh de charge, par défaut : 6.6667€ par heure d'occupation hors charge, 0.4667€ par kwh de charge, 6.6667€ par heure de charge", { kwh: 0.56, min: 0.1333 }],
  ["entre 07:00 et 22:00 : 0.3333\u0080 par kwh de charge", { kwh: 0.4 }],
  ['{"fixedPrice":0,"energyPrice":0.51,"minimumBilling":0,"matrix":[]}', { kwh: 0.51 }],
  ["0,49E/kWh puis 30 min de parking gratuit une fois la charge terminée. Aprè 30 min, 0,09E/min de parking supplémentaire. 1E de cout fixe par session de recharge.", { kwh: 0.49, start: 1 }],
  ["0,6116 €/kWh, puis 2,5896 €/h de branchement après 3 h", { kwh: 0.6116 }],
  ["0.4916", { kwh: 0.4916 }],
  ["Frais de lancement de la charge : 0,5 € H Frais de consommation énergie :  0,42 € HT / kWh", { kwh: 0.504, start: 0.6 }],
  ["https://belib.paris", null],
  ["Payant", null],
  ["Tarification au kWh plus frais de connexion éventuelles en fonction de l abonnement détenu", null],
  ["2.5€ à la connexion et 2€/Kwh", null],
];
let bad = 0;
for (const [text, want] of cases) {
  const got = parseTarif(text);
  if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; console.error("FAIL", JSON.stringify(text), "got", JSON.stringify(got), "want", JSON.stringify(want)); }
}
console.log(`${cases.length - bad}/${cases.length} price texts read as expected`);
process.exit(bad ? 1 : 0);
