/* Madeira Chargers / Charge Portugal / Fast Charge France: static map, no cookies.
   One code base, three sites; scripts/build-site.mjs makes each. */
(() => {
  "use strict";

  // Language: the Portuguese page (/pt/) loads i18n-pt.js first, which sets
  // window.I18N = { "English text with {0} placeholders": "Portuguese" }.
  // Texts tagged with tr are looked up there, falling back to the English.
  // scripts/i18n-keys.mjs --check lists anything missing.
  const I18N = window.I18N || {};
  const LANG = document.documentElement.lang.slice(0, 2) || "en";
  const LOCALE = { pt: "pt-PT", fr: "fr-FR" }[LANG] || [];
  function tr(strings, ...vals) {
    let key = strings[0];
    vals.forEach((_, i) => { key += `{${i}}` + strings[i + 1]; });
    return (I18N[key] ?? key).replace(/\{(\d+)\}/g, (_, i) => vals[i]);
  }
  // Pages live at / and /pt/; data and assets are relative to the site root.
  const ROOT = document.documentElement.dataset.root || "";

  // Usage statistics (GoatCounter, cookie-free). Empty = off.
  const GOATCOUNTER = "madeirachargers";

  // Which site this is (set on <html data-site> by scripts/build-site.mjs).
  // France has its own data (scripts/update-france.mjs) and price model.
  const SITE = document.documentElement.dataset.site || "madeira";
  const FR = SITE === "france";
  const MADEIRA = [[32.62, -17.30], [33.10, -16.25]]; // includes Porto Santo
  // Search area: all of Portugal (mainland, Madeira, Azores), or mainland France and Corsica.
  const BBOX = FR ? "-5.3,41.3,9.7,51.2" : "-31.5,32.3,-6.1,42.2";
  const COUNTRY = FR ? tr`France` : tr`Portugal`;
  const REGIONS = FR ? {
    france: { name: tr`France`, bounds: [[42.4, -4.8], [51.1, 8.2]] },
  } : {
    madeira: { name: tr`Madeira`, bounds: MADEIRA },
    azores: { name: tr`the Azores`, bounds: [[36.9, -31.3], [39.8, -24.9]] },
    mainland: { name: tr`mainland Portugal`, bounds: [[36.9, -9.6], [42.2, -6.1]] },
  };
  const regionAt = FR ? () => "france"
    : (lat, lon) => (lat < 33.2 && lon < -16 ? "madeira" : lon < -24.5 ? "azores" : "mainland");
  const MAX_DOTS = 1500; // more than this on screen: thin them out (cheapest per spot)
  const PALETTE = ["--p1", "--p2", "--p3", "--p4"];
  const BANDS = [(r) => tr`Cheap for ${r}`, () => tr`Below average`, () => tr`Above average`, (r) => tr`Expensive for ${r}`];
  const LABEL_ZOOM = 9;      // price tags from island level; overlapping ones stay dots (cheapest win)
  const ROUTE_KM = 1.0;
  const ULTRA_NET = /\b(ionity|tesla|supercharger|fastned)\b/i;      // a charger within this distance of the road counts as "on the route"
  const $ = (id) => document.getElementById(id);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const canHover = matchMedia("(hover: hover)").matches;
  const dark = matchMedia("(prefers-color-scheme: dark)");

  const state = {
    all: [],
    cuts: [],
    pricing: null,
    filters: { fast: false, priced: false, free: false, card: false, motorway: false },
    plug: "",
    // Slider limits, one per sort tab. null = no limit.
    limits: { price: null, power: null, distance: null },
    // Tapped price colour: show bands 0..band (cheap up to this one); null = all.
    // The colours are the price filter: there is no price slider.
    band: null,
    sort: "price",
    me: null,
    selected: null,
    route: null,
    returnTo: "list", // which view "back" goes to from a charger
    labels: load("labels") !== "0",
    range: +load("range") || 0, // car's real-world range in km, for route stops; 0 = not set
    plan: load("plan") === "fastest" ? "fastest" : "cheapest", // route stops: lowest cost or least time
    pickingStart: false,
  };

  // Side-panel layout (computers, and phones held sideways): matches the CSS.
  const sideMQ = matchMedia("(min-width: 900px), (orientation: landscape) and (max-height: 520px) and (min-width: 560px)");

  // Keyboard open: keep the search results inside the visible area (iOS
  // overlays the keyboard instead of resizing the page).
  const vv = window.visualViewport;
  if (vv) {
    const setVvh = () => document.documentElement.style.setProperty("--vvh", vv.height + "px");
    vv.addEventListener("resize", setVvh);
    setVvh();
  }
  // iOS scrolls the whole page up to reveal a focused input and can leave it
  // there after the keyboard closes; put it back.
  document.addEventListener("focusout", () => setTimeout(() => {
    if (!document.activeElement?.matches?.("input")) window.scrollTo(0, 0);
  }, 50));

  // iOS Safari ignores touch-action for pinch on some versions: block its page
  // zoom gestures (the map uses touch events, so map pinch still works).
  for (const ev of ["gesturestart", "gesturechange"])
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

  // ---------- map ----------
  // Which region the map opens on. Each site sets its own default on <html
  // data-start> (madeirachargers.com: Madeira, chargeportugal.com: the
  // mainland, see sites/). ?view=portugal|azores|madeira overrides it; the
  // parameter is dropped from the address bar right away so shared links stay
  // clean, and the canonical URL never has it.
  const startParams = new URLSearchParams(location.search);
  const viewParam = FR ? null : { portugal: "mainland", mainland: "mainland", azores: "azores", madeira: "madeira" }[(startParams.get("view") || "").toLowerCase()];
  const startView = viewParam
    || (REGIONS[document.documentElement.dataset.start] ? document.documentElement.dataset.start : Object.keys(REGIONS)[0]);
  if (startParams.has("view")) {
    startParams.delete("view");
    const qs = startParams.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  }
  const map = L.map("map", {
    zoomControl: false,
    renderer: L.canvas({ tolerance: 12 }), // generous tap target for dots
  }).fitBounds(REGIONS[startView].bounds, sideMQ.matches ? { paddingTopLeft: [0, 100] } : { paddingTopLeft: [0, 120], paddingBottomRight: [0, 160] });
  // Phones pinch to zoom (like Google Maps); computers get +/- buttons.
  if (matchMedia("(min-width: 900px)").matches) L.control.zoom({ position: "bottomright" }).addTo(map);
  let tiles;
  // OpenStreetMap's own tiles: no key needed. Dark mode dims them with a CSS filter.
  function setTiles() {
    tiles?.remove();
    tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
  }
  setTiles();
  dark.addEventListener?.("change", () => { setTiles(); render(); });
  // Rotation, Safari toolbar showing/hiding, keyboard: re-measure the map.
  addEventListener("resize", () => map.invalidateSize({ pan: false }));
  sideMQ.addEventListener?.("change", () => { $("panel").classList.remove("open"); $("panel").style.transform = ""; });
  const routeLayer = L.layerGroup().addTo(map);
  const stopLayer = L.layerGroup().addTo(map); // numbered charging stops on a route
  const layer = L.layerGroup().addTo(map);

  // ---------- data ----------
  $("list").innerHTML = '<li class="skeleton"></li>'.repeat(4);
  const getJson = (f) => fetch(ROOT + f, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  Promise.all(FR ? [
    fetch(ROOT + "data/chargers.json", { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(r.status);
      const lm = Date.parse(r.headers.get("last-modified"));
      if (lm) state.dataTime = new Date(lm);
      return r.json();
    }).then(decodeFrance),
    {}, null,
    getJson("data/status.json").catch(() => null),
  ] : [
    fetch(ROOT + "data/chargers.geojson", { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(r.status);
      // When the daily price update last ran (GitHub Pages sends Last-Modified).
      const lm = Date.parse(r.headers.get("last-modified"));
      if (lm) state.dataTime = new Date(lm);
      return r.json();
    }),
    getJson("data/tariffs.json").catch(() => ({})),
    getJson("data/pricing.json").catch(() => null),
    getJson("data/status.json").catch(() => null),
  ])
    .then(([geo, tariffs, pricing, status]) => {
      state.pricing = pricing;
      state.all = geo.features.map((f) => enrich(f, tariffs));
      applyStatus(status);
      colourByPrice(state.all);
      syncSlider();
      render();
      hintBands();
      startNearMe();
      const id = decodeURIComponent(location.hash.slice(1));
      const linked = id && state.all.find((c) => c.id === id);
      if (linked) select(linked, { fly: true });
      if (FR) loadFranceDetails();
    })
    .catch((e) => {
      console.error(e);
      $("list-title").textContent = tr`Couldn't load the chargers`;
      $("list").innerHTML = `<li class="empty"><span>${tr`Check your connection, then try again.`}</span>
        <button class="chip" id="retry">${tr`Try again`}</button></li>`;
      $("retry").onclick = () => location.reload();
    });
  track("pageview");
  if (viewParam) track("start-view", startView);

  // France: data/chargers.json is compact (one array per station, shared
  // tables for operators and tariffs; see scripts/update-france.mjs). Turn it
  // into the same shape as the Portuguese GeoJSON features.
  function decodeFrance(d) {
    const tariff = (i) => (i >= 0 ? d.tariffs[i] : null);
    return {
      features: d.stations.map(([id, lon, lat, name, operator, maxKw, pay, t, sockets]) => ({
        geometry: { coordinates: [lon, lat] },
        properties: {
          id, name, operator: d.ops[operator] || null, max_kw: maxKw, region: "france", source: "irve",
          pay: { card: !!(pay & 1), adhoc: !!(pay & 2), other: !!(pay & 4) }, motorway: !!(pay & 16),
          tariff: tariff(t),
          sockets: sockets.map(([type, kw, count, st]) => ({ type, kw, count, tariff: tariff(st) })),
        },
      })),
    };
  }
  // Addresses, opening hours and the operators' own price texts come in a
  // second file after the map is drawn, so the first load stays small.
  function loadFranceDetails() {
    getJson("data/details.json").then((d) => {
      const byId = new Map(state.all.map((c) => [c.id, c]));
      d.stations.forEach(([id, address, hours, text]) => {
        const c = byId.get(id);
        if (!c) return;
        c.address = address || null;
        c.opening_hours = hours || null;
        c.priceText = text >= 0 ? d.texts[text] : null;
      });
      state.detailsLoaded = true;
      if (state.selected) showDetail(state.selected);
    }).catch(() => {});
  }

  function findTariff(p, tariffs) {
    const st = tariffs.stations || {};
    if (st[p.id]) return st[p.id];
    if (p.tariff) return p.tariff; // official operator price from the NAP feed
    const hay = `${p.operator || ""} ${p.network || ""}`.toLowerCase();
    for (const [key, t] of Object.entries(tariffs.operators || {})) {
      if (key.startsWith("_")) continue;
      if (hay.includes(key.toLowerCase())) return t;
    }
    return null;
  }

  // The operator's fee as one comparable "€ per kWh", for a typical top-up
  // (20 kWh at realistic power: 11 kW on AC, up to 75 kW on DC).
  function operatorPerKwh(t, maxKw) {
    if (!t) return null;
    if (t.free) return 0;
    const kwh = +t.kwh || 0, min = +t.min || 0, start = +t.start || 0;
    if (!kwh && !min && !start) return null;
    const fast = (maxKw || 0) >= 50;
    const rate = fast ? Math.min(maxKw, 75) : Math.min(maxKw || 11, 11);
    const session = sessionKwh();
    const minutes = (session / rate) * 60;
    return kwh + (min * minutes + start) / session;
  }
  const sessionKwh = () => state.pricing?.session_kwh || 20;

  // What a driver actually pays, the way Miio bills it: operator fee + the
  // app's energy price + grid access and excise per kWh + fixed fees, then VAT.
  // Components live in data/pricing.json.
  const vatFor = (region) => state.pricing?.vat_by_region?.[region] ?? state.pricing?.vat ?? 0;
  function breakdown(opc, region) {
    const p = state.pricing;
    if (opc == null || !p) return null;
    const n = sessionKwh();
    const operator = opc * n;
    const energy = (p.app_energy_kwh || 0) * n + (p.app_activation || 0);
    const fees = ((p.grid_access_kwh || 0) + (p.excise_kwh || 0)) * n + (p.mobie_fee_session || 0);
    const net = operator + energy + fees;
    const rate = vatFor(region);
    const vat = net * rate;
    return { n, operator, energy, fees, vat, rate, total: net + vat, perKwh: (net + vat) / n };
  }

  function enrich(f, tariffs) {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const tariff = findTariff(p, tariffs);
    const opc = operatorPerKwh(tariff, p.max_kw);
    const region = p.region || regionAt(lat, lon);
    const bd = breakdown(opc, region);
    return {
      ...p, region,
      lat, lon, tariff, opc, bd,
      eff: bd ? bd.perKwh : opc, // the number shown everywhere
      fast: (p.max_kw || 0) >= 50,
      // Ultra-fast: 200 kW+, or a network built for motorway trips (Ionity, Tesla, Fastned).
      ultra: (p.max_kw || 0) >= 200 || ((p.max_kw || 0) >= 100 && ULTRA_NET.test(`${p.operator || ""} ${p.network || ""} ${p.name || ""}`)),
      // Bank card at the charger. Not offered in Madeira in practice, whatever
      // the feed says, so only counted elsewhere.
      card: !!p.pay?.card && region !== "madeira",
      motorway: FR ? p.motorway : isMotorway(p),
      plugs: new Set((p.sockets || []).map((s) => s.type)),
      mobie: !FR && /^([A-Z]{3}-)?[A-Z]{3}-\d{5}$/.test(p.id || ""),
      // France: a network's usual price, not this charger's own (see sites/france/networks.json).
      est: !!p.tariff?.est,
      isFree: !!p.tariff?.free,
      pay: p.pay || {},
      payUnknown: p.source === "mobie" && !p.pay,
      title: tidyName(p.name || p.operator || p.network || "EV charger"),
      operator: shortOp(p.operator),
    };
  }

  // Live status from data/status.json (refreshed every 15 min by
  // .github/workflows/status.yml): [free, in use, out of order] plugs per site.
  // Older than STATUS_MAX_AGE it is ignored rather than shown as if current.
  const STATUS_MAX_AGE = 75 * 60 * 1000;
  function applyStatus(status) {
    const t = Date.parse(status?.time);
    if (!status?.sites || !(Date.now() - t < STATUS_MAX_AGE)) return;
    state.statusTime = new Date(t);
    for (const c of state.all) {
      const s = status.sites[c.id];
      if (s) c.live = { free: s[0], busy: s[1], broken: s[2] };
    }
    document.querySelector('[data-filter="free"]').hidden = false;
  }
  const liveTotal = (c) => c.live.free + c.live.busy + c.live.broken;
  const liveShort = (c) => !c.live ? null
    : c.live.free ? tr`${c.live.free} of ${liveTotal(c)} available`
      : c.live.busy ? tr`all in use` : tr`out of order`;
  const liveLong = (c) => (c.live.free
    ? (liveTotal(c) === 1 ? tr`1 of 1 plug available` : tr`${c.live.free} of ${liveTotal(c)} plugs available`)
      + (c.live.broken ? " · " + tr`${c.live.broken} out of order` : "")
    : c.live.busy ? tr`All plugs in use` : tr`Out of order`);
  const hhmm = (d) => d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
  // "4 min ago", "2 h ago"; older: "today 04:17", "24 Nov".
  function ago(d) {
    const m = Math.round((Date.now() - d) / 60000);
    if (m < 1) return tr`just now`;
    if (m < 60) return tr`${m} min ago`;
    if (m < 180) return tr`${Math.round(m / 60)} h ago`;
    return new Date().toDateString() === d.toDateString() ? tr`today ${hhmm(d)}`
      : d.toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
  }
  const STATUS_STALE = 20 * 60 * 1000; // older than this: "may have changed"

  // Motorway service areas and junctions: the feed has no flag for it, so read
  // the name and address ("Área de Serviço", "(A2) KM 148", "A25 - AS Vilar
  // Formoso"). Street addresses are skipped so "Rua ... A 2" doesn't count.
  const MOTORWAY = /[áa]rea de servi[çc]o|\bautoe?-?strada\b|(?:^|[\s(,-])A0?\d{1,2}(?=[\s),\-]|$)(?!\s*\d)|\bAS\b/;
  function isMotorway(p) {
    if (/^(rua|avenida|av\.|travessa|largo|praça|estrada municipal)\b/i.test(p.address || "")) return false;
    return MOTORWAY.test(`${p.name || ""} | ${p.address || ""}`);
  }

  // Colour into quartiles of the known prices per region, so "cheap" means
  // cheap for Madeira, the Azores or the mainland (VAT and prices differ).
  function colourByPrice(items) {
    state.cutsByRegion = {};
    for (const r of Object.keys(REGIONS)) {
      const known = items.filter((c) => c.region === r && c.eff != null).map((c) => c.eff).sort((a, b) => a - b);
      const q = (p) => known[Math.min(known.length - 1, Math.floor(p * known.length))];
      state.cutsByRegion[r] = known.length ? [q(0.25), q(0.5), q(0.75)] : [];
    }
    for (const c of items) {
      if (c.eff == null) { c.colourVar = "--p0"; c.band = null; continue; }
      const cuts = state.cutsByRegion[c.region];
      let i = 0;
      while (i < cuts.length && c.eff > cuts[i]) i++;
      c.colourVar = PALETTE[i];
      c.band = i;
    }
  }
  const viewRegion = () => { const m = map.getCenter(); return regionAt(m.lat, m.lng); };

  let scaleKey = "";
  function renderScale() {
    const region = viewRegion();
    state.cuts = state.cutsByRegion?.[region] || [];
    const key = region + "|" + state.band;
    if (key === scaleKey) return;
    scaleKey = key;
    $("scale").setAttribute("aria-label", tr`Price colours for ${REGIONS[region].name}`);
    const [a, b, c] = state.cuts;
    if (a == null) { $("scale").hidden = true; return; }
    const ranges = [`≤ ${euro(a)}`, `≤ ${euro(b)}`, `≤ ${euro(c)}`, `> ${euro(c)}`];
    const sel = state.band;
    // Each colour is a button: tap one to see everything up to that price, tap
    // it again (or "no price") for all.
    $("scale").innerHTML = [...ranges, tr`no price`].map((r, i) => {
      const off = sel != null && i > sel;
      return `<button type="button" data-band="${i}" aria-pressed="${sel === i}" class="${off ? "off" : ""}${sel === i ? " on" : ""}" style="--c:var(${i < 4 ? PALETTE[i] : "--p0"})">${r}</button>`;
    }).join("");
    $("scale").classList.toggle("picked", sel != null);
  }

  const anyFilter = () => Object.values(state.filters).some(Boolean) || !!state.plug || state.band != null;
  $("scale").addEventListener("click", (e) => {
    const b = e.target.closest("[data-band]");
    if (!b) return;
    const i = +b.dataset.band;
    state.band = state.band === i || i === 4 ? null : i;
    if (state.band != null) track("band-" + i);
    save("bandTapped", "1");
    render();
  });
  // Until someone has tapped a colour once, the colours pop briefly after loading.
  function hintBands() {
    if (load("bandTapped") || $("scale").hidden) return;
    setTimeout(() => {
      $("scale").classList.add("hint");
      setTimeout(() => $("scale").classList.remove("hint"), 1500);
    }, 900);
  }

  // ---------- map rendering ----------
  function visible() {
    const f = state.filters, l = state.limits;
    return state.all.filter((c) => (!f.fast || c.fast) && (!f.priced || c.eff != null)
      && (!f.card || c.card) && (!f.free || c.live?.free > 0) && (!f.motorway || c.motorway) && (!state.plug || c.plugs.has(state.plug))
      && (state.band == null || (c.band != null && c.band <= state.band))
      && (l.power == null || (c.max_kw || 0) >= l.power)
      && (l.distance == null || !state.me || dist(c) <= l.distance));
  }

  // ---------- slider: one per tab (max price, min power, max distance) ----------
  const POWER_STOPS = [0, 7, 11, 22, 50, 75, 100, 150];
  const DIST_STOPS = [1, 2, 3, 5, 10, 15, 20, 30, 50, Infinity];
  const range = $("limit-range");
  function describe(kind, v) {
    if (kind === "price") return v == null ? tr`Any price` : tr`Up to ${euro(v)}/kWh`;
    if (kind === "power") return v == null ? tr`Any charging speed` : tr`At least ${v} kW`;
    return v == null ? tr`Any distance` : tr`Within ${v} km`;
  }
  function syncSlider() {
    const kind = state.sort, v = state.limits[kind];
    // Cheapest: the price colours below are the filter, so no slider.
    $("limit").hidden = kind === "price";
    {
      const stops = kind === "power" ? POWER_STOPS : DIST_STOPS;
      Object.assign(range, { min: 0, max: stops.length - 1, step: 1 });
      const i = v == null ? (kind === "power" ? 0 : stops.length - 1) : stops.indexOf(v);
      range.value = i;
    }
    range.disabled = kind === "distance" && !state.me;
    range.setAttribute("aria-valuetext", describe(kind, v));
    $("limit-label").textContent = range.disabled ? tr`Share your location first` : describe(kind, v);
    $("limit-clear").hidden = v == null;
    $("limit").classList.toggle("on", v != null);
    const others = Object.entries(state.limits).filter(([k, x]) => k !== kind && x != null && !(k === "distance" && !state.me));
    $("limit-also").hidden = !others.length;
    $("limit-also").textContent = others.length ? tr`Also:` + " " + others.map(([k, x]) => describe(k, x)).join(", ") : "";
    renderScale();
  }
  range.addEventListener("input", () => {
    const kind = state.sort, i = +range.value;
    if (kind === "power") state.limits.power = i === 0 ? null : POWER_STOPS[i];
    else state.limits.distance = DIST_STOPS[i] === Infinity ? null : DIST_STOPS[i];
    syncSlider();
    render();
  });
  range.addEventListener("change", () => track("slider-" + state.sort));
  $("limit-clear").addEventListener("click", () => { state.limits[state.sort] = null; syncSlider(); render(); });

  // Only chargers on (or just off) screen are drawn. When thousands are on
  // screen (all of mainland Portugal), keep the cheapest one per few pixels.
  function onScreen(items) {
    const view = map.getBounds().pad(0.2);
    let out = items.filter((c) => view.contains([c.lat, c.lon]));
    // Zoomed out, dots would pile into one blob: keep one per spot, the best
    // for the current tab (cheapest, or fastest), so the map stays readable.
    const cell = map.getZoom() <= 10 && out.length > 300 ? 22 : out.length > MAX_DOTS ? 12 : 0;
    if (cell) {
      const better = state.sort === "power"
        ? (a, b) => (a.max_kw || 0) > (b.max_kw || 0) || ((a.max_kw || 0) === (b.max_kw || 0) && (a.eff ?? 99) < (b.eff ?? 99))
        : (a, b) => (a.eff ?? 99) < (b.eff ?? 99) || ((a.eff ?? 99) === (b.eff ?? 99) && (a.max_kw || 0) > (b.max_kw || 0));
      const seen = new Map();
      for (const c of out) {
        const pt = map.latLngToLayerPoint([c.lat, c.lon]);
        const k = `${Math.round(pt.x / cell)},${Math.round(pt.y / cell)}`;
        const prev = seen.get(k);
        if (!prev || c.id === state.selected?.id || (prev.id !== state.selected?.id && better(c, prev))) seen.set(k, c);
      }
      out = [...seen.values()];
    }
    return out;
  }
  const colourCache = {};
  const colour = (v) => (colourCache[v] ??= css(v));

  function render() {
    layer.clearLayers();
    for (const k in colourCache) delete colourCache[k]; // theme may have changed
    renderScale();
    const items = onScreen(visible());
    const tags = state.labels && map.getZoom() >= LABEL_ZOOM ? placeTags(items) : new Set();
    for (const c of items) if (!tags.has(c.id)) addDot(c);
    for (const c of items) if (tags.has(c.id)) addTag(c);
    renderList();
    renderDataLine();
    if (state.route) renderRouteList();
  }

  // Greedy label placement: the selected, on-route and cheapest chargers get a
  // price tag first; a tag that would overlap one already placed stays a dot.
  function placeTags(items) {
    const placed = [];
    const out = new Set();
    // Ultra-fast stations get their tag before cheaper chargers nearby.
    const rank = (c) => (c.id === state.selected?.id ? 4 : 0) + (state.route?.on.has(c.id) ? 2 : 0) + (c.ultra ? 1 : 0);
    const view = map.getBounds().pad(0.1);
    const priority = items.filter((c) => c.eff != null && view.contains([c.lat, c.lon])).sort((a, b) => rank(b) - rank(a) || a.eff - b.eff);
    for (const c of priority) {
      const pt = map.latLngToLayerPoint([c.lat, c.lon]);
      // Real tag sizes; zoomed out, tags are compact (smaller, no bolt) so more fit.
      const compact = map.getZoom() < 13;
      const w = compact ? 10 + priceTag(c).length * 6.5 + (c.ultra ? 14 : 0) : 16 + priceTag(c).length * 8 + (c.ultra ? 22 : c.fast ? 12 : 0);
      const h = compact ? 19 : 26, tip = compact ? 5 : 7;
      const box = { l: pt.x - w / 2, r: pt.x + w / 2, t: pt.y - h - tip, b: pt.y };
      if (placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)) continue;
      placed.push(box);
      out.add(c.id);
    }
    return out;
  }

  function addTag(c) {
    const sel = state.selected?.id === c.id;
    const m = L.marker([c.lat, c.lon], {
      icon: L.divIcon({
        className: "pin-wrap", iconSize: null,
        html: map.getZoom() < 13 && !sel
          ? `<span class="pin-tag compact${c.est ? " approx" : ""}${c.ultra ? " ultra" : ""}" style="--c:var(${c.colourVar})">${c.ultra ? '<svg class="b2"><use href="#i-bolt2"/></svg>' : ""}${priceTag(c)}</span>`
          : `<span class="pin-tag${sel ? " selected" : ""}${c.est ? " approx" : ""}${c.ultra ? " ultra" : ""}" style="--c:var(${c.colourVar})">${c.ultra ? '<svg class="b2"><use href="#i-bolt2"/></svg>' : c.fast ? '<svg><use href="#i-bolt"/></svg>' : ""}${priceTag(c)}</span>`,
      }),
      keyboard: true, title: c.title, riseOnHover: true, zIndexOffset: sel ? 1000 : 0,
    });
    m.on("click", (e) => { L.DomEvent.stop(e); select(c); });
    m.addTo(layer);
  }

  function addDot(c) {
    const sel = state.selected?.id === c.id;
    const m = L.circleMarker([c.lat, c.lon], {
      radius: sel ? 12 : c.ultra ? 10 : c.fast ? 9 : 7,
      color: sel ? colour("--focus") : c.ultra ? colour("--ultra") : c.fast ? colour("--ink") : "#ffffff",
      weight: sel ? 4 : c.ultra ? 3.5 : 2,
      fillColor: colour(c.colourVar), fillOpacity: 1,
      bubblingMouseEvents: false, // a tap on a pin must not also count as a tap on the map
    });
    if (canHover) m.bindTooltip(`${esc(c.title)}${c.eff != null ? " · " + (c.isFree ? tr`Free` : priceTag(c) + "/kWh") : ""}`);
    m.on("click", (e) => { L.DomEvent.stop(e); select(c); });
    m.addTo(layer);
  }

  // ---------- list ----------
  const sorters = {
    price: (a, b) => (a.eff ?? 99) - (b.eff ?? 99) || (b.max_kw || 0) - (a.max_kw || 0),
    power: (a, b) => (b.max_kw || 0) - (a.max_kw || 0) || (a.eff ?? 99) - (b.eff ?? 99),
    distance: (a, b) => dist(a) - dist(b),
  };

  const LIST_MAX = 25;
  function renderList() {
    const bounds = map.getBounds();
    const inView = visible().filter((c) => bounds.contains([c.lat, c.lon]));
    inView.sort(sorters[state.sort] || sorters.price);

    const n = inView.length;
    $("list-title").textContent = !n ? tr`No chargers in view`
      : state.sort === "power" ? (n === 1 ? tr`Fastest of 1 charger in view` : tr`Fastest of ${n} chargers in view`)
      : state.sort === "distance" ? (n === 1 ? tr`Nearest of 1 charger in view` : tr`Nearest of ${n} chargers in view`)
      : n === 1 ? tr`Cheapest of 1 charger in view` : tr`Cheapest of ${n} chargers in view`;

    if (!inView.length) {
      const filtered = anyFilter() || Object.values(state.limits).some((v) => v != null);
      $("list").innerHTML = `<li class="empty"><strong>${filtered ? tr`Nothing here with these filters` : tr`Nothing here`}</strong>
        <span>${filtered ? tr`Loosen the slider or a filter, or zoom out to see more.` : tr`Zoom out to see more.`}</span>
        <button class="chip" id="zoom-all">${tr`Show all of ${REGIONS[viewRegion()].name}`}</button></li>`;
      $("zoom-all").onclick = () => map.fitBounds(REGIONS[viewRegion()].bounds);
      return;
    }
    // A short list: the best few, then the coffee link and the FAQ are a short scroll away.
    fillRows($("list"), inView.slice(0, LIST_MAX), (c) => subline(c), "list");
    if (n > LIST_MAX) $("list").insertAdjacentHTML("beforeend",
      `<li class="more">${tr`Showing the top ${LIST_MAX} of ${n}. Zoom in or tap a price colour to narrow it down.`}</li>`);
  }

  function fillRows(list, items, sub, from, rowClass = () => "") {
    list.innerHTML = items.map((c, i) => `
      <li class="row ${rowClass(c)}" data-i="${i}" tabindex="0">
        <span class="badge${c.eff == null ? " none" : ""}${c.fast ? " fast" : ""}${c.ultra ? " ultra" : ""}" style="--c:var(${c.colourVar})">
          <svg><use href="#${c.ultra ? "i-bolt2" : c.fast ? "i-bolt" : "i-plug"}"/></svg>
        </span>
        <span class="row-main">
          <span class="row-name">${esc(c.title)}</span>
          <span class="row-sub">${esc(sub(c))}</span>
        </span>
        ${c.eff != null
          ? `<span class="row-price${c.est ? " approx" : ""}">${c.isFree ? tr`Free` : priceTag(c)}<small>${c.isFree ? "" : c.est ? tr`usual price` : FR ? tr`per kWh` : tr`est. /kWh`}</small></span>`
          : `<span class="row-price none">${tr`No price data`}</span>`}
      </li>`).join("");
    const pick = (e) => {
      const li = e.target.closest(".row");
      if (li) { state.returnTo = from; select(items[+li.dataset.i], { fly: true }); }
    };
    list.onclick = pick;
    list.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(e); } };
  }

  function subline(c) {
    const bits = [];
    if (c.max_kw) bits.push(`${fmtKw(c.max_kw)} kW`);
    const types = [...new Set((c.sockets || []).map((s) => s.type))];
    if (types.length) bits.push(types.join(", "));
    if (state.me) bits.push(tr`${dist(c).toFixed(1)} km away`);
    if (c.live) bits.push(liveShort(c));
    return bits.join(" · ") || c.operator || tr`Details unknown`;
  }

  // ---------- views ----------
  const VIEWS = ["list-view", "route-view", "help-view", "detail-view"];
  function showView(id) {
    for (const v of VIEWS) $(v).hidden = v !== id;
  }

  // ---------- detail ----------
  function select(c, { fly = false } = {}) {
    state.selected = c;
    history.replaceState(null, "", `#${encodeURIComponent(c.id)}`);
    if (fly) map.setView([c.lat, c.lon], Math.max(map.getZoom(), 15));
    render();
    showDetail(c);
    track("charger", c.id);
  }

  function navLinks(lat, lon, label, from) {
    const dest = `${lat},${lon}`;
    const origin = from ? `${(+from[0]).toFixed(6)},${(+from[1]).toFixed(6)}` : null;
    const links = {
      google: ["Google Maps", `https://www.google.com/maps/dir/?api=1${origin ? `&origin=${origin}` : ""}&destination=${dest}`],
      apple: ["Apple Maps", `https://maps.apple.com/?${origin ? `saddr=${origin}&` : ""}daddr=${dest}`],
      waze: ["Waze", `https://waze.com/ul?ll=${dest}&navigate=yes`],
      other: [tr`Other app`, `geo:${dest}?q=${dest}(${encodeURIComponent(label)})`],
    };
    const order = isIOS ? ["apple", "google", "waze"] : isAndroid ? ["google", "waze", "other"] : ["google", "apple", "waze"];
    return order.map((k) => [...links[k], k]);
  }
  const navLink = ([name, href, key], cls = "") =>
    `<a class="${cls}" data-track="navigate-${key}" href="${href}" ${href.startsWith("geo:") ? "" : 'target="_blank" rel="noopener"'}>${cls === "nav-primary" ? '<svg><use href="#i-nav"/></svg>' + tr`Navigate with ${name}` : name}</a>`;

  const MOBIE_GUIDE = "https://www.mobie.pt/en/mobility/are-you-travelling-through-portugal-in-an-electric-vehicle";
  const MIIO = isAndroid
    ? "https://play.google.com/store/search?q=miio&c=apps"
    : "https://apps.apple.com/pt/app/miio/id1462182013";

  // France: the price drivers pay without a subscription (incl. VAT), either
  // published for this charger or the network's usual price.
  function priceSectionFrance(c) {
    const t = c.tariff;
    const own = c.priceText ? `<details class="note"><summary><svg><use href="#i-info"/></svg>${tr`The operator's price text`}</summary>
      <p class="quote">${esc(c.priceText)}</p></details>` : "";
    if (c.eff == null) {
      return `<div class="price-box none">${tr`No price published for this charger. Check the charger or your app before you start.`}</div>${own}`;
    }
    if (c.isFree) {
      return `<div class="price-box" style="--c:var(${c.colourVar})"><div class="big">${tr`Free`}</div>
        <div class="parts">${tr`The operator says charging here is free.`}</div></div>
        <p class="price-note">${tr`Free chargers are often meant for customers of the shop, hotel or car dealer, and may only work in opening hours.`}</p>`;
    }
    const parts = [];
    if (t.kwh) parts.push(`${euro(t.kwh)}/kWh`);
    if (t.min) parts.push(`${euro(t.min)}/min`);
    if (t.start) parts.push(tr`${euro(t.start)} per session`);
    const session = sessionKwh();
    return `
      <div class="price-box${c.est ? " approx" : ""}" style="--c:var(${c.colourVar})">
        <div class="big">${priceTag(c)}<small> /kWh</small></div>
        <div class="band">${BANDS[c.band](REGIONS[c.region].name)}</div>
        <div class="parts">${c.est
          ? (t.est[0] === t.est[1] ? tr`Usual ${esc(t.net)} price without subscription: ${euro(t.est[0])}/kWh` : tr`Usual ${esc(t.net)} price without subscription: ${euro(t.est[0])} to ${euro(t.est[1])}/kWh`)
          : esc(parts.join(" + ")) + (t.min || t.start ? " · " + tr`≈ ${euro(c.eff * session)} for ${session} kWh` : "")}</div>
      </div>
      <p class="price-note">${c.est
        ? tr`This charger doesn't publish its own price, so this is the network's usual pay-as-you-go price, incl. VAT. Check the charger or the app before you start.`
        : tr`Published by the operator for paying without a subscription, incl. VAT. Prices can change; check the charger or the app before you start.`}</p>
      ${own}`;
  }

  function priceSection(c) {
    if (FR) return priceSectionFrance(c);
    const t = c.tariff;
    const p = state.pricing;
    if (c.eff == null) {
      return `<div class="price-box none"><span class="conf none">${tr`No price data`}</span>
        ${c.source === "osm" ? tr`This network doesn't share its prices with MOBI.E. Check its own app before you start.`
          : tr`The operator hasn't published a price. That doesn't mean it's free: check your app before you start.`}</div>`;
    }
    const parts = [];
    if (t?.kwh) parts.push(`${euro(t.kwh)}/kWh`);
    if (t?.min) parts.push(`${euro(t.min)}/min`);
    if (t?.start) parts.push(tr`${euro(t.start)} per session`);
    const bd = c.bd;
    return `
      <div class="price-box" style="--c:var(${c.colourVar})">
        <div class="big">${euro(c.eff)}<small> /kWh</small></div>
        <div class="band">${BANDS[c.band](REGIONS[c.region].name)}</div>
        <div class="parts">${bd ? tr`≈ ${euro(bd.total)} for ${bd.n} kWh, incl. VAT` : esc(parts.join(" + "))}</div>
      </div>
      <p class="trust"><span class="conf">${c.isFree ? tr`Operator says free` : tr`Estimate · Miio tariff`}</span>
        ${state.dataTime ? tr`Operator's price from MOBI.E, checked ${ago(state.dataTime)}.` : tr`Operator's price from MOBI.E.`}
        ${tr`Other apps charge a different energy price, so your total may differ. Your app shows the final price before you start; parking or idle fees aren't included.`}</p>
      ${bd ? `<details class="note"><summary><svg><use href="#i-info"/></svg>${tr`Estimated total. How is it worked out?`}</summary>
        <table class="breakdown">
          <tr><td>${tr`Charger operator (${esc(parts.join(" + "))})`}</td><td>${euro(bd.operator)}</td></tr>
          <tr><td>${tr`Energy from ${esc(p.app_name || "Miio")} (${euro(p.app_energy_kwh)}/kWh)`}</td><td>${euro(bd.energy)}</td></tr>
          <tr><td>${tr`Grid access and electricity tax`}</td><td>${euro(bd.fees)}</td></tr>
          <tr><td>${tr`VAT (${Math.round(bd.rate * 100)}%, ${esc(REGIONS[c.region].name)})`}</td><td>${euro(bd.vat)}</td></tr>
          <tr class="total"><td>${tr`Total for ${bd.n} kWh`}</td><td>${euro(bd.total)}</td></tr>
        </table>
        <p>${tr`Worked out the way Miio itemises a session. Real costs depend on your car's charging speed, so check the app before charging.`}${t?.later ? " " + esc(t.later) : ""}</p>
      </details>` : ""}`;
  }

  function showDetail(c) {
    const [primary, ...more] = navLinks(c.lat, c.lon, c.title);
    const place = [c.address, c.operator].filter(Boolean).join(" · ");
    const hours = c.opening_hours && c.opening_hours !== "24/7" ? c.opening_hours : null;
    const routeInfo = state.route?.on.get(c.id);

    const pay = [];
    if (FR) {
      if (/tesla/i.test(c.operator || "")) pay.push(`<li><svg><use href="#i-phone"/></svg>${tr`Tesla Supercharger: start and pay in the Tesla app (open to all cars at most French sites).`}</li>`);
      if (c.card) pay.push(`<li><svg><use href="#i-card"/></svg>${tr`Bank card at the charger`}</li>`);
      if (c.pay.adhoc && !c.card) pay.push(`<li><svg><use href="#i-phone"/></svg>${tr`Pay on the spot without a subscription (QR code or app)`}</li>`);
      if (c.pay.other) pay.push(`<li><svg><use href="#i-card"/></svg>${tr`Charging cards and apps (e.g. Chargemap, Freshmile)`}</li>`);
    } else if (c.source === "osm") {
      pay.push(c.network === "Tesla"
        ? `<li><svg><use href="#i-phone"/></svg>${tr`Tesla Supercharger: start and pay in the Tesla app. Many in Portugal are open to other cars too; the app shows which.`}</li>`
        : `<li class="warn"><svg><use href="#i-info"/></svg>${tr`Not on the MOBI.E network (found on OpenStreetMap), so Miio won't work and there's no price here. Check the operator's app.`}</li>`);
    } else if (c.payUnknown) {
      pay.push(`<li class="warn"><svg><use href="#i-info"/></svg>${tr`Not on the MOBI.E network, so Miio probably won't work here. Check the operator's app or the charger.`}</li>`);
    } else if (c.pay.apps) {
      pay.push(`<li><svg><use href="#i-phone"/></svg><span>${tr`The app or card of a MOBI.E electricity supplier, such as Miio. Set it up and test it before you travel.`}
        <button type="button" class="link-btn" id="pay-help">${tr`How to pay as a visitor`}</button></span></li>`);
    }
    if (!FR && c.card) pay.push(`<li><svg><use href="#i-card"/></svg>${tr`Bank card at the charger (the operator says so; check on site)`}</li>`);

    const source = FR ? "" : c.source === "osm" ? tr`Data: OpenStreetMap (location and power only)`
      : state.dataTime ? tr`Data: MOBI.E via the National Access Point, updated ${ago(state.dataTime)}` : tr`Data: MOBI.E via the National Access Point`;

    const sockets = (c.sockets || []).map((s) =>
      `<li><svg><use href="#${(s.kw || 0) >= 50 ? "i-bolt" : "i-plug"}"/></svg>${s.count}× ${esc(s.type)}
        <span class="sub">${s.kw ? fmtKw(s.kw) + " kW" : ""}${socketPrice(s, c.tariff)}</span></li>`).join("");

    const back = state.returnTo === "route" && state.route ? tr`Route` : tr`All chargers`;
    $("detail-view").innerHTML = `
      <div class="detail">
        <div class="detail-top">
          <button class="text-btn" id="back"><svg><use href="#i-back"/></svg>${back}</button>
          <button class="text-btn" id="close" aria-label="${tr`Close`}"><svg><use href="#i-close"/></svg></button>
        </div>
        ${c.ultra ? `<span class="ultra-pill"><svg><use href="#i-bolt2"/></svg>${tr`Ultra-fast, ${fmtKw(c.max_kw || 150)} kW`}</span>` : ""}
        <h2 id="detail-title">${esc(c.title)}</h2>
        <div class="place">${esc(place || tr`Operator unknown`)}</div>
        ${routeInfo ? `<div class="leg">${routeInfo.off > 0.15
          ? tr`On your route: ${routeInfo.along.toFixed(0)} km from the start, ${(routeInfo.off * 1000).toFixed(0)} m off the road`
          : tr`On your route: ${routeInfo.along.toFixed(0)} km from the start`}</div>` : ""}

        ${navLink(primary, "nav-primary")}
        <div class="nav-more">${more.map((l) => navLink(l)).join("")}</div>

        ${statusBlock(c)}
        ${priceSection(c)}

        ${pay.length ? `<div class="section-label">${tr`How to pay`}</div><ul class="facts">${pay.join("")}</ul>` : ""}
        ${c.pay.apps ? `<a class="app-btn" data-track="open-miio" href="${MIIO}" target="_blank" rel="noopener"><svg><use href="#i-phone"/></svg>${tr`Open Miio to charge`}</a>` : ""}

        ${sockets || hours ? `<div class="section-label">${tr`Plugs`}</div><ul class="facts">${sockets}
          ${hours ? `<li><svg><use href="#i-clock"/></svg>${tr`Open ${esc(hours)}`}</li>` : ""}</ul>` : ""}

        <div id="alts"></div>
        ${source ? `<div class="code">${esc(source)}</div>` : ""}
        <div class="code">${c.mobie ? tr`MOBI.E code` : c.source === "osm" ? "OpenStreetMap" : "ID"}: ${esc(c.source === "osm" ? c.id.replace(/^osm-/, "") : c.id)}</div>
      </div>`;
    showView("detail-view");
    $("detail-view").querySelector(".detail").scrollTop = 0;
    showAlternatives(c);
    $("back").onclick = () => closeDetail(true);
    $("close").onclick = () => closeDetail(false);
    const ph = $("pay-help");
    if (ph) ph.onclick = () => showCoverage("detail-view");
    setPanel(true);
    $("back").focus({ preventScroll: true });
  }

  // Live status with its age, or a plain "unknown": never green without data.
  function statusBlock(c) {
    if (c.live) {
      const stale = Date.now() - state.statusTime > STATUS_STALE;
      return `<div class="live ${c.live.free ? "ok" : c.live.busy ? "busy" : "bad"}"><span class="dot"></span><span>${liveLong(c)}
        <span class="sub">${FR ? tr`Updated ${ago(state.statusTime)}` : tr`Live from MOBI.E, updated ${ago(state.statusTime)}`}${stale ? " · " + tr`may have changed` : ""}</span></span></div>`;
    }
    return `<div class="live unknown"><span class="dot"></span><span>${tr`Status unknown`}
      <span class="sub">${c.source === "osm" && !FR ? tr`Not on MOBI.E, so no live data` : state.statusTime ? tr`This charger doesn't report live status` : tr`Live status isn't available right now`}</span></span></div>`;
  }

  // Plan B: the nearest chargers with a matching plug (and fast if this one is),
  // leaving out ones reported out of order.
  function showAlternatives(c) {
    const box = $("alts");
    if (!box) return;
    const km = (a) => { const R = 6371, t = Math.PI / 180, dLat = (a.lat - c.lat) * t, dLon = (a.lon - c.lon) * t;
      return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(c.lat * t) * Math.cos(a.lat * t) * Math.sin(dLon / 2) ** 2)); };
    const alts = state.all.filter((a) => a !== c && (!c.fast || a.fast)
        && (!c.plugs.size || [...c.plugs].some((p) => a.plugs.has(p)))
        && !(a.live && !a.live.free && !a.live.busy))
      .map((a) => [a, km(a)]).filter(([, d]) => d > 0.03 && d < 25)
      // a free plug beats a slightly nearer charger that's all in use
      .sort((x, y) => x[1] + (x[0].live && !x[0].live.free ? 3 : 0) - y[1] - (y[0].live && !y[0].live.free ? 3 : 0)).filter(([a], i, arr) => arr.findIndex(([b]) => b.title === a.title) === i).slice(0, 3);
    if (!alts.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="section-label">${tr`If this one doesn't work`}</div><ol class="list alt-list" id="alt-list"></ol>`;
    const d = new Map(alts);
    fillRows($("alt-list"), alts.map(([a]) => a), (a) => [d.get(a) < 1 ? tr`${Math.round(d.get(a) * 1000)} m away` : tr`${d.get(a).toFixed(1)} km away`,
      a.max_kw ? `${fmtKw(a.max_kw)} kW` : null, a.live ? liveShort(a) : tr`status unknown`].filter(Boolean).join(" · "), state.returnTo);
  }

  // What the map knows, per region and source.
  function showCoverage(from) {
    const rows = Object.entries(REGIONS).map(([k, r]) => {
      const cs = state.all.filter((c) => c.region === k && c.source !== "osm");
      return [r.name, cs.length, cs.filter((c) => c.eff != null).length, cs.filter((c) => c.live).length];
    });
    const osm = state.all.filter((c) => c.source === "osm");
    if (osm.length) rows.push([tr`Tesla and others`, osm.length, 0, 0]);
    const checked = state.dataTime ? " " + tr`Last checked ${ago(state.dataTime)}.` : "";
    const MADEIRA_NOCARD = " " + tr`Not in Madeira: chargers there don't take bank cards in practice.`;
    const updated = state.statusTime ? " " + tr`Last update ${ago(state.statusTime)}.` : "";
    const pct = (a, n) => (n ? Math.round((a / n) * 100) + "%" : "–");
    $("help-view").innerHTML = `
      <div class="help">
        <div class="detail-top"><button class="text-btn" id="help-back"><svg><use href="#i-back"/></svg>${tr`Back`}</button></div>
        <h2>${tr`What this map knows`}</h2>
        <table class="cov"><thead><tr><th></th><th>${tr`Chargers`}</th><th>${tr`Price`}</th><th>${tr`Live status`}</th></tr></thead>
          <tbody>${rows.map(([n, all, pr, lv]) => `<tr><td>${esc(n)}</td><td>${all.toLocaleString(LOCALE)}</td><td>${pct(pr, all)}</td><td>${pct(lv, all)}</td></tr>`).join("")}</tbody></table>
        ${FR ? `<h3>${tr`Prices`}</h3>
        <p>${tr`What the operator publishes for paying without a subscription, incl. VAT, as one price per kWh for a ${sessionKwh()} kWh charge. A ~ means the network's usual price, not this charger's own. Your app or the charger shows the final price before you start.`}${checked}</p>
        <h3>${tr`Live status`}</h3>
        <p>${tr`Available, in use or out of order, from France's national charging data every 15 minutes, for the chargers that report it.`}${updated} ${tr`Grey means the status is unknown, not that it's available.`}</p>
        <p>${tr`Not an official government site.`}</p>` : `
        <h3 id="pay-guide">${tr`Paying as a visitor`}</h3>
        <p>${tr`You don't need to live in Portugal to charge, but how you pay depends on the network and the charger.`}</p>
        <ol>
          <li>${tr`On MOBI.E chargers (most of the map), start and pay with the app or card of a MOBI.E electricity supplier, such as Miio.`}</li>
          <li>${tr`Install the app, register and add a payment card before your trip, and check it works.`}</li>
          <li>${tr`Some chargers also let you pay on the spot with a bank card or QR code. The charger card says so when the operator publishes it.`}${MADEIRA_NOCARD}</li>
          <li>${tr`Tesla and other networks outside MOBI.E use their own app.`}</li>
          <li>${tr`At the charger, check the operator, the charger code and the price before you start.`}</li>
        </ol>
        <p><a href="${MOBIE_GUIDE}" target="_blank" rel="noopener">${tr`MOBI.E's guide for EV drivers`}</a></p>
        <h3>${tr`Prices are estimates`}</h3>
        <p>${tr`Each price adds the operator's fee (published on MOBI.E) to Miio's energy price, grid access and VAT, for a ${sessionKwh()} kWh charge. Other apps and subscriptions differ a little. Your app shows the final price before you start.`}${checked}</p>
        <h3>${tr`Live status`}</h3>
        <p>${tr`Available, in use or out of order, from MOBI.E every 15 minutes.`}${updated} ${tr`Grey means the status is unknown, not that it's available.`}</p>
        <h3>${tr`Where the chargers come from`}</h3>
        <p>${tr`Most chargers come from MOBI.E's official data via Portugal's National Access Point, with location, plugs, operator prices and live status where the operator reports them.`}${checked}</p>
        <p>${tr`Tesla Superchargers and other chargers outside MOBI.E come from OpenStreetMap: location and power only, no price or live status, and possibly not complete. Miio doesn't work there; use the network's own app.`}</p>
        <p>${tr`No price shown doesn't mean free, and unknown status doesn't mean out of order.`}</p>
        <p>${tr`Not an official MOBI.E site.`}</p>`}
      </div>`;
    showView("help-view");
    setPanel(true);
    $("help-back").onclick = () => showView(from || (state.route ? "route-view" : "list-view"));
    if (from) $("pay-guide")?.scrollIntoView();
    track("coverage");
  }
  function renderDataLine() {
    const el = $("data-line");
    if (!el) return;

    const bits = [FR ? (state.dataTime ? tr`Prices checked ${ago(state.dataTime)}` : tr`Prices`)
      : tr`Estimated prices (Miio tariff)`];
    if (state.statusTime) bits.push(tr`status ${ago(state.statusTime)}`);
    el.innerHTML = `<svg><use href="#i-info"/></svg><span>${bits.join(" · ")}</span>`;
    el.onclick = showCoverage;
  }

  function closeDetail(keepOpen) {
    if (!state.selected) return;
    state.selected = null;
    history.replaceState(null, "", location.pathname + location.search);
    showView(state.returnTo === "route" && state.route ? "route-view" : "list-view");
    setPanel(keepOpen);
    render();
  }

  // Show a socket's own price only when it differs from the headline price.
  function socketPrice(s, headline) {
    const t = s.tariff;
    if (!t || JSON.stringify(t) === JSON.stringify(headline)) return "";
    if (t.free) return " · " + tr`Free`;
    const bits = [];
    if (t.kwh) bits.push(`${euro(t.kwh)}/kWh`);
    if (t.min) bits.push(`${euro(t.min)}/min`);
    if (t.start) bits.push(`${euro(t.start)} start`);
    return bits.length ? ` · ${FR ? (t.est ? "~" : "") : "operator "}${esc(bits.join(" + "))}` : "";
  }

  // ---------- panel ----------
  const panel = $("panel");
  function setPanel(open) {
    panel.classList.toggle("open", open);
    $("grip").setAttribute("aria-expanded", open);
    $("grip").setAttribute("aria-label", open ? tr`Show less` : tr`Show more`);
  }
  $("grip").addEventListener("click", () => setPanel(!panel.classList.contains("open")));
  $("list-title").addEventListener("click", () => setPanel(!panel.classList.contains("open")));

  // Drag the sheet like Google Maps: grab it anywhere (or pull a list that is
  // already scrolled to the top) and one flick snaps it open or closed.
  let drag = null;
  const SCROLLERS = ".scroll, .list, .detail, .help";
  panel.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || e.target.closest("input, .seg, .nav-primary, .nav-more")) { drag = null; return; }
    drag = {
      y0: e.touches[0].clientY, t0: performance.now(), dy: 0, active: false,
      open: panel.classList.contains("open"),
      scroller: e.target.closest(".scroll") || e.target.closest(SCROLLERS),
      closedOffset: panel.offsetHeight - parseFloat(css("--peek")),
    };
  }, { passive: true });
  panel.addEventListener("touchmove", (e) => {
    if (!drag || sideMQ.matches) return;
    const dy = e.touches[0].clientY - drag.y0;
    if (!drag.active) {
      const atTop = !drag.scroller || drag.scroller.scrollTop <= 0;
      // Open sheet: pull down (from the top of a list). Closed sheet: push up.
      const wants = drag.open ? dy > 6 && atTop : dy < -6;
      if (!wants) { if (Math.abs(dy) > 6) drag = null; return; }
      drag.active = true;
      panel.style.transition = "none";
    }
    e.preventDefault(); // the sheet moves, not the list or the page
    drag.dy = dy;
    const base = drag.open ? 0 : drag.closedOffset;
    const y = Math.min(drag.closedOffset, Math.max(0, base + dy));
    panel.style.transform = `translateY(${y}px)`;
  }, { passive: false });
  const endDrag = () => {
    if (!drag?.active) { drag = null; return; }
    const v = drag.dy / Math.max(1, performance.now() - drag.t0); // px per ms
    panel.style.transition = "";
    panel.style.transform = "";
    if (drag.open) setPanel(!(drag.dy > 70 || v > 0.35));
    else setPanel(drag.dy < -50 || v < -0.35);
    drag = null;
  };
  panel.addEventListener("touchend", endDrag);
  panel.addEventListener("touchcancel", endDrag);

  // ---------- location ----------
  let meMarker;
  function setMe(latlng, { center = true } = {}) {
    state.me = latlng;
    $("near-me")?.remove();
    meMarker?.remove();
    meMarker = L.circleMarker(state.me, {
      radius: 8, color: "#fff", weight: 3, fillColor: "#1c7ed6", fillOpacity: 1, interactive: false,
    }).addTo(map);
    if (center) map.setView(state.me, Math.max(map.getZoom(), 13));
    syncSlider();
    render();
  }

  // Like a map app: if this browser already allows location for the site,
  // open where the visitor is (only inside this site's area, never prompting).
  // Otherwise offer a "Chargers near me" button over the map instead.
  async function startNearMe() {
    if (location.hash.length > 1 || !navigator.geolocation) return;
    let granted = false;
    try { granted = (await navigator.permissions.query({ name: "geolocation" })).state === "granted"; } catch { /* no Permissions API */ }
    if (!granted) { showNearMe(); return; }
    navigator.geolocation.getCurrentPosition((pos) => {
      const here = [pos.coords.latitude, pos.coords.longitude];
      if (!L.latLngBounds(REGIONS[startView].bounds).pad(0.1).contains(here) || state.selected || state.route) return;
      setMe(here, { center: false });
      map.setView(here, 12);
    }, () => {}, { timeout: 8000, maximumAge: 300000 });
  }

  function showNearMe() {
    if (state.me || state.selected || state.route) return;
    const b = document.createElement("button");
    b.className = "near-me"; b.id = "near-me"; b.type = "button";
    b.innerHTML = `<svg><use href="#i-locate"/></svg>${tr`Chargers near me`}`;
    b.onclick = async () => { b.setAttribute("aria-busy", "true"); track("near-me"); await locate(); b.remove(); };
    document.body.append(b);
    // Gone once the visitor has found their own way in.
    const done = () => { if (state.me || map.getZoom() >= 10) { b.remove(); map.off("zoomend", done); } };
    map.on("zoomend", done);
  }

  // Ask for the position. Resolves with [lat, lon], or null when the user
  // said no (then the help screen offers to ask again, or explains how to
  // switch it back on if the browser now refuses without asking).
  function locate() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { showLocationHelp("unsupported"); return resolve(null); }
      const btn = $("locate");
      btn.setAttribute("aria-busy", "true");
      const asked = performance.now();
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          btn.removeAttribute("aria-busy");
          const wasHelp = !$("help-view").hidden;
          setMe([pos.coords.latitude, pos.coords.longitude]);
          if (wasHelp) { showView(state.route ? "route-view" : "list-view"); toast(tr`Found you`); setTimeout(() => toast(), 1800); }
          resolve(state.me);
        },
        async (err) => {
          btn.removeAttribute("aria-busy");
          if (err.code !== 1) { showLocationHelp("unavailable"); return resolve(null); }
          // A "no" that comes back at once means no popup was shown: the browser
          // remembers an earlier "Don't allow", so only its settings can undo it.
          const perm = await geoPermission();
          const silent = perm === "denied" || perm === "granted" || performance.now() - asked < 450;
          showLocationHelp(silent ? "denied" : "declined");
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
      );
    });
  }

  async function geoPermission() {
    try { return (await navigator.permissions.query({ name: "geolocation" })).state; } catch { return null; }
  }

  // While the help screen is open, notice when location gets switched back on
  // (in the site settings, or in the iPhone Settings app) and carry on by itself.
  let helpReason = null, permWatch = null;
  const helpOpen = () => !$("help-view").hidden && helpReason === "denied";
  async function watchPermission() {
    if (permWatch !== null) return;
    try { permWatch = await navigator.permissions.query({ name: "geolocation" }); } catch { permWatch = false; return; }
    permWatch.addEventListener("change", () => { if (helpOpen() && permWatch.state !== "denied") resumeLocate(); });
  }
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && helpOpen() && (await geoPermission()) === "granted") resumeLocate();
  });
  function resumeLocate() {
    helpStatus(tr`Location is on. Finding you…`, "ok");
    locate();
  }
  function helpStatus(msg, kind) {
    const el = $("help-status");
    if (!el) return;
    el.className = "help-status " + (kind || "");
    el.textContent = msg;
    el.hidden = !msg;
  }

  function showLocationHelp(reason, again = false) {
    helpReason = reason;
    const iosChrome = isIOS && /CriOS/.test(ua);
    const content = reason === "declined" ? `
        <div class="help-icon"><svg><use href="#i-locate"/></svg></div>
        <h2>${tr`Find chargers near you`}</h2>
        <p>${tr`With your location the map sorts chargers by distance and starts routes from where you are. This site never saves it.`}</p>`
      : reason === "denied" ? `
        <div class="help-icon off"><svg><use href="#i-locate"/></svg></div>
        <h2>${tr`Location is switched off for this site`}</h2>
        <p>${tr`Your browser remembers the earlier "Don't allow", so it won't ask again by itself. Switching it back on takes a few taps:`}</p>
        <div class="help-steps">
        ${iosChrome ? `<h3>iPhone (Chrome)</h3><ol>
          <li>${tr`Open the iPhone <b>Settings</b> app and find <b>Chrome</b>.`}</li>
          <li>${tr`Set <b>Location</b> to <b>While Using the App</b>.`}</li>
          <li>${tr`Come back here and tap <b>Try again</b>.`}</li></ol>`
        : isIOS ? `<h3>iPhone (Safari)</h3><ol>
          <li>${tr`Tap <b>aA</b> in the address bar, then <b>Website Settings</b>.`}</li>
          <li>${tr`Set <b>Location</b> to <b>Ask</b> or <b>Allow</b>.`}</li>
          <li>${tr`Still blocked? Settings → Privacy &amp; Security → Location Services → Safari Websites → <b>While Using</b>.`}</li></ol>`
        : isAndroid ? `<h3>Android (Chrome)</h3><ol>
          <li>${tr`Tap the <b>settings icon</b> left of the address.`}</li>
          <li>${tr`Tap <b>Permissions</b> → <b>Location</b> → <b>Allow</b>.`}</li>
          <li>${tr`Still blocked? Check that <b>Location</b> is on in your phone's quick settings.`}</li></ol>`
        : `<h3>${tr`On a computer`}</h3><ol>
          <li>${tr`Click the <b>icon left of the address</b> (padlock or sliders).`}</li>
          <li>${tr`Set <b>Location</b> to <b>Allow</b>.`}</li></ol>`}
        </div>
        <p class="help-small">${tr`Done? Tap Try again. No need to reload the page.`}</p>`
      : `
        <div class="help-icon off"><svg><use href="#i-locate"/></svg></div>
        <h2>${reason === "unsupported" ? tr`This browser can't share your location` : tr`Couldn't find your location`}</h2>
        <p>${tr`Make sure Location Services are on for your browser, then try again.`}</p>`;
    $("help-view").innerHTML = `
      <div class="help">
        <div class="detail-top"><button class="text-btn" id="help-back"><svg><use href="#i-back"/></svg>${tr`Back`}</button></div>
        ${content}
        <p class="help-status" id="help-status" role="status" hidden></p>
        <div class="actions">
          ${reason === "unsupported" ? "" : `<button class="nav-primary" id="help-retry"><svg><use href="#i-locate"/></svg>${reason === "declined" ? tr`Use my location` : tr`Try again`}</button>`}
          <button class="btn-quiet" id="help-pick"><svg><use href="#i-pin"/></svg>${tr`Set my location on the map`}</button>
        </div>
        <p class="help-small">${tr`Or search for a town or address in the box at the top.`}</p>
      </div>`;
    showView("help-view");
    setPanel(true);
    if (again) {
      helpStatus(tr`Still switched off. Follow the steps above, then try again.`, "bad");
      $("help-view").querySelector(".help-steps")?.classList.add("nudge");
      $("help-status").scrollIntoView({ block: "center", behavior: "smooth" });
    }
    $("help-back").onclick = () => showView(state.route ? "route-view" : "list-view");
    const retry = $("help-retry");
    if (retry) retry.onclick = async () => {
      retry.setAttribute("aria-busy", "true");
      helpStatus(tr`Checking…`);
      track("location-retry");
      // Known to be blocked: no point asking, show the steps (again) right away.
      if ((await geoPermission()) === "denied") { showLocationHelp("denied", true); return; }
      const wasBlocked = reason === "denied";
      if (!(await locate()) && wasBlocked && helpReason === "denied") showLocationHelp("denied", true);
    };
    $("help-pick").onclick = startPicking;
    if (reason === "denied") watchPermission();
    if (!again) track("location-" + reason);
  }

  let toastEl;
  function toast(msg) {
    toastEl?.remove();
    if (!msg) return;
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.setAttribute("role", "status");
    toastEl.textContent = msg;
    document.body.append(toastEl);
  }

  let afterPick = null;
  function startPicking(then) {
    state.pickingStart = true;
    afterPick = typeof then === "function" ? then : null;
    showView(state.route ? "route-view" : "list-view");
    setPanel(false);
    toast(tr`Tap the map where you are`);
    map.getContainer().style.cursor = "crosshair";
  }

  // ---------- search ----------
  const q = $("q"), results = $("results");
  let searchTimer, searchSeq = 0, hits = [], active = -1;
  q.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const text = q.value.trim();
    if (text.length < 3) { results.hidden = true; return; }
    searchTimer = setTimeout(() => search(text), 350); // be kind to the free service
  });
  q.addEventListener("keydown", (e) => {
    if (results.hidden || !hits.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
      [...results.children].forEach((li, i) => li.setAttribute("aria-selected", i === active));
    } else if (e.key === "Escape") { results.hidden = true; }
  });
  $("search").addEventListener("submit", (e) => {
    e.preventDefault();
    if (hits.length) choose(hits[Math.max(active, 0)]);
    else if (q.value.trim().length >= 2) search(q.value.trim(), true);
  });
  document.addEventListener("click", (e) => { if (!$("search").contains(e.target)) results.hidden = true; });

  // Places from Photon (OpenStreetMap search), nearest to the map view first.
  async function findPlaces(text) {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&limit=6${LANG === "fr" ? "&lang=fr" : ""}&bbox=${BBOX}&lat=${map.getCenter().lat.toFixed(3)}&lon=${map.getCenter().lng.toFixed(3)}`;
    const data = await (await fetch(url)).json();
    return (data.features || []).map((f) => {
      const p = f.properties || {};
      const [lon, lat] = f.geometry.coordinates;
      const name = p.name || [p.street, p.housenumber].filter(Boolean).join(" ") || text;
      const sub = [p.street && p.name ? p.street : null, p.city || p.county, p.state].filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i && v !== name).join(", ");
      return { name, sub, lat, lon };
    });
  }
  const placeRows = (list) => list.map((h, i) => `<li role="option" data-i="${i}"><svg><use href="#i-pin"/></svg>
    <span><span class="r-name">${esc(h.name)}</span><br><span class="r-sub">${esc(h.sub)}</span></span></li>`).join("");

  async function search(text, pickFirst = false) {
    const seq = ++searchSeq;
    results.hidden = false;
    results.innerHTML = `<li class="r-msg">${tr`Searching…`}</li>`;
    try {
      const found = await findPlaces(text);
      if (seq !== searchSeq) return;
      hits = found;
      active = -1;
      if (!hits.length) { results.innerHTML = `<li class="r-msg">${tr`No places found in ${COUNTRY} for "${esc(text)}"`}</li>`; return; }
      if (pickFirst) return choose(hits[0]);
      results.innerHTML = placeRows(hits);
      results.onclick = (e) => { const li = e.target.closest("li[data-i]"); if (li) choose(hits[+li.dataset.i]); };
    } catch {
      if (seq === searchSeq) results.innerHTML = `<li class="r-msg">${tr`Search isn't reachable right now. Try again in a moment.`}</li>`;
    }
  }

  async function choose(place) {
    results.hidden = true;
    q.value = place.name;
    q.blur();
    track("search");
    if (state.start) return planRoute([state.start.lat, state.start.lon], place);
    let from = state.me;
    if (!from) {
      toast(tr`Finding your location…`);
      from = await locate();
      toast();
    }
    if (!from) {
      // Location blocked: the help screen is showing; picking a start resumes the route.
      $("help-pick").onclick = () => startPicking(() => planRoute(state.me, place));
      return;
    }
    planRoute(from, place);
  }

  // ---------- route ----------
  async function planRoute(from, place) {
    showRouteView({ loading: true, place });
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${place.lon},${place.lat}?overview=full&geometries=geojson`;
      const data = await (await fetch(url)).json();
      const r = data.routes?.[0];
      if (data.code !== "Ok" || !r) throw new Error(data.code);
      const coords = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      state.route = { place, from, start: state.start, coords, km: r.distance / 1000, min: r.duration / 60, on: alongRoute(coords) };
      routeLayer.clearLayers();
      L.polyline(coords, { color: css("--ink"), weight: 9, opacity: 0.25, interactive: false }).addTo(routeLayer);
      L.polyline(coords, { color: "#1c7ed6", weight: 5, opacity: 0.95, interactive: false }).addTo(routeLayer);
      L.circleMarker([place.lat, place.lon], { radius: 9, color: "#fff", weight: 3, fillColor: css("--ink"), fillOpacity: 1, interactive: false }).addTo(routeLayer);
      if (state.start) L.circleMarker(from, { radius: 8, color: "#fff", weight: 3, fillColor: "#1c7ed6", fillOpacity: 1, interactive: false }).addTo(routeLayer);
      map.fitBounds(L.latLngBounds(coords), { paddingTopLeft: [30, 140], paddingBottomRight: [30, 200] });
      state.returnTo = "route";
      render();
      showRouteView({});
      track("route");
    } catch (e) {
      console.error(e);
      showRouteView({ error: true, place });
    }
  }

  // Every charger within ROUTE_KM of the road, with how far along the route it
  // is. Route segments go into a grid of ROUTE_KM cells so each charger only
  // checks the few segments near it (a Paris-Nice route has ~10,000 points and
  // France ~45,000 chargers).
  function alongRoute(coords) {
    const k = 111.32, cosLat = Math.cos(coords[Math.floor(coords.length / 2)][0] * Math.PI / 180);
    const xy = coords.map(([lat, lon]) => [lon * k * cosLat, lat * k]);
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum[i] = cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
    const cell = ROUTE_KM, grid = new Map();
    const key = (gx, gy) => gx * 100003 + gy;
    for (let i = 1; i < xy.length; i++) {
      const [ax, ay] = xy[i - 1], [bx, by] = xy[i];
      const x0 = Math.floor(Math.min(ax, bx) / cell), x1 = Math.floor(Math.max(ax, bx) / cell);
      const y0 = Math.floor(Math.min(ay, by) / cell), y1 = Math.floor(Math.max(ay, by) / cell);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const g = key(gx, gy);
        (grid.get(g) || grid.set(g, []).get(g)).push(i);
      }
    }
    const on = new Map();
    for (const c of state.all) {
      const p = [c.lon * k * cosLat, c.lat * k];
      const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
      let best = Infinity, along = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const i of grid.get(key(gx + dx, gy + dy)) || []) {
          const [ax, ay] = xy[i - 1], [bx, by] = xy[i];
          const ex = bx - ax, ey = by - ay, len2 = ex * ex + ey * ey;
          const t = len2 ? Math.max(0, Math.min(1, ((p[0] - ax) * ex + (p[1] - ay) * ey) / len2)) : 0;
          const d = Math.hypot(p[0] - (ax + t * ex), p[1] - (ay + t * ey));
          if (d < best) { best = d; along = cum[i - 1] + t * Math.sqrt(len2); }
        }
      }
      if (best <= ROUTE_KM) on.set(c.id, { along, off: best });
    }
    return on;
  }

  function showRouteView({ loading, error, place }) {
    const r = state.route;
    const v = $("route-view");
    if (loading || error) {
      v.innerHTML = `<div class="route-head"><div class="row-top"><h1>${tr`To ${esc(place.name)}`}</h1>
        <button class="text-btn" id="route-clear" aria-label="${tr`Clear route`}"><svg><use href="#i-close"/></svg></button></div>
        ${fromField()}
        <div class="meta">${loading ? tr`Finding the route…` : tr`Couldn't get a route right now. Try again in a moment.`}</div></div>`;
    } else {
      const [primary, ...more] = navLinks(r.place.lat, r.place.lon, r.place.name, r.start ? r.from : null);
      v.innerHTML = `
        <div class="route-head">
          <div class="row-top">
            <div><h1>${tr`To ${esc(r.place.name)}`}</h1>
              <div class="meta">${tr`${r.km.toFixed(0)} km · about ${fmtMin(r.min)} by car`}</div></div>
            <button class="text-btn" id="route-clear" aria-label="${tr`Clear route`}"><svg><use href="#i-close"/></svg></button>
          </div>
          ${fromField()}
          <div class="range-row">
            <label for="range">${tr`Your car's range`}</label>
            <span class="range-input"><input id="range" type="number" inputmode="numeric" min="50" max="1000" step="10" placeholder="${tr`e.g. 300`}" value="${state.range || ""}"> km</span>
          </div>
          <div id="stops-summary" class="stops-summary" hidden></div>
          <div id="nav-label" class="nav-label" hidden>${tr`Or drive straight there, without stops:`}</div>
          ${navLink(primary, "nav-primary")}
          <div class="nav-more" style="margin-top:0">${more.map((l) => navLink(l)).join("")}</div>
          <h1 id="route-title" style="font-size:16px;margin-top:4px"></h1>
        </div>
        <ol id="route-list" class="list"></ol>`;
      $("range").addEventListener("change", (e) => {
        const v = Math.round(+e.target.value);
        state.range = v >= 50 && v <= 1000 ? v : 0;
        save("range", String(state.range));
        if (state.range) track("range");
        renderRouteList();
      });
      renderRouteList();
    }
    showView("route-view");
    setPanel(true);
    $("route-clear").onclick = clearRoute;
    wireFrom(place || r.place);
  }

  // Where the route starts: the visitor's location, or any place they search.
  const fromField = () => `<div class="from-box">
      <label class="from-row" for="from-q"><span class="from-label">${tr`From`}</span>
        <input id="from-q" type="search" enterkeyhint="search" autocomplete="off" placeholder="${tr`Your location`}" value="${esc(state.start?.name || "")}"></label>
      <ul id="from-results" class="results from-results" role="listbox" hidden></ul></div>`;
  function wireFrom(place) {
    const input = $("from-q"), box = $("from-results");
    let timer, seq = 0, found = [];
    const startFrom = async (start) => {
      box.hidden = true;
      input.blur();
      if (start) { state.start = start; track("route-from"); return planRoute([start.lat, start.lon], place); }
      state.start = null;
      let from = state.me;
      if (!from) { toast(tr`Finding your location…`); from = await locate(); toast(); }
      if (from) planRoute(from, place);
    };
    const show = async (text) => {
      const mine = `<li role="option" data-me="1"><svg><use href="#i-locate"/></svg><span class="r-name">${tr`Your location`}</span></li>`;
      box.hidden = false;
      if (text.length < 3) { found = []; box.innerHTML = mine; return; }
      const n = ++seq;
      box.innerHTML = `<li class="r-msg">${tr`Searching…`}</li>`;
      try {
        const list = await findPlaces(text);
        if (n !== seq) return;
        found = list;
        box.innerHTML = mine + (list.length ? placeRows(list) : `<li class="r-msg">${tr`No places found in ${COUNTRY} for "${esc(text)}"`}</li>`);
      } catch {
        if (n === seq) box.innerHTML = `<li class="r-msg">${tr`Search isn't reachable right now. Try again in a moment.`}</li>`;
      }
    };
    input.addEventListener("focus", () => { if (!input.value) show(""); });
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => show(input.value.trim()), 350); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") box.hidden = true;
      if (e.key === "Enter") { e.preventDefault(); if (found.length) startFrom(found[0]); else if (!input.value.trim()) startFrom(null); }
    });
    box.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-i], li[data-me]");
      if (li) startFrom(li.dataset.me ? null : found[+li.dataset.i]);
    });
    document.addEventListener("click", function off(e) {
      if (!input.isConnected) return document.removeEventListener("click", off);
      if (!e.target.closest(".from-box")) box.hidden = true;
    });
  }

  function renderRouteList() {
    const list = $("route-list");
    if (!list || !state.route) return;
    const on = state.route.on;
    const items = visible().filter((c) => on.has(c.id)).sort((a, b) => on.get(a.id).along - on.get(b.id).along);
    const plan = planStops(items);
    showStops(plan);
    $("route-title").textContent = !items.length ? tr`No chargers along this route`
      : items.length === 1 ? tr`1 charger along the way` : tr`${items.length} chargers along the way`;
    if (!items.length) {
      list.innerHTML = `<li class="empty"><span>${anyFilter() ? tr`Turn a filter off to see more.` : Object.values(state.limits).some((v) => v != null) ? tr`Loosen the slider to see more.` : tr`Nothing within 1 km of the road.`}</span></li>`;
      return;
    }
    fillRows(list, items, (c) => {
      const o = on.get(c.id);
      const n = plan?.stops.indexOf(c);
      return [n >= 0 ? tr`Stop ${n + 1}` : null, `km ${o.along.toFixed(0)}`, c.max_kw ? `${fmtKw(c.max_kw)} kW` : null,
        o.off > 0.15 ? tr`${(o.off * 1000).toFixed(0)} m off road` : tr`on the road`, liveShort(c)].filter(Boolean).join(" · ");
    }, "route", (c) => (plan?.stops.includes(c) ? "stop" : ""));
  }

  // Charging stops for the car's range, planned over the whole trip. The car
  // leaves full, keeps 10% in reserve and charges at fast chargers to at most
  // 80%. A search over (charger, battery level) finds where to stop and how
  // much to charge so the whole trip is cheapest (energy cost, plus €3 per
  // stop so it won't add a stop to save cents) or fastest (charging time from
  // each charger's speed, plus a few minutes per stop).
  const KWH_PER_KM = 0.18, RESERVE = 0.1, MAX_SOC = 0.8, CAR_KW = 120;
  const STOP_EUR = 3, STOP_MIN = 8;
  const chargeKw = (c) => Math.min(c.max_kw || 50, CAR_KW) * 0.75; // average over a 10-80% charge
  function planStops(items) {
    if (!state.range || !state.route) return null;
    const R = state.range, total = state.route.km, on = state.route.on;
    const fast = items.filter((c) => c.fast).sort((a, b) => on.get(a.id).along - on.get(b.id).along);
    // Chargers without a price count at a high-ish price, so priced ones win ties.
    const known = fast.map((c) => (c.isFree ? 0 : c.eff)).filter((v) => v != null).sort((a, b) => a - b);
    const fallback = known.length ? known[Math.floor(known.length * 0.75)] : 0.6;
    const price = (c) => (c.isFree ? 0 : c.eff ?? fallback);
    const u = R / 100, L = 100; // battery in 1% steps
    const res = Math.ceil((R * RESERVE) / u), cap = Math.floor((R * MAX_SOC) / u);
    const fastest = state.plan === "fastest";
    // Weight of one step charged at c, and of a stop: minutes or euros. The other
    // goal breaks ties.
    const stepW = (c) => fastest ? (u * KWH_PER_KM / chargeKw(c)) * 60 + u * KWH_PER_KM * price(c) * 0.01
      : u * KWH_PER_KM * price(c) + (u * KWH_PER_KM / chargeKw(c)) * 0.01;
    const stopW = fastest ? STOP_MIN : STOP_EUR;
    const nodes = [{ along: 0 }, ...fast.map((c) => ({ c, along: on.get(c.id).along })), { along: total }];
    const N = nodes.length;
    const dp = nodes.map(() => new Float64Array(L + 1).fill(Infinity));
    const fromNode = nodes.map(() => new Int32Array(L + 1).fill(-1));
    const fromLevel = nodes.map(() => new Int16Array(L + 1));
    const chargedFrom = nodes.map(() => null);
    dp[0][L] = 0;
    for (let i = 0; i < N - 1; i++) {
      const arr = dp[i];
      let best = arr, from = null;
      if (i > 0) {
        // Leave with level c: either as arrived, or charge from b < c (c <= cap).
        const w = stepW(nodes[i].c);
        best = Float64Array.from(arr);
        from = new Int16Array(L + 1).fill(-1);
        let m = Infinity, mb = -1;
        for (let c = 0; c <= L; c++) {
          if (c > 0 && arr[c - 1] - (c - 1) * w < m) { m = arr[c - 1] - (c - 1) * w; mb = c - 1; }
          if (c <= cap && mb >= 0) {
            const v = m + c * w + stopW;
            if (v < best[c]) { best[c] = v; from[c] = mb; }
          }
        }
        chargedFrom[i] = from;
      }
      for (let j = i + 1; j < N; j++) {
        const d = Math.ceil((nodes[j].along - nodes[i].along) / u - 1e-9);
        if (d > L - res) break;
        const dj = dp[j];
        for (let c = res + d; c <= L; c++) {
          const v = best[c];
          if (v < dj[c - d]) { dj[c - d] = v; fromNode[j][c - d] = i; fromLevel[j][c - d] = c; }
        }
      }
    }
    const end = N - 1;
    let a = -1;
    for (let x = res; x <= L; x++) if (dp[end][x] < Infinity && (a < 0 || dp[end][x] < dp[end][a])) a = x;
    if (a < 0) {
      let far = 0;
      for (let i = 1; i < N - 1; i++) if (dp[i].some((v) => v < Infinity)) far = Math.max(far, nodes[i].along);
      return { stops: [], legs: [], gap: far };
    }
    // Walk back from the destination.
    const legs = [];
    for (let j = end, lvl = a; j > 0;) {
      const i = fromNode[j][lvl], c = fromLevel[j][lvl];
      if (i > 0) {
        const b = chargedFrom[i][c];
        if (b >= 0) {
          const ch = nodes[i].c, kwh = (c - b) * u * KWH_PER_KM;
          legs.unshift({ c: ch, arrive: b / L, leave: c / L, kwh, cost: kwh * price(ch), priced: ch.isFree || ch.eff != null, min: (kwh / chargeKw(ch)) * 60 });
        }
        // a stop node without charging: carry on from its arrival level
        lvl = b >= 0 ? b : c;
      }
      j = i;
    }
    const sum = (k) => legs.reduce((t, l) => t + l[k], 0);
    return { stops: legs.map((l) => l.c), legs, gap: null, cost: sum("cost"), kwh: sum("kwh"),
      chargeMin: sum("min") + legs.length * STOP_MIN, unpriced: legs.filter((l) => !l.priced).length, fallback };
  }

  function showStops(plan) {
    const box = $("stops-summary");
    stopLayer.clearLayers();
    if (!box) return;
    box.hidden = !plan;
    if (!plan) { if ($("nav-label")) $("nav-label").hidden = true; return; }
    const { stops, gap, legs } = plan;
    const n = stops.length;
    const label0 = $("nav-label");
    if (label0) label0.hidden = true;
    box.className = "stops-summary" + (gap != null ? " warn" : "");
    const on = state.route.on;
    const seg = `<div class="seg plan-seg" role="radiogroup" aria-label="${tr`Plan the stops for`}">
      <button type="button" role="radio" data-plan="cheapest" aria-checked="${state.plan === "cheapest"}">${tr`Cheapest`}</button>
      <button type="button" role="radio" data-plan="fastest" aria-checked="${state.plan === "fastest"}">${tr`Fastest`}</button></div>`;
    const totals = n && gap == null ? `<p class="plan-total"><span><b>${plan.unpriced ? "~" : ""}${euro(plan.cost)}</b> ${tr`for charging`}</span> · <span><b>${fmtMin(plan.chargeMin)}</b> ${tr`stopped`}</span> · <span>${tr`${fmtMin(state.route.min + plan.chargeMin)} in total`}</span></p>` : "";
    box.innerHTML = `${seg}<p>${gap != null
      ? tr`No fast charger within reach after km ${gap.toFixed(0)}. Plan this trip with your car's own planner, or turn a filter off.`
      : n === 1 ? (state.plan === "fastest" ? tr`1 charging stop, planned for the shortest trip.` : tr`1 charging stop, planned for the lowest total cost.`)
        : n ? (state.plan === "fastest" ? tr`${n} charging stops, planned for the shortest trip.` : tr`${n} charging stops, planned for the lowest total cost.`)
        : tr`No charging stop needed with a ${state.range} km range.`}</p>${totals}${n && gap == null ? googleRoute(stops) : ""}${n ? '<ol class="list stop-list" id="stop-list"></ol>' : ""}`;
    const label = $("nav-label");
    if (label) label.hidden = !(n && gap == null);
    $("share-stops")?.addEventListener("click", () => shareStops(stops));
    if (n) {
      fillRows($("stop-list"), stops, (c) => {
        const l = legs[stops.indexOf(c)];
        return [tr`Stop ${stops.indexOf(c) + 1}`, `km ${on.get(c.id).along.toFixed(0)}`, c.max_kw ? `${fmtKw(c.max_kw)} kW` : null,
          `${pct(l.arrive)}\u00a0→\u00a0${pct(l.leave)}`, `${l.priced ? "" : "~"}${euro(l.cost)}`, fmtMin(l.min)].filter(Boolean).join(" · ");
      }, "route");
      if (gap == null) box.insertAdjacentHTML("beforeend", `<p class="plan-note">${tr`Estimate for ${Math.round(KWH_PER_KM * 100)} kWh per 100 km, leaving full, arriving with at least 10% and charging up to 80%.`}${plan.unpriced ? " " + tr`A ~ means a stop without a price, counted at ${euro(plan.fallback)}/kWh.` : ""}</p>`);
    }
    box.querySelectorAll("[data-plan]").forEach((b) => b.addEventListener("click", () => {
      if (state.plan === b.dataset.plan) return;
      state.plan = b.dataset.plan;
      save("plan", state.plan);
      track("plan-" + state.plan);
      renderRouteList();
    }));
    stops.forEach((c, i) => L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: "stop-pin", html: `<span>${i + 1}</span>`, iconSize: [26, 26] }),
      interactive: false, keyboard: false, zIndexOffset: 1000,
    }).addTo(stopLayer));
  }

  // The whole trip (start, every charging stop, destination) as Google Maps
  // directions. A link takes at most 9 stops in between, so a longer trip is
  // split into parts that each end where the next one starts.
  const GMAPS_STOPS = 9;
  const ll = (lat, lon) => `${(+lat).toFixed(6)},${(+lon).toFixed(6)}`;
  function googleParts(stops) {
    const r = state.route;
    const pts = [r.from, ...stops.map((c) => [c.lat, c.lon]), [r.place.lat, r.place.lon]].map(([a, b]) => ll(a, b));
    const parts = [];
    for (let i = 0; i < pts.length - 1; i += GMAPS_STOPS + 1) parts.push(pts.slice(i, i + GMAPS_STOPS + 2));
    return parts;
  }
  const googleUrl = (p) => "https://www.google.com/maps/dir/?api=1&travelmode=driving"
    + `&origin=${p[0]}&destination=${p[p.length - 1]}`
    + (p.length > 2 ? `&waypoints=${p.slice(1, -1).map(encodeURIComponent).join("%7C")}` : "");
  function googleRoute(stops) {
    const parts = googleParts(stops), url = googleUrl;
    const icon = '<svg><use href="#i-route"/></svg>';
    const share = `<button type="button" class="gmaps-route share-stops" id="share-stops" data-track="share-stops"><svg><use href="#i-share"/></svg>${tr`Share the stops`}</button>`;
    if (parts.length === 1) return `<div class="gmaps-actions"><a class="gmaps-route" data-track="gmaps-route" href="${url(parts[0])}" target="_blank" rel="noopener">${icon}${tr`Open route with stops in Google Maps`}</a>${share}</div>
      <p class="gmaps-note">${tr`Google Maps shows the stops as map points. Share the stops to keep their names, speeds and prices.`}</p>`;
    let stop = 0;
    return `<p class="gmaps-note">${tr`Google Maps takes up to 9 stops per route, so this trip opens in ${parts.length} parts:`}</p>
      <div class="gmaps-parts">${parts.map((p, i) => {
        const from = stop, to = stop + p.length - 1; stop = to;
        const label = i === parts.length - 1 ? tr`Part ${i + 1}: stop ${from} to the end` : i === 0 ? tr`Part 1: start to stop ${to}` : tr`Part ${i + 1}: stop ${from} to ${to}`;
        return `<a class="gmaps-route" data-track="gmaps-route" href="${url(p)}" target="_blank" rel="noopener">${icon}${label}</a>`;
      }).join("")}${share}</div>
      <p class="gmaps-note">${tr`Google Maps shows the stops as map points. Share the stops to keep their names, speeds and prices.`}</p>`;
  }

  // The stops as plain text (name, km, speed, price, address, map link) plus the
  // Google Maps route, for the share sheet or the clipboard.
  async function shareStops(stops) {
    const r = state.route, on = r.on;
    const plan = planStops(visible().filter((c) => on.has(c.id)));
    const from = r.start?.name || tr`Your location`;
    const lines = [tr`${from} to ${r.place.name}: ${r.km.toFixed(0)} km, ${stops.length} charging stops (${state.range} km range)`, ""];
    stops.forEach((c, i) => {
      const price = c.eff == null ? tr`no price data` : c.isFree ? tr`Free` : `${priceTag(c)}/kWh`;
      lines.push(`${i + 1}. ${c.title}`);
      const l = plan?.legs[i];
      lines.push(`   km ${on.get(c.id).along.toFixed(0)} · ${c.max_kw ? `${fmtKw(c.max_kw)} kW · ` : ""}${price}`);
      if (l) lines.push(`   ${pct(l.arrive)} → ${pct(l.leave)} · ${l.kwh.toFixed(0)} kWh · ${l.priced ? "" : "~"}${euro(l.cost)} · ${fmtMin(l.min)}`);
      if (c.address && !c.address.startsWith(c.title)) lines.push(`   ${c.address}`);
      lines.push(`   https://www.google.com/maps/search/?api=1&query=${ll(c.lat, c.lon)}`);
    });
    const parts = googleParts(stops);
    if (plan?.legs.length) lines.push("", tr`Charging about ${euro(plan.cost)}, ${fmtMin(plan.chargeMin)} stopped, ${fmtMin(r.min + plan.chargeMin)} in total.`);
    lines.push("", tr`Whole route in Google Maps:`, ...parts.map(googleUrl), "", location.origin + location.pathname);
    const text = lines.join("\n");
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) { await navigator.share({ title: tr`Charging stops`, text }); return; }
    } catch (e) { if (e?.name === "AbortError") return; }
    try {
      await navigator.clipboard.writeText(text);
      toast(tr`Stops copied`);
    } catch {
      toast(tr`Couldn't copy the stops`);
    }
    setTimeout(() => toast(), 2500);
  }

  function clearRoute() {
    state.route = null;
    state.start = null;
    stopLayer.clearLayers();
    state.returnTo = "list";
    routeLayer.clearLayers();
    q.value = "";
    showView("list-view");
    render();
  }

  // ---------- controls ----------
  // Two quick chips on the map (prices, 50 kW+) plus "Filters", which opens a
  // small menu with the rest, so the row always fits a phone screen.
  document.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.filter;
      state.filters[k] = !state.filters[k];
      b.setAttribute("aria-pressed", state.filters[k]);
      if (state.filters[k]) track("filter-" + k);
      syncFilterCount();
      render();
    }));
  $("plug").addEventListener("change", (e) => {
    state.plug = e.target.value;
    $("plug-chip").classList.toggle("on", !!state.plug);
    if (state.plug) track("plug", state.plug);
    syncFilterCount();
    render();
  });
  const menu = $("filter-menu"), moreBtn = $("more");
  function setMenu(open) {
    menu.hidden = !open;
    moreBtn.setAttribute("aria-expanded", open);
    document.body.classList.toggle("menu-open", open); // lifts the menu above the bottom sheet
  }
  moreBtn.addEventListener("click", (e) => { e.stopPropagation(); setMenu(menu.hidden); });
  $("filters-done").addEventListener("click", () => setMenu(false));
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { setMenu(false); moreBtn.focus(); } });
  // Number of filters switched on inside the menu, shown on the Filters chip.
  function syncFilterCount() {
    const n = ["free", "priced", "card", "motorway"].filter((k) => state.filters[k]).length + (state.plug ? 1 : 0);
    $("filter-count").textContent = n;
    $("filter-count").hidden = !n;
    moreBtn.setAttribute("aria-pressed", n > 0);
  }
  // Card and motorway only where they mean something: not in Madeira
  // (no card payment in practice, no motorways). An active one stays visible.
  function syncChips() {
    const island = viewRegion() === "madeira";
    for (const k of ["card", "motorway"])
      document.querySelector(`[data-filter="${k}"]`).hidden = island && !state.filters[k];
  }
  map.on("moveend", syncChips);
  syncChips();
  const labelsBtn = $("labels");
  labelsBtn.setAttribute("aria-pressed", state.labels);
  labelsBtn.addEventListener("click", () => {
    state.labels = !state.labels;
    labelsBtn.setAttribute("aria-pressed", state.labels);
    save("labels", state.labels ? "1" : "0");
    if (state.labels && map.getZoom() < LABEL_ZOOM && !state.selected) map.setZoom(LABEL_ZOOM);
    else render();
  });
  document.querySelectorAll(".seg button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-checked", x === b));
      state.sort = b.dataset.sort;
      syncSlider();
      if (state.sort === "distance" && !state.me) locate();
      else render();
    }));
  $("locate").addEventListener("click", () => locate());

  // Tags are re-placed after every zoom or pan: which ones fit depends on the
  // zoom, and only chargers on screen should compete for space.
  map.on("moveend", render);
  map.on("click", (e) => {
    if (state.pickingStart) {
      state.pickingStart = false;
      map.getContainer().style.cursor = "";
      toast();
      setMe([e.latlng.lat, e.latlng.lng], { center: false });
      const then = afterPick; afterPick = null;
      then?.();
      return;
    }
    // Tapping the map: close a charger card, or fold the list away.
    if (state.selected) closeDetail(false);
    else setPanel(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(false); });
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-track]");
    if (a) track(a.dataset.track);
  });

  // Ko-fi: wiggle the cup once, the first time the link scrolls into view.
  const tip = document.querySelector(".tip");
  if (tip && "IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { tip.classList.add("nudge"); io.disconnect(); }
    }, { threshold: 1 });
    io.observe(tip);
  }

  // ---------- statistics ----------
  // GoatCounter's documented pixel endpoint: no cookies, no personal data.
  function track(event, detail) {
    if (!GOATCOUNTER) return;
    const isView = event === "pageview";
    const params = new URLSearchParams({
      // One GoatCounter dashboard for both sites: chargeportugal.com page
      // views are counted under /portugal/ so the two can be told apart.
      p: isView ? (SITE === "madeira" ? "" : "/" + SITE) + location.pathname : `${event}${detail ? "/" + detail : ""}`,
      t: isView ? document.title : event,
      r: isView ? document.referrer : "",
      s: `${screen.width},${screen.height},${devicePixelRatio || 1}`,
      rnd: Math.random().toString(36).slice(2),
    });
    if (!isView) params.set("e", "true");
    new Image().src = `https://${GOATCOUNTER}.goatcounter.com/count?${params}`;
  }

  // ---------- helpers ----------
  function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
  function shortOp(s) {
    let out = s;
    for (let i = 0; i < 3; i++)
      out = out?.replace(/[\s,-]+(Unipessoal|Lda\.?|S\.?A\.?|Soluções em .*)$/i, "").replace(/[,\s]+$/, "");
    return out || s;
  }
  // "RIBEIRA BRAVA" -> "Ribeira Brava"; leave mixed-case names alone.
  function tidyName(s) {
    if (s !== s.toUpperCase()) return s;
    return s.toLowerCase().replace(/(^|[\s(\-/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
      .replace(FR ? /(?<!^)\b(De|Du|Des|La|Le|Les|Et|Sur|En|Aux?)\b/g : /\b(Da|De|Do|Das|Dos|E)\b/g, (w) => w.toLowerCase())
      .replace(/(?<!^)\b([DL])'(\p{L})/gu, (m, a, b) => a.toLowerCase() + "'" + b.toUpperCase());
  }
  function dist(c) {
    if (!state.me) return 0;
    const R = 6371, toR = Math.PI / 180;
    const dLat = (c.lat - state.me[0]) * toR, dLon = (c.lon - state.me[1]) * toR;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(state.me[0] * toR) * Math.cos(c.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  const pct = (f) => `${Math.round(f * 100)}%`;
  function fmtMin(m) { return m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`; }
  function euro(v) { return LANG === "fr" ? v.toFixed(2).replace(".", ",") + " €" : "€" + v.toFixed(2); }
  // "~€0.52": a network's usual price rather than this charger's own (France).
  function priceTag(c) { return (c.est ? "~" : "") + euro(c.eff); }
  function fmtKw(v) { return Number.isInteger(v) ? v : v.toFixed(1); }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }
})();
