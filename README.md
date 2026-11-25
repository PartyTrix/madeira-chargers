# Madeira EV Chargers

A fast, mobile-first map of every public EV charger in Portugal on the MOBI.E network: Madeira (the default view), the Azores and the mainland.
Pins are coloured by price, and each charger has one-tap **Google Maps / Apple Maps / Waze** buttons.
Payment still happens in Miio or any other charging app.

Live at **https://madeirachargers.com** (opens on Madeira) and **https://chargeportugal.com** (the same map with its own name, blue look, Portugal-wide text and FAQ, opening on the mainland). `?view=portugal`, `?view=azores` or `?view=madeira` overrides where either site opens; the parameter is removed from the address bar on load. Plain HTML/CSS/JS, no build step, no npm packages, no cookies. Visit counts go to [GoatCounter](https://madeirachargers.goatcounter.com) (cookie-free, no personal data; set `GOATCOUNTER` in `app.js` to `""` to switch it off). Hosted free on GitHub Pages; the domain is registered at Cloudflare (auto-renew on).

## How it maintains itself

| What | How |
|---|---|
| Chargers + prices | Every day a GitHub Action downloads the official MOBI.E inventory from Portugal's National Access Point (all public chargers, by law under EU AFIR) and the matching price feed, keeps every one in Portugal (about 8,800 sites), and commits `data/chargers.geojson` if anything changed. It refuses to save if the count suddenly drops by half, so a feed hiccup can't empty the map. |
| Deploys | Every push to `main` (and every data refresh) redeploys the site to GitHub Pages. |
| Live status | Every 15 minutes `.github/workflows/status.yml` runs `scripts/update-status.mjs`, which reads MOBI.E's live feed (refreshed by MOBI.E every few minutes) and redeploys with `data/status.json`: free / in use / out of order plugs per site. The file is deployed, never committed. The page ignores it once it is over 75 minutes old, and shows the time on each charger. |
| Security updates | Dependabot bumps the GitHub Actions weekly and the auto-merge workflow merges them. The site itself has no dependencies except a vendored copy of Leaflet 1.9.4 in `vendor/`. |

Run the refresh by hand any time from **Actions → Refresh data & deploy → Run workflow**.

## Two sites, one code base

`node scripts/build-site.mjs madeira _site` builds madeirachargers.com, which is the repo as it is. `node scripts/build-site.mjs portugal _site` builds chargeportugal.com from the same files plus `sites/portugal/`:

| File | What it changes |
|---|---|
| `site.json` | Small text swaps in `index.html` (start view, search hint, favicon colour) |
| `head.html` | Everything between `<!-- site:head -->` markers: title, description, canonical, share tags, JSON-LD |
| `about.html` | The visible About/FAQ between `<!-- site:about -->` markers (keep it in sync with the FAQ JSON-LD in `head.html`) |
| `site.css` | Blue colours, appended to `style.css` |
| `files/` | Icons, share image, manifest, robots.txt, sitemap.xml |

The build fails if a marker or a `site.json` text can't be found, or if the Portugal page still points its canonical or share tags at another domain, and this repo's workflow builds both sites on every run, so a change here that breaks chargeportugal.com shows up as a red run.

GitHub Pages serves one custom domain per repo, so chargeportugal.com is published by the separate **PartyTrix/chargeportugal** repo. It contains only `sites/portugal/deploy.yml` (as `.github/workflows/deploy.yml`), which checks out this repo every 15 minutes, fetches the live plug status, builds the Portugal site and deploys it. Nothing to maintain there; run it by hand from its Actions tab to publish a change straight away. Each site's About section links to the other. GoatCounter counts both in one dashboard; chargeportugal.com page views show under `/portugal/`.

## Prices

The price shown is the **operator's (OPC) price** published on the National Access Point for the charger's most powerful socket, turned into one comparable **≈ €/kWh** figure: per-minute and start fees are spread over a typical 20 kWh top-up (11 kW on AC, up to 75 kW on DC). Colours are quartiles of the prices in the charger's own region, so green means "cheap for Madeira" (or the Azores, or the mainland).

On top of that operator fee the page adds what every driver pays, so the number is close to what Miio charges:

- Miio's energy price (€0.304/kWh in Nov 2026),
- grid access (€0.078/kWh) and electricity tax (€0.001/kWh),
- VAT of the charger's region (23% mainland, 22% Madeira, 16% Azores).

These match the itemised session breakdown Miio shows.

Each charger card shows the breakdown. These shared numbers live in `data/pricing.json` (`app_energy_kwh`, `grid_access_kwh`, `excise_kwh`, `app_activation`, `mobie_fee_session`, `vat`, `session_kwh`); edit them there when Miio or MOBI.E change their prices.

To fix or add a price, edit `data/tariffs.json` on GitHub (pencil icon):

```json
{
  "stations":  { "FNC-00012": { "kwh": 0.30, "min": 0.05, "updated": "2026-11-23" } },
  "operators": { "Powerdot": { "kwh": 0.39, "note": "only used where MOBI.E has no price" } }
}
```

`kwh` €/kWh, `min` €/minute, `start` € per session, `free: true` for free chargers. Station keys are the MOBI.E code shown at the bottom of each charger's card.

## Filters

Chips above the map: 50 kW+, has a price, free now (live status), plug type (CCS, Type 2, CHAdeMO), pay by card and motorway. "Pay by card" uses the payment methods operators publish on the NAP and is hidden on Madeira (no card payment there in practice). "Motorway" has no flag in the feed: `isMotorway()` in `app.js` reads names and addresses like "Área de Serviço", "(A2) KM 148" or "A25 - AS Vilar Formoso" (~280 sites).

## Search and routes

Type a place in the search bar to get a route from your location and the chargers within 1 km of it, in driving order. Enter your car's range in the route panel (remembered on that phone) and it suggests fast-charging stops: leaving full, keeping 10% in reserve, charging 10 to 80% at each stop, and picking the cheapest fast charger in the last stretch of each leg. Place search uses [Photon](https://photon.komoot.io) and routes use the public [OSRM](https://project-osrm.org) demo server, both free and called only when someone searches. If location is blocked, the page explains how to allow it again, or you can tap your position on the map.

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
- Map tiles: [OpenStreetMap](https://www.openstreetmap.org/copyright) standard tiles (© OpenStreetMap contributors), used under the OSM tile usage policy with attribution; dark mode dims them with a CSS filter. CARTO's basemaps started requiring an API key in Nov 2026. If the site ever gets heavy traffic, switch the URL in `app.js`.
- Font: Manrope, SIL Open Font License (`vendor/fonts/LICENSE-Manrope.txt`).
- Leaflet: BSD-2-Clause (`vendor/leaflet/LICENSE`).
- Miio's app data is not scraped.

## Licence

The code is source-available under the [PolyForm Noncommercial 1.0.0](LICENSE) licence: anyone may use, copy and change it for non-commercial purposes, but not to make money. The charger data has its own terms (non-commercial, with attribution to MOBI.E / NAP Portugal), and Leaflet keeps its BSD-2-Clause licence.
