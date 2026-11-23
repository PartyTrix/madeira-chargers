# Madeira EV Chargers

A fast, mobile-first map of every public EV charger in Madeira and Porto Santo.
Pins are coloured by price, and each charger has one-tap **Google Maps / Apple Maps / Waze** buttons.
Payment still happens in Miio or any other charging app.

Plain HTML/CSS/JS, no build step, no npm packages, no tracking. Hosted free on GitHub Pages.

## How it maintains itself

| What | How |
|---|---|
| Charger locations | Every Monday a GitHub Action pulls all `amenity=charging_station` in Madeira from OpenStreetMap and commits `data/chargers.geojson` if anything changed. It refuses to save if the count suddenly drops by half, so an API hiccup can't empty the map. |
| Deploys | Every push to `main` (and every data refresh) redeploys the site to GitHub Pages. |
| Security updates | Dependabot bumps the GitHub Actions weekly and the auto-merge workflow merges them. The site itself has no dependencies except a vendored copy of Leaflet 1.9.4 in `vendor/`. |

Run the refresh by hand any time from **Actions → Refresh data & deploy → Run workflow**.

## Adding a price

Edit `data/tariffs.json` on GitHub (pencil icon) and commit. The site updates within a minute or two.

```json
{
  "operators": {
    "EEM": { "kwh": 0.20, "min": 0.01, "start": 0.00, "updated": "2026-11-23", "note": "AC posts, Funchal" }
  },
  "stations": {
    "osm-node-123456789": { "kwh": 0.39, "updated": "2026-11-23" },
    "FNC-00012": { "kwh": 0.30, "min": 0.05, "updated": "2026-11-23" }
  }
}
```

- `kwh` €/kWh, `min` €/minute, `start` € per session, `free: true` for free chargers.
- An `operators` key matches any charger whose operator or network *contains* that text.
- A `stations` key is the charger ID shown at the bottom of its card, or its Mobi.E code.
- The map shows one comparable **≈ €/kWh** figure: per-minute and start fees are spread over a typical 20 kWh top-up (11 kW on AC, up to 75 kW on DC). Colours are quartiles of the known prices, so green means "cheap for Madeira".
- Prices exclude the payment app's (CEME) own fee and Mobi.E's network fee. Visitors are told to check their app.

## Adding a charger

Best: add it on [openstreetmap.org](https://www.openstreetmap.org) with `amenity=charging_station` (plus `operator`, `socket:type2_combo=*`, `socket:type2_combo:output=50 kW`, etc.). It shows up here after the next Monday refresh and helps every other map too.

Quick: add a feature to `data/extra.geojson`:

```json
{ "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [-16.9081, 32.6475] },
  "properties": { "id": "manual-lido-1", "name": "Lido car park", "operator": "EEM", "max_kw": 22,
                  "sockets": [{ "type": "Type 2", "count": 2, "kw": 22 }] } }
```

Note the order is `[longitude, latitude]`. Manual chargers are merged in on the next refresh (or run the workflow by hand).

## Data and licences

- Locations: © OpenStreetMap contributors, [ODbL 1.0](https://www.openstreetmap.org/copyright). Credited on the page.
- Map tiles: OpenStreetMap standard tiles, under their [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). If the site gets heavy traffic, switch the URL in `app.js` to another free tile provider.
- Leaflet: BSD-2-Clause (`vendor/leaflet/LICENSE`).
- Miio data is not scraped: its app data isn't published under an open licence.
