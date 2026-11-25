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
  const ROUTE_KM = 1.0;      // a charger within this distance of the road counts as "on the route"
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
    sort: "price",
    me: null,
    selected: null,
    route: null,
    returnTo: "list", // which view "back" goes to from a charger
    labels: load("labels") !== "0",
    range: +load("range") || 0, // car's real-world range in km, for route stops; 0 = not set
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
    getJson("data/chargers.json").then(decodeFrance),
    {}, null,
    getJson("data/status.json").catch(() => null),
  ] : [
    getJson("data/chargers.geojson"),
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
    : c.live.free ? tr`${c.live.free} of ${liveTotal(c)} free`
      : c.live.busy ? tr`all in use` : tr`out of order`;
  const liveLong = (c) => (c.live.free
    ? (liveTotal(c) === 1 ? tr`1 of 1 plug free` : tr`${c.live.free} of ${liveTotal(c)} plugs free`)
      + (c.live.broken ? " · " + tr`${c.live.broken} out of order` : "")
    : c.live.busy ? tr`All plugs in use` : tr`Out of order`);
  const hhmm = (d) => d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });

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
    const key = region + state.limits.price;
    if (key === scaleKey) return;
    scaleKey = key;
    $("scale").setAttribute("aria-label", tr`Price colours for ${REGIONS[region].name}`);
    const [a, b, c] = state.cuts;
    if (a == null) { $("scale").hidden = true; return; }
    const ranges = [`≤ ${euro(a)}`, `≤ ${euro(b)}`, `≤ ${euro(c)}`, `> ${euro(c)}`];
    const lim = state.limits.price, lows = [0, a, b, c];
    $("scale").innerHTML = ranges.map((r, i) =>
      `<span class="${lim != null && lows[i] >= lim ? "off" : ""}" style="--c:var(${PALETTE[i]})">${r}</span>`).join("")
      + `<span class="${lim != null ? "off" : ""}" style="--c:var(--p0)">${tr`no price`}</span>`;
  }

  const anyFilter = () => Object.values(state.filters).some(Boolean) || !!state.plug;

  // ---------- map rendering ----------
  function visible() {
    const f = state.filters, l = state.limits;
    return state.all.filter((c) => (!f.fast || c.fast) && (!f.priced || c.eff != null)
      && (!f.card || c.card) && (!f.free || c.live?.free > 0) && (!f.motorway || c.motorway) && (!state.plug || c.plugs.has(state.plug))
      && (l.price == null || (c.eff != null && c.eff <= l.price + 1e-9))
      && (l.power == null || (c.max_kw || 0) >= l.power)
      && (l.distance == null || !state.me || dist(c) <= l.distance));
  }

  // ---------- slider: one per tab (max price, min power, max distance) ----------
  const POWER_STOPS = [0, 7, 11, 22, 50, 75, 100, 150];
  const DIST_STOPS = [1, 2, 3, 5, 10, 15, 20, 30, 50, Infinity];
  const range = $("limit-range");
  function priceSpan() {
    const known = state.all.map((c) => c.eff).filter((v) => v != null);
    return [Math.floor(Math.min(...known) * 100) / 100, Math.ceil(Math.max(...known) * 100) / 100];
  }
  function describe(kind, v) {
    if (kind === "price") return v == null ? tr`Any price` : tr`Up to ${euro(v)}/kWh`;
    if (kind === "power") return v == null ? tr`Any charging speed` : tr`At least ${v} kW`;
    return v == null ? tr`Any distance` : tr`Within ${v} km`;
  }
  function syncSlider() {
    const kind = state.sort, v = state.limits[kind];
    if (kind === "price") {
      const [lo, hi] = priceSpan();
      Object.assign(range, { min: Math.round(lo * 100), max: Math.round(hi * 100), step: 1 });
      range.value = v == null ? range.max : Math.round(v * 100);
    } else {
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
    if (kind === "price") state.limits.price = i >= +range.max ? null : i / 100;
    else if (kind === "power") state.limits.power = i === 0 ? null : POWER_STOPS[i];
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
    if (out.length > MAX_DOTS) {
      const cell = 9, seen = new Map();
      for (const c of out) {
        const pt = map.latLngToLayerPoint([c.lat, c.lon]);
        const k = `${Math.round(pt.x / cell)},${Math.round(pt.y / cell)}`;
        const prev = seen.get(k);
        if (!prev || (c.eff ?? 99) < (prev.eff ?? 99) || c.id === state.selected?.id) seen.set(k, c);
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
    if (state.route) renderRouteList();
  }

  // Greedy label placement: the selected, on-route and cheapest chargers get a
  // price tag first; a tag that would overlap one already placed stays a dot.
  function placeTags(items) {
    const placed = [];
    const out = new Set();
    const rank = (c) => (c.id === state.selected?.id ? 2 : 0) + (state.route?.on.has(c.id) ? 1 : 0);
    const view = map.getBounds().pad(0.1);
    const priority = items.filter((c) => c.eff != null && view.contains([c.lat, c.lon])).sort((a, b) => rank(b) - rank(a) || a.eff - b.eff);
    for (const c of priority) {
      const pt = map.latLngToLayerPoint([c.lat, c.lon]);
      // Real tag sizes; zoomed out, tags are compact (smaller, no bolt) so more fit.
      const compact = map.getZoom() < 13;
      const w = compact ? 10 + priceTag(c).length * 6.5 : 16 + priceTag(c).length * 8 + (c.fast ? 12 : 0);
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
          ? `<span class="pin-tag compact${c.est ? " est" : ""}" style="--c:var(${c.colourVar})">${priceTag(c)}</span>`
          : `<span class="pin-tag${sel ? " selected" : ""}${c.est ? " est" : ""}" style="--c:var(${c.colourVar})">${c.fast ? '<svg><use href="#i-bolt"/></svg>' : ""}${priceTag(c)}</span>`,
      }),
      keyboard: true, title: c.title, riseOnHover: true, zIndexOffset: sel ? 1000 : 0,
    });
    m.on("click", (e) => { L.DomEvent.stop(e); select(c); });
    m.addTo(layer);
  }

  function addDot(c) {
    const sel = state.selected?.id === c.id;
    const m = L.circleMarker([c.lat, c.lon], {
      radius: sel ? 12 : c.fast ? 9 : 7,
      color: sel ? colour("--focus") : c.fast ? colour("--ink") : "#ffffff",
      weight: sel ? 4 : c.fast ? 3 : 2,
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
    fillRows($("list"), inView.slice(0, 200), (c) => subline(c), "list");
  }

  function fillRows(list, items, sub, from, rowClass = () => "") {
    list.innerHTML = items.map((c, i) => `
      <li class="row ${rowClass(c)}" data-i="${i}" tabindex="0">
        <span class="badge${c.eff == null ? " none" : ""}${c.fast ? " fast" : ""}" style="--c:var(${c.colourVar})">
          <svg><use href="#${c.fast ? "i-bolt" : "i-plug"}"/></svg>
        </span>
        <span class="row-main">
          <span class="row-name">${esc(c.title)}</span>
          <span class="row-sub">${esc(sub(c))}</span>
        </span>
        ${c.eff != null
          ? `<span class="row-price${c.est ? " est" : ""}">${c.isFree ? tr`Free` : priceTag(c)}<small>${c.isFree ? "" : c.est ? tr`usual price` : tr`per kWh`}</small></span>`
          : `<span class="row-price none">${tr`No price`}</span>`}
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

  function navLinks(lat, lon, label) {
    const dest = `${lat},${lon}`;
    const links = {
      google: ["Google Maps", `https://www.google.com/maps/dir/?api=1&destination=${dest}`],
      apple: ["Apple Maps", `https://maps.apple.com/?daddr=${dest}`],
      waze: ["Waze", `https://waze.com/ul?ll=${dest}&navigate=yes`],
      other: [tr`Other app`, `geo:${dest}?q=${dest}(${encodeURIComponent(label)})`],
    };
    const order = isIOS ? ["apple", "google", "waze"] : isAndroid ? ["google", "waze", "other"] : ["google", "apple", "waze"];
    return order.map((k) => [...links[k], k]);
  }
  const navLink = ([name, href, key], cls = "") =>
    `<a class="${cls}" data-track="navigate-${key}" href="${href}" ${href.startsWith("geo:") ? "" : 'target="_blank" rel="noopener"'}>${cls === "nav-primary" ? '<svg><use href="#i-nav"/></svg>' + tr`Navigate with ${name}` : name}</a>`;

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
      <div class="price-box${c.est ? " est" : ""}" style="--c:var(${c.colourVar})">
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
      return `<div class="price-box none">${tr`No price published for this charger. Check your charging app before you start.`}</div>`;
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
      pay.push(`<li><svg><use href="#i-phone"/></svg>${tr`Miio, any MOBI.E app or a MOBI.E card`}</li>`);
    }
    if (!FR && c.card) pay.push(`<li><svg><use href="#i-card"/></svg>${tr`Bank card at the charger (the operator says so; check on site)`}</li>`);

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
        <h2 id="detail-title">${esc(c.title)}</h2>
        <div class="place">${esc(place || tr`Operator unknown`)}</div>
        ${routeInfo ? `<div class="leg">${routeInfo.off > 0.15
          ? tr`On your route: ${routeInfo.along.toFixed(0)} km from the start, ${(routeInfo.off * 1000).toFixed(0)} m off the road`
          : tr`On your route: ${routeInfo.along.toFixed(0)} km from the start`}</div>` : ""}

        ${navLink(primary, "nav-primary")}
        <div class="nav-more">${more.map((l) => navLink(l)).join("")}</div>

        ${c.live ? `<div class="live ${c.live.free ? "ok" : c.live.busy ? "busy" : "bad"}"><span class="dot"></span>${liveLong(c)}
          <span class="sub">${tr`at ${hhmm(state.statusTime)}`}</span></div>` : ""}
        ${priceSection(c)}

        ${pay.length ? `<div class="section-label">${tr`How to pay`}</div><ul class="facts">${pay.join("")}</ul>` : ""}
        ${c.pay.apps ? `<a class="app-btn" data-track="open-miio" href="${MIIO}" target="_blank" rel="noopener"><svg><use href="#i-phone"/></svg>${tr`Open Miio to charge`}</a>` : ""}

        ${sockets || hours ? `<div class="section-label">${tr`Plugs`}</div><ul class="facts">${sockets}
          ${hours ? `<li><svg><use href="#i-clock"/></svg>${tr`Open ${esc(hours)}`}</li>` : ""}</ul>` : ""}

        <div class="code">${c.mobie ? tr`MOBI.E code` : c.source === "osm" ? "OpenStreetMap" : "ID"}: ${esc(c.source === "osm" ? c.id.replace(/^osm-/, "") : c.id)}</div>
      </div>`;
    showView("detail-view");
    $("detail-view").querySelector(".detail").scrollTop = 0;
    $("back").onclick = () => closeDetail(true);
    $("close").onclick = () => closeDetail(false);
    setPanel(true);
    $("back").focus({ preventScroll: true });
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
    meMarker?.remove();
    meMarker = L.circleMarker(state.me, {
      radius: 8, color: "#fff", weight: 3, fillColor: "#1c7ed6", fillOpacity: 1, interactive: false,
    }).addTo(map);
    if (center) map.setView(state.me, Math.max(map.getZoom(), 13));
    syncSlider();
    render();
  }

  // Ask for the position. Resolves with [lat, lon], or null when the user
  // blocked it (then the help screen explains how to allow it again).
  function locate() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { showLocationHelp("unsupported"); return resolve(null); }
      const btn = $("locate");
      btn.setAttribute("aria-busy", "true");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          btn.removeAttribute("aria-busy");
          setMe([pos.coords.latitude, pos.coords.longitude]);
          if (!$("help-view").hidden) showView(state.route ? "route-view" : "list-view");
          resolve(state.me);
        },
        (err) => {
          btn.removeAttribute("aria-busy");
          showLocationHelp(err.code === 1 ? "denied" : "unavailable");
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
      );
    });
  }

  function showLocationHelp(reason) {
    const title = reason === "denied" ? tr`Location is blocked for this site`
      : reason === "unsupported" ? tr`This browser can't share your location`
      : tr`Couldn't find your location`;
    const steps = reason !== "denied" ? `<p>${tr`Make sure Location Services are on for your browser, then try again.`}</p>` : `
      <p>${tr`Your browser remembers the "Don't allow". Switch it back on like this, then tap Try again:`}</p>
      ${isIOS ? `<h3>iPhone (Safari)</h3><ol>
        <li>${tr`Tap <b>aA</b> in the address bar, then <b>Website Settings</b>.`}</li>
        <li>${tr`Set <b>Location</b> to <b>Ask</b> or <b>Allow</b>.`}</li>
        <li>${tr`Still blocked? Settings → Privacy &amp; Security → Location Services → Safari Websites → <b>While Using</b>.`}</li></ol>`
      : isAndroid ? `<h3>Android (Chrome)</h3><ol>
        <li>${tr`Tap the <b>settings icon</b> left of the address.`}</li>
        <li>${tr`Tap <b>Permissions</b> → <b>Location</b> → <b>Allow</b>.`}</li>
        <li>${tr`Reload the page.`}</li></ol>`
      : `<h3>${tr`On a computer`}</h3><ol>
        <li>${tr`Click the <b>icon left of the address</b> (padlock or sliders).`}</li>
        <li>${tr`Set <b>Location</b> to <b>Allow</b>, then reload the page.`}</li></ol>`}`;
    $("help-view").innerHTML = `
      <div class="help">
        <div class="detail-top"><button class="text-btn" id="help-back"><svg><use href="#i-back"/></svg>${tr`Back`}</button></div>
        <h2>${title}</h2>
        ${steps}
        <div class="actions">
          <button class="nav-primary" id="help-retry"><svg><use href="#i-locate"/></svg>${tr`Try again`}</button>
          <button class="btn-quiet" id="help-pick"><svg><use href="#i-pin"/></svg>${tr`Set my location on the map`}</button>
        </div>
      </div>`;
    showView("help-view");
    setPanel(true);
    $("help-back").onclick = () => showView(state.route ? "route-view" : "list-view");
    $("help-retry").onclick = () => (reason === "denied" && !isIOS ? location.reload() : locate());
    $("help-pick").onclick = startPicking;
    track("location-" + reason);
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

  async function search(text, pickFirst = false) {
    const seq = ++searchSeq;
    results.hidden = false;
    results.innerHTML = `<li class="r-msg">${tr`Searching…`}</li>`;
    try {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&limit=6${LANG === "fr" ? "&lang=fr" : ""}&bbox=${BBOX}&lat=${map.getCenter().lat.toFixed(3)}&lon=${map.getCenter().lng.toFixed(3)}`;
      const data = await (await fetch(url)).json();
      if (seq !== searchSeq) return;
      hits = (data.features || []).map((f) => {
        const p = f.properties || {};
        const [lon, lat] = f.geometry.coordinates;
        const name = p.name || [p.street, p.housenumber].filter(Boolean).join(" ") || text;
        const sub = [p.street && p.name ? p.street : null, p.city || p.county, p.state].filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i && v !== name).join(", ");
        return { name, sub, lat, lon };
      });
      active = -1;
      if (!hits.length) { results.innerHTML = `<li class="r-msg">${tr`No places found in ${COUNTRY} for "${esc(text)}"`}</li>`; return; }
      if (pickFirst) return choose(hits[0]);
      results.innerHTML = hits.map((h, i) => `<li role="option" data-i="${i}"><svg><use href="#i-pin"/></svg>
        <span><span class="r-name">${esc(h.name)}</span><br><span class="r-sub">${esc(h.sub)}</span></span></li>`).join("");
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
      state.route = { place, from, coords, km: r.distance / 1000, min: r.duration / 60, on: alongRoute(coords) };
      routeLayer.clearLayers();
      L.polyline(coords, { color: css("--ink"), weight: 9, opacity: 0.25, interactive: false }).addTo(routeLayer);
      L.polyline(coords, { color: "#1c7ed6", weight: 5, opacity: 0.95, interactive: false }).addTo(routeLayer);
      L.circleMarker([place.lat, place.lon], { radius: 9, color: "#fff", weight: 3, fillColor: css("--ink"), fillOpacity: 1, interactive: false }).addTo(routeLayer);
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
        <div class="meta">${loading ? tr`Finding the route…` : tr`Couldn't get a route right now. Try again in a moment.`}</div></div>`;
    } else {
      const [primary, ...more] = navLinks(r.place.lat, r.place.lon, r.place.name);
      v.innerHTML = `
        <div class="route-head">
          <div class="row-top">
            <div><h1>${tr`To ${esc(r.place.name)}`}</h1>
              <div class="meta">${tr`${r.km.toFixed(0)} km · about ${fmtMin(r.min)} by car`}</div></div>
            <button class="text-btn" id="route-clear" aria-label="${tr`Clear route`}"><svg><use href="#i-close"/></svg></button>
          </div>
          ${navLink(primary, "nav-primary")}
          <div class="nav-more" style="margin-top:0">${more.map((l) => navLink(l)).join("")}</div>
          <div class="range-row">
            <label for="range">${tr`Your car's range`}</label>
            <span class="range-input"><input id="range" type="number" inputmode="numeric" min="50" max="1000" step="10" placeholder="${tr`e.g. 300`}" value="${state.range || ""}"> km</span>
          </div>
          <div id="stops-summary" class="stops-summary" hidden></div>
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

  // Charging stops for the car's range. Leaves with a full battery and keeps
  // 10% in reserve (first leg 90% of the range); each fast charge is 10 -> 80%
  // (70% of the range). In the last stretch of each leg it picks the cheapest
  // fast charger, so stops are not only placed as far out as possible.
  const FIRST_LEG = 0.9, NEXT_LEG = 0.7;
  function planStops(items) {
    if (!state.range || !state.route) return null;
    const total = state.route.km, on = state.route.on;
    const fast = items.filter((c) => c.fast);
    const stops = [];
    let pos = 0, leg = state.range * FIRST_LEG, gap = null;
    while (pos + leg < total) {
      const reach = fast.filter((c) => { const a = on.get(c.id).along; return a > pos + 1 && a <= pos + leg; });
      if (!reach.length) { gap = pos; break; }
      const late = reach.filter((c) => on.get(c.id).along >= pos + leg * 0.6);
      const pool = late.length ? late : reach;
      const price = (c) => c.eff ?? Infinity;
      const pick = pool.reduce((b, c) => (price(c) < price(b) || (price(c) === price(b) && on.get(c.id).along > on.get(b.id).along) ? c : b));
      stops.push(pick);
      pos = on.get(pick.id).along;
      leg = state.range * NEXT_LEG;
      if (stops.length > 30) break;
    }
    return { stops, gap };
  }

  function showStops(plan) {
    const box = $("stops-summary");
    stopLayer.clearLayers();
    if (!box) return;
    box.hidden = !plan;
    if (!plan) return;
    const { stops, gap } = plan;
    const n = stops.length;
    box.className = "stops-summary" + (gap != null ? " warn" : "");
    const on = state.route.on;
    box.innerHTML = `<p>${gap != null
      ? tr`No fast charger within reach after km ${gap.toFixed(0)}. Plan this trip with your car's own planner, or turn a filter off.`
      : n === 1 ? tr`1 charging stop with a ${state.range} km range: fast chargers, 10 to 80%, the cheapest near the end of each leg.`
        : n ? tr`${n} charging stops with a ${state.range} km range: fast chargers, 10 to 80%, the cheapest near the end of each leg.`
        : tr`No charging stop needed with a ${state.range} km range.`}</p>${n ? '<ol class="list stop-list" id="stop-list"></ol>' : ""}`;
    if (n) fillRows($("stop-list"), stops, (c) => [tr`Stop ${stops.indexOf(c) + 1}`, `km ${on.get(c.id).along.toFixed(0)}`,
      c.max_kw ? `${fmtKw(c.max_kw)} kW` : null].filter(Boolean).join(" · "), "route");
    stops.forEach((c, i) => L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: "stop-pin", html: `<span>${i + 1}</span>`, iconSize: [26, 26] }),
      interactive: false, keyboard: false, zIndexOffset: 1000,
    }).addTo(stopLayer));
  }

  function clearRoute() {
    state.route = null;
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
      else renderList();
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
