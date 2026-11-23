/* Madeira EV Chargers: static map, no build step, no cookies. */
(() => {
  "use strict";

  // Usage statistics (GoatCounter, cookie-free). Empty = off.
  const GOATCOUNTER = "madeirachargers";

  const MADEIRA = [[32.62, -17.30], [33.10, -16.25]]; // includes Porto Santo
  const BBOX = "-17.4,32.3,-16.2,33.2";
  const PALETTE = ["--p1", "--p2", "--p3", "--p4"];
  const BANDS = ["Cheap for Madeira", "Below average", "Above average", "Expensive for Madeira"];
  const LABEL_ZOOM = 13;     // price tags from street level, dots below it
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
    filters: { fast: false, priced: false },
    sort: "price",
    me: null,
    selected: null,
    route: null,
    returnTo: "list", // which view "back" goes to from a charger
    labels: load("labels") !== "0",
    pickingStart: false,
  };

  // ---------- map ----------
  const map = L.map("map", {
    zoomControl: false,
    renderer: L.canvas({ tolerance: 12 }), // generous tap target for dots
  }).fitBounds(MADEIRA, { paddingBottomRight: [0, 120] });
  L.control.zoom({ position: "topright" }).addTo(map);
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
  const routeLayer = L.layerGroup().addTo(map);
  const layer = L.layerGroup().addTo(map);

  // ---------- data ----------
  $("list").innerHTML = '<li class="skeleton"></li>'.repeat(4);
  Promise.all([
    fetch("data/chargers.geojson").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch("data/tariffs.json").then((r) => r.json()).catch(() => ({})),
    fetch("data/pricing.json").then((r) => r.json()).catch(() => null),
  ])
    .then(([geo, tariffs, pricing]) => {
      state.pricing = pricing;
      state.all = geo.features.map((f) => enrich(f, tariffs));
      colourByPrice(state.all);
      renderScale();
      render();
      const id = decodeURIComponent(location.hash.slice(1));
      const linked = id && state.all.find((c) => c.id === id);
      if (linked) select(linked, { fly: true });
    })
    .catch((e) => {
      console.error(e);
      $("list-title").textContent = "Couldn't load the chargers";
      $("list").innerHTML = `<li class="empty"><span>Check your connection, then try again.</span>
        <button class="chip" id="retry">Try again</button></li>`;
      $("retry").onclick = () => location.reload();
    });
  track("pageview");

  function findTariff(p, tariffs) {
    const st = tariffs.stations || {};
    if (st[p.id]) return st[p.id];
    if (p.ref && st[p.ref]) return st[p.ref];
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
    const kwh = +t.kwh || 0, min = +t.min || 0, start = +t.start || 0;
    if (!kwh && !min && !start) return t.free ? 0 : null;
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
  function breakdown(opc) {
    const p = state.pricing;
    if (opc == null || !p) return null;
    const n = sessionKwh();
    const operator = opc * n;
    const energy = (p.app_energy_kwh || 0) * n + (p.app_activation || 0);
    const fees = ((p.grid_access_kwh || 0) + (p.excise_kwh || 0)) * n + (p.mobie_fee_session || 0);
    const net = operator + energy + fees;
    const vat = net * (p.vat || 0);
    return { n, operator, energy, fees, vat, total: net + vat, perKwh: (net + vat) / n };
  }

  function enrich(f, tariffs) {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const tariff = findTariff(p, tariffs);
    const opc = operatorPerKwh(tariff, p.max_kw);
    const bd = breakdown(opc);
    return {
      ...p,
      lat, lon, tariff, opc, bd,
      eff: bd ? bd.perKwh : opc, // the number shown everywhere
      fast: (p.max_kw || 0) >= 50,
      mobie: /^([A-Z]{3}-)?[A-Z]{3}-\d{5}$/.test(p.id || ""),
      pay: p.pay || {},
      payUnknown: p.source === "mobie" && !p.pay,
      title: tidyName(p.name || p.operator || p.network || "EV charger"),
      operator: shortOp(p.operator),
    };
  }

  // Colour into quartiles of the known prices, so "cheap" is relative to Madeira.
  function colourByPrice(items) {
    const known = items.map((c) => c.eff).filter((v) => v != null).sort((a, b) => a - b);
    const q = (p) => known[Math.min(known.length - 1, Math.floor(p * known.length))];
    state.cuts = known.length ? [q(0.25), q(0.5), q(0.75)] : [];
    for (const c of items) {
      if (c.eff == null) { c.colourVar = "--p0"; c.band = null; continue; }
      let i = 0;
      while (i < state.cuts.length && c.eff > state.cuts[i]) i++;
      c.colourVar = PALETTE[i];
      c.band = i;
    }
  }

  function renderScale() {
    const [a, b, c] = state.cuts;
    if (a == null) { $("scale").hidden = true; return; }
    const ranges = [`≤ ${euro(a)}`, `≤ ${euro(b)}`, `≤ ${euro(c)}`, `> ${euro(c)}`];
    $("scale").innerHTML = ranges.map((r, i) => `<span style="--c:var(${PALETTE[i]})">${r}</span>`).join("")
      + `<span style="--c:var(--p0)">no price</span>`;
  }

  // ---------- map rendering ----------
  function visible() {
    const f = state.filters;
    return state.all.filter((c) => (!f.fast || c.fast) && (!f.priced || c.eff != null));
  }

  function render() {
    layer.clearLayers();
    const items = visible();
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
    const priority = items.filter((c) => c.eff != null).sort((a, b) => rank(b) - rank(a) || a.eff - b.eff);
    for (const c of priority) {
      const pt = map.latLngToLayerPoint([c.lat, c.lon]);
      const w = 16 + euro(c.eff).length * 8 + (c.fast ? 12 : 0), h = 26;
      const box = { l: pt.x - w / 2 - 2, r: pt.x + w / 2 + 2, t: pt.y - h - 8, b: pt.y + 2 };
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
        html: `<span class="pin-tag${sel ? " selected" : ""}" style="--c:var(${c.colourVar})">${c.fast ? '<svg><use href="#i-bolt"/></svg>' : ""}${euro(c.eff)}</span>`,
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
      color: sel ? css("--focus") : c.fast ? css("--ink") : "#ffffff",
      weight: sel ? 4 : c.fast ? 3 : 2,
      fillColor: css(c.colourVar), fillOpacity: 1,
      bubblingMouseEvents: false, // a tap on a pin must not also count as a tap on the map
    });
    if (canHover) m.bindTooltip(`${esc(c.title)}${c.eff != null ? " · " + euro(c.eff) + "/kWh" : ""}`);
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

    const what = { price: "Cheapest", power: "Fastest", distance: "Nearest" }[state.sort];
    $("list-title").textContent = inView.length
      ? `${what} of ${inView.length} charger${inView.length === 1 ? "" : "s"} in view`
      : "No chargers in view";

    if (!inView.length) {
      const filtered = Object.values(state.filters).some(Boolean);
      $("list").innerHTML = `<li class="empty"><strong>Nothing here${filtered ? " with these filters" : ""}</strong>
        <span>${filtered ? "Turn a filter off, or zoom out to see more of the island." : "Zoom out to see more of the island."}</span>
        <button class="chip" id="zoom-all">Show all of Madeira</button></li>`;
      $("zoom-all").onclick = () => map.fitBounds(MADEIRA);
      return;
    }
    fillRows($("list"), inView.slice(0, 200), (c) => subline(c), "list");
  }

  function fillRows(list, items, sub, from) {
    list.innerHTML = items.map((c, i) => `
      <li class="row" data-i="${i}" tabindex="0">
        <span class="badge${c.eff == null ? " none" : ""}${c.fast ? " fast" : ""}" style="--c:var(${c.colourVar})">
          <svg><use href="#${c.fast ? "i-bolt" : "i-plug"}"/></svg>
        </span>
        <span class="row-main">
          <span class="row-name">${esc(c.title)}</span>
          <span class="row-sub">${esc(sub(c))}</span>
        </span>
        ${c.eff != null
          ? `<span class="row-price">${euro(c.eff)}<small>per kWh</small></span>`
          : `<span class="row-price none">No price</span>`}
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
    if (state.me) bits.push(`${dist(c).toFixed(1)} km away`);
    return bits.join(" · ") || c.operator || "Details unknown";
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
      other: ["Other app", `geo:${dest}?q=${dest}(${encodeURIComponent(label)})`],
    };
    const order = isIOS ? ["apple", "google", "waze"] : isAndroid ? ["google", "waze", "other"] : ["google", "apple", "waze"];
    return order.map((k) => [...links[k], k]);
  }
  const navLink = ([name, href, key], cls = "") =>
    `<a class="${cls}" data-track="navigate-${key}" href="${href}" ${href.startsWith("geo:") ? "" : 'target="_blank" rel="noopener"'}>${cls === "nav-primary" ? '<svg><use href="#i-nav"/></svg>Navigate with ' : ""}${name}</a>`;

  const MIIO = isAndroid
    ? "https://play.google.com/store/search?q=miio&c=apps"
    : "https://apps.apple.com/pt/app/miio/id1462182013";

  function priceSection(c) {
    const t = c.tariff;
    const p = state.pricing;
    if (c.eff == null) {
      return `<div class="price-box none">No price published for this charger. Check your charging app before you start.</div>`;
    }
    const parts = [];
    if (t?.kwh) parts.push(`${euro(t.kwh)}/kWh`);
    if (t?.min) parts.push(`${euro(t.min)}/min`);
    if (t?.start) parts.push(`${euro(t.start)} per session`);
    const bd = c.bd;
    return `
      <div class="price-box" style="--c:var(${c.colourVar})">
        <div class="big">${euro(c.eff)}<small> /kWh</small></div>
        <div class="band">${BANDS[c.band]}</div>
        <div class="parts">${bd ? `≈ ${euro(bd.total)} for ${bd.n} kWh, incl. VAT` : esc(parts.join(" + "))}</div>
      </div>
      ${bd ? `<details class="note"><summary><svg><use href="#i-info"/></svg>Estimated total. How is it worked out?</summary>
        <table class="breakdown">
          <tr><td>Charger operator (${esc(parts.join(" + "))})</td><td>${euro(bd.operator)}</td></tr>
          <tr><td>Energy from ${esc(p.app_name || "your app")} (${euro(p.app_energy_kwh)}/kWh${p.app_energy_is_estimate ? ", estimate" : ""})</td><td>${euro(bd.energy)}</td></tr>
          <tr><td>Grid access and electricity tax</td><td>${euro(bd.fees)}</td></tr>
          <tr><td>${esc(p.vat_label || "VAT")}</td><td>${euro(bd.vat)}</td></tr>
          <tr class="total"><td>Total for ${bd.n} kWh</td><td>${euro(bd.total)}</td></tr>
        </table>
        <p>Worked out the way Miio itemises a session. Real costs depend on your car's charging speed, so check the app before charging.${t?.later ? ` Note: ${esc(t.later)}.` : ""}</p>
      </details>` : ""}`;
  }

  function showDetail(c) {
    const [primary, ...more] = navLinks(c.lat, c.lon, c.title);
    const place = [c.address, c.operator].filter(Boolean).join(" · ");
    const routeInfo = state.route?.on.get(c.id);

    const pay = [];
    if (c.payUnknown) {
      pay.push(`<li class="warn"><svg><use href="#i-info"/></svg>Not on the MOBI.E network, so Miio probably won't work here. Check the operator's app or the charger.</li>`);
    } else if (c.pay.apps) {
      pay.push(`<li><svg><use href="#i-phone"/></svg>Miio, any MOBI.E app or a MOBI.E card</li>`);
    }

    const sockets = (c.sockets || []).map((s) =>
      `<li><svg><use href="#${(s.kw || 0) >= 50 ? "i-bolt" : "i-plug"}"/></svg>${s.count}× ${esc(s.type)}
        <span class="sub">${s.kw ? fmtKw(s.kw) + " kW" : ""}${socketPrice(s, c.tariff)}</span></li>`).join("");

    const back = state.returnTo === "route" && state.route ? "Route" : "All chargers";
    $("detail-view").innerHTML = `
      <div class="detail">
        <div class="detail-top">
          <button class="text-btn" id="back"><svg><use href="#i-back"/></svg>${back}</button>
          <button class="text-btn" id="close" aria-label="Close"><svg><use href="#i-close"/></svg></button>
        </div>
        <h2 id="detail-title">${esc(c.title)}</h2>
        <div class="place">${esc(place || "Operator unknown")}</div>
        ${routeInfo ? `<div class="leg">On your route: ${routeInfo.along.toFixed(0)} km from the start${routeInfo.off > 0.15 ? `, ${(routeInfo.off * 1000).toFixed(0)} m off the road` : ""}</div>` : ""}

        ${navLink(primary, "nav-primary")}
        <div class="nav-more">${more.map((l) => navLink(l)).join("")}</div>

        ${priceSection(c)}

        ${pay.length ? `<div class="section-label">How to pay</div><ul class="facts">${pay.join("")}</ul>` : ""}
        ${c.pay.apps ? `<a class="app-btn" data-track="open-miio" href="${MIIO}" target="_blank" rel="noopener"><svg><use href="#i-phone"/></svg>Open Miio to charge</a>` : ""}

        ${sockets || c.opening_hours ? `<div class="section-label">Plugs</div><ul class="facts">${sockets}
          ${c.opening_hours ? `<li><svg><use href="#i-clock"/></svg>Open ${esc(c.opening_hours)}</li>` : ""}</ul>` : ""}

        <div class="code">${c.mobie ? "MOBI.E code" : "ID"}: ${esc(c.id)}</div>
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
    const bits = [];
    if (t.kwh) bits.push(`${euro(t.kwh)}/kWh`);
    if (t.min) bits.push(`${euro(t.min)}/min`);
    if (t.start) bits.push(`${euro(t.start)} start`);
    return bits.length ? ` · operator ${esc(bits.join(" + "))}` : "";
  }

  // ---------- panel ----------
  const panel = $("panel");
  function setPanel(open) {
    panel.classList.toggle("open", open);
    $("grip").setAttribute("aria-expanded", open);
    $("grip").setAttribute("aria-label", open ? "Show less" : "Show more");
  }
  $("grip").addEventListener("click", () => setPanel(!panel.classList.contains("open")));
  $("list-title").addEventListener("click", () => setPanel(!panel.classList.contains("open")));
  let startY = null;
  $("grip").addEventListener("touchstart", (e) => { startY = e.touches[0].clientY; }, { passive: true });
  $("grip").addEventListener("touchend", (e) => {
    if (startY == null) return;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dy) > 30) setPanel(dy < 0);
    startY = null;
  });

  // ---------- location ----------
  let meMarker;
  function setMe(latlng, { center = true } = {}) {
    state.me = latlng;
    meMarker?.remove();
    meMarker = L.circleMarker(state.me, {
      radius: 8, color: "#fff", weight: 3, fillColor: "#1c7ed6", fillOpacity: 1, interactive: false,
    }).addTo(map);
    if (center) map.setView(state.me, Math.max(map.getZoom(), 13));
    renderList();
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
    const title = reason === "denied" ? "Location is blocked for this site"
      : reason === "unsupported" ? "This browser can't share your location"
      : "Couldn't find your location";
    const steps = reason !== "denied" ? `<p>Make sure Location Services are on for your browser, then try again.</p>` : `
      <p>Your browser remembers the "Don't allow". Switch it back on like this, then tap Try again:</p>
      ${isIOS ? `<h3>iPhone (Safari)</h3><ol>
        <li>Tap <b>aA</b> in the address bar, then <b>Website Settings</b>.</li>
        <li>Set <b>Location</b> to <b>Ask</b> or <b>Allow</b>.</li>
        <li>Still blocked? Settings → Privacy &amp; Security → Location Services → Safari Websites → <b>While Using</b>.</li></ol>`
      : isAndroid ? `<h3>Android (Chrome)</h3><ol>
        <li>Tap the <b>settings icon</b> left of the address.</li>
        <li>Tap <b>Permissions</b> → <b>Location</b> → <b>Allow</b>.</li>
        <li>Reload the page.</li></ol>`
      : `<h3>On a computer</h3><ol>
        <li>Click the <b>icon left of the address</b> (padlock or sliders).</li>
        <li>Set <b>Location</b> to <b>Allow</b>, then reload the page.</li></ol>`}`;
    $("help-view").innerHTML = `
      <div class="help">
        <div class="detail-top"><button class="text-btn" id="help-back"><svg><use href="#i-back"/></svg>Back</button></div>
        <h2>${title}</h2>
        ${steps}
        <div class="actions">
          <button class="nav-primary" id="help-retry"><svg><use href="#i-locate"/></svg>Try again</button>
          <button class="btn-quiet" id="help-pick"><svg><use href="#i-pin"/></svg>Set my location on the map</button>
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
    toast("Tap the map where you are");
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
    results.innerHTML = `<li class="r-msg">Searching…</li>`;
    try {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&limit=6&bbox=${BBOX}`;
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
      if (!hits.length) { results.innerHTML = `<li class="r-msg">No places found in Madeira for "${esc(text)}"</li>`; return; }
      if (pickFirst) return choose(hits[0]);
      results.innerHTML = hits.map((h, i) => `<li role="option" data-i="${i}"><svg><use href="#i-pin"/></svg>
        <span><span class="r-name">${esc(h.name)}</span><br><span class="r-sub">${esc(h.sub)}</span></span></li>`).join("");
      results.onclick = (e) => { const li = e.target.closest("li[data-i]"); if (li) choose(hits[+li.dataset.i]); };
    } catch {
      if (seq === searchSeq) results.innerHTML = `<li class="r-msg">Search isn't reachable right now. Try again in a moment.</li>`;
    }
  }

  async function choose(place) {
    results.hidden = true;
    q.value = place.name;
    q.blur();
    track("search");
    let from = state.me;
    if (!from) {
      toast("Finding your location…");
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
      map.fitBounds(L.latLngBounds(coords), { paddingTopLeft: [30, 30], paddingBottomRight: [30, 200] });
      state.returnTo = "route";
      render();
      showRouteView({});
      track("route");
    } catch (e) {
      console.error(e);
      showRouteView({ error: true, place });
    }
  }

  // Every charger within ROUTE_KM of the road, with how far along the route it is.
  function alongRoute(coords) {
    const k = 111.32, cosLat = Math.cos(32.75 * Math.PI / 180);
    const xy = coords.map(([lat, lon]) => [lon * k * cosLat, lat * k]);
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum[i] = cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
    const on = new Map();
    for (const c of state.all) {
      const p = [c.lon * k * cosLat, c.lat * k];
      let best = Infinity, along = 0;
      for (let i = 1; i < xy.length; i++) {
        const [ax, ay] = xy[i - 1], [bx, by] = xy[i];
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2)) : 0;
        const d = Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
        if (d < best) { best = d; along = cum[i - 1] + t * Math.sqrt(len2); }
      }
      if (best <= ROUTE_KM) on.set(c.id, { along, off: best });
    }
    return on;
  }

  function showRouteView({ loading, error, place }) {
    const r = state.route;
    const v = $("route-view");
    if (loading || error) {
      v.innerHTML = `<div class="route-head"><div class="row-top"><h1>To ${esc(place.name)}</h1>
        <button class="text-btn" id="route-clear" aria-label="Clear route"><svg><use href="#i-close"/></svg></button></div>
        <div class="meta">${loading ? "Finding the route…" : "Couldn't get a route right now. Try again in a moment."}</div></div>`;
    } else {
      const [primary, ...more] = navLinks(r.place.lat, r.place.lon, r.place.name);
      v.innerHTML = `
        <div class="route-head">
          <div class="row-top">
            <div><h1>To ${esc(r.place.name)}</h1>
              <div class="meta">${r.km.toFixed(0)} km · about ${fmtMin(r.min)} by car</div></div>
            <button class="text-btn" id="route-clear" aria-label="Clear route"><svg><use href="#i-close"/></svg></button>
          </div>
          ${navLink(primary, "nav-primary")}
          <div class="nav-more" style="margin-top:0">${more.map((l) => navLink(l)).join("")}</div>
          <h1 id="route-title" style="font-size:16px;margin-top:4px"></h1>
        </div>
        <ol id="route-list" class="list"></ol>`;
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
    $("route-title").textContent = items.length
      ? `${items.length} charger${items.length === 1 ? "" : "s"} along the way`
      : "No chargers along this route";
    if (!items.length) {
      list.innerHTML = `<li class="empty"><span>${Object.values(state.filters).some(Boolean) ? "Turn a filter off to see more." : "Nothing within 1 km of the road."}</span></li>`;
      return;
    }
    fillRows(list, items, (c) => {
      const o = on.get(c.id);
      return [`km ${o.along.toFixed(0)}`, c.max_kw ? `${fmtKw(c.max_kw)} kW` : null,
        o.off > 0.15 ? `${(o.off * 1000).toFixed(0)} m off road` : "on the road"].filter(Boolean).join(" · ");
    }, "route");
  }

  function clearRoute() {
    state.route = null;
    state.returnTo = "list";
    routeLayer.clearLayers();
    q.value = "";
    showView("list-view");
    render();
  }

  // ---------- controls ----------
  document.querySelectorAll(".chip[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.filter;
      state.filters[k] = !state.filters[k];
      b.setAttribute("aria-pressed", state.filters[k]);
      render();
    }));
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
      if (state.sort === "distance" && !state.me) locate();
      else renderList();
    }));
  $("locate").addEventListener("click", () => locate());

  map.on("moveend", renderList);
  let band = map.getZoom() >= LABEL_ZOOM;
  map.on("zoomend", () => {
    const now = map.getZoom() >= LABEL_ZOOM;
    if (now !== band) { band = now; render(); }
  });
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
    closeDetail(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(false); });
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-track]");
    if (a) track(a.dataset.track);
  });

  // ---------- statistics ----------
  // GoatCounter's documented pixel endpoint: no cookies, no personal data.
  function track(event, detail) {
    if (!GOATCOUNTER) return;
    const isView = event === "pageview";
    const params = new URLSearchParams({
      p: isView ? location.pathname : `${event}${detail ? "/" + detail : ""}`,
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
      .replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (w) => w.toLowerCase());
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
  function euro(v) { return "€" + v.toFixed(2); }
  function fmtKw(v) { return Number.isInteger(v) ? v : v.toFixed(1); }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }
})();
