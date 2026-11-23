# Madeira EV Chargers

A fast, mobile-first map of every public EV charger in Madeira and Porto Santo.
Pins are coloured by price, and each charger has one-tap **Google Maps / Apple Maps / Waze** buttons.
Payment still happens in Miio or any other charging app.

Plain HTML/CSS/JS, no build step, no npm packages, no tracking. Hosted free on GitHub Pages.

## How it maintains itself

| What | How |
|---|---|
| Chargers + prices | Every day a GitHub Action downloads the official MOBI.E inventory from Portugal's National Access Point (all public chargers, by law under EU AFIR) and the MOBI.E operator tariff list, keeps the ones in Madeira and Porto Santo, and commits `data/chargers.geojson` if anything changed. It refuses to save if the count suddenly drops by half, so a feed hiccup can't empty the map. |
| Deploys | Every push to `main` (and every data refresh) redeploys the site to GitHub Pages. |
| Security updates | Dependabot bumps the GitHub Actions weekly and the auto-merge workflow merges them. The site itself has no dependencies except a vendored copy of Leaflet 1.9.4 in `vendor/`. |

Run the refresh by hand any time from **Actions → Refresh data & deploy → Run workflow**.

## Prices

The price shown is the **operator's (OPC) tariff** published by MOBI.E for the charger's most powerful socket, turned into one comparable **≈ €/kWh** figure: per-minute and start fees are spread over a typical 20 kWh top-up (11 kW on AC, up to 75 kW on DC). Colours are quartiles of the prices in Madeira, so green means "cheap for Madeira".

It excludes VAT, the MOBI.E network fee and the payment app's (CEME, e.g. Miio) own fee, and the page says so.

To fix or add a price, edit `data/tariffs.json` on GitHub (pencil icon):

```json
{
  "stations":  { "FNC-00012": { "kwh": 0.30, "min": 0.05, "updated": "2026-11-23" } },
  "operators": { "Powerdot": { "kwh": 0.39, "note": "only used where MOBI.E has no price" } }
}
```

`kwh` €/kWh, `min` €/minute, `start` € per session, `free: true` for free chargers. Station keys are the MOBI.E code shown at the bottom of each charger's card.

## Adding a charger

Every public charger has to be reported to the National Access Point, so new ones appear by themselves within a day. For anything else, add a feature to `data/extra.geojson`:

```json
{ "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [-16.9081, 32.6475] },
  "properties": { "id": "manual-lido-1", "name": "Lido car park", "operator": "Hotel X", "max_kw": 22,
                  "sockets": [{ "type": "Type 2", "count": 2, "kw": 22 }] } }
```

Note the order is `[longitude, latitude]`.

## Data and licences

- Chargers: MOBI.E data published on the [National Access Point](https://nap-portugal.imt-ip.pt/) (IMT). Free reuse with attribution, for non-commercial purposes. Credited on the page.
- Operator tariffs: [MOBI.E tariff list](https://www.mobie.pt/documents/42032/106470/Tarifas), © MOBI.E, used as factual reference with attribution.
- Map tiles: OpenStreetMap standard tiles, under their [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). If the site gets heavy traffic, switch the URL in `app.js` to another free tile provider.
- Leaflet: BSD-2-Clause (`vendor/leaflet/LICENSE`).
- Miio's app data is not scraped.
