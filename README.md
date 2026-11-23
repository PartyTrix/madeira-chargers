# Madeira EV Chargers

A fast, mobile-first map of every public EV charger in Madeira and Porto Santo.
Pins are coloured by price, and each charger has one-tap **Google Maps / Apple Maps / Waze** buttons.
Payment still happens in Miio or any other charging app.

Live at **https://madeirachargers.com**. Plain HTML/CSS/JS, no build step, no npm packages, no cookies. Visit counts go to [GoatCounter](https://madeirachargers.goatcounter.com) (cookie-free, no personal data; set `GOATCOUNTER` in `app.js` to `""` to switch it off). Hosted free on GitHub Pages; the domain is registered at Cloudflare (auto-renew on).

## How it maintains itself

| What | How |
|---|---|
| Chargers + prices | Every day a GitHub Action downloads the official MOBI.E inventory from Portugal's National Access Point (all public chargers, by law under EU AFIR) and the matching price feed, keeps the ones in Madeira and Porto Santo, and commits `data/chargers.geojson` if anything changed. It refuses to save if the count suddenly drops by half, so a feed hiccup can't empty the map. |
| Deploys | Every push to `main` (and every data refresh) redeploys the site to GitHub Pages. |
| Security updates | Dependabot bumps the GitHub Actions weekly and the auto-merge workflow merges them. The site itself has no dependencies except a vendored copy of Leaflet 1.9.4 in `vendor/`. |

Run the refresh by hand any time from **Actions → Refresh data & deploy → Run workflow**.

## Prices

The price shown is the **operator's (OPC) price** published on the National Access Point for the charger's most powerful socket, turned into one comparable **≈ €/kWh** figure: per-minute and start fees are spread over a typical 20 kWh top-up (11 kW on AC, up to 75 kW on DC). Colours are quartiles of the prices in Madeira, so green means "cheap for Madeira".

On top of that operator fee the page adds what every driver pays, so the number is close to what Miio charges:

- the charging app's energy price (Miio, €/kWh),
- the MOBI.E network fee per session,
- VAT (22% in Madeira).

Each charger card shows the breakdown. These shared numbers live in `data/pricing.json` (`app_energy_kwh`, `mobie_fee_session`, `vat`, `session_kwh`); edit them there when Miio or MOBI.E change their prices.

To fix or add a price, edit `data/tariffs.json` on GitHub (pencil icon):

```json
{
  "stations":  { "FNC-00012": { "kwh": 0.30, "min": 0.05, "updated": "2026-11-23" } },
  "operators": { "Powerdot": { "kwh": 0.39, "note": "only used where MOBI.E has no price" } }
}
```

`kwh` €/kWh, `min` €/minute, `start` € per session, `free: true` for free chargers. Station keys are the MOBI.E code shown at the bottom of each charger's card.

## Search and routes

Type a place in the search bar to get a route from your location and the chargers within 1 km of it, in driving order. Place search uses [Photon](https://photon.komoot.io) and routes use the public [OSRM](https://project-osrm.org) demo server, both free and called only when someone searches. If location is blocked, the page explains how to allow it again, or you can tap your position on the map.

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

- Chargers and prices: MOBI.E data published on the [National Access Point](https://nap-portugal.imt-ip.pt/) (IMT). Free reuse with attribution, for non-commercial purposes. Credited on the page.
- Map tiles: [CARTO](https://carto.com/attributions) Voyager / Dark Matter basemaps (© OpenStreetMap contributors, © CARTO), free for non-commercial use. If the site ever gets heavy traffic, switch the URL in `app.js`.
- Font: Manrope, SIL Open Font License (`vendor/fonts/LICENSE-Manrope.txt`).
- Leaflet: BSD-2-Clause (`vendor/leaflet/LICENSE`).
- Miio's app data is not scraped.

## Licence

The code is source-available under the [PolyForm Noncommercial 1.0.0](LICENSE) licence: anyone may use, copy and change it for non-commercial purposes, but not to make money. The charger data has its own terms (non-commercial, with attribution to MOBI.E / NAP Portugal), and Leaflet keeps its BSD-2-Clause licence.
