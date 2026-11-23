/* Madeira EV Chargers: static map, no build step, no tracking. */
(() => {
  "use strict";

  const MADEIRA = [[32.62, -17.30], [33.10, -16.25]]; // includes Porto Santo
  const PALETTE = ["--p1", "--p2", "--p3", "--p4"];
  const BANDS = ["Cheap for Madeira", "Below average", "Above average", "Expensive for Madeira"];
  const LABEL_ZOOM = 13; // price tags from street level, dots below it
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
    filters: { fast: false, priced: false, card: false },
    sort: "price",
    me: null,
    selected: null,
    labels: load("labels") !== "0", // on by default
    markers: new Map(),
  };

  // ---------- map ----------
  const map = L.map("map", {
    zoomControl: false,
    renderer: L.canvas({ tolerance: 12 }), // generous tap target for dots
  }).fitBounds(MADEIRA, { paddingBottomRight: [0, 120] });
  L.control.zoom({ position: "topright" }).addTo(map);
  let tiles;
  function setTiles() {
    tiles?.remove();
    const style = dark.matches ? "dark_all" : "rastertiles/voyager";
    tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, {
      maxZoom: 19, subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
  }
  setTiles();
  dark.addEventListener?.("change", () => { setTiles(); render(); });
  const layer = L.layerGroup().addTo(map);

  // ---------- data ----------
  $("list").innerHTML = '<li class="skeleton"></li>'.repeat(4);
  Promise.all([
    fetch("data/chargers.geojson").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch("data/tariffs.json").then((r) => r.json()).catch(() => ({})),
  ])
    .then(([geo, tariffs]) => {
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

  // Turn a mixed tariff (per kWh, per minute, per start) into one comparable
  // "≈ € per kWh" number, assuming a typical 20 kWh top-up at realistic power.
  function effectivePerKwh(t, maxKw) {
    if (!t) return null;
    const kwh = +t.kwh || 0, min = +t.min || 0, start = +t.start || 0;
    if (!kwh && !min && !start) return t.free ? 0 : null;
    const fast = (maxKw || 0) >= 50;
    const rate = fast ? Math.min(maxKw, 75) : Math.min(maxKw || 11, 11);
    const session = 20;
    const minutes = (session / rate) * 60;
    return kwh + (min * minutes + start) / session;
  }

  function enrich(f, tariffs) {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const tariff = findTariff(p, tariffs);
    return {
      ...p,
      lat, lon, tariff,
      eff: effectivePerKwh(tariff, p.max_kw),
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
    state.max = known.at(-1);
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
    return state.all.filter((c) =>
      (!f.fast || c.fast) && (!f.priced || c.eff != null) && (!f.card || c.pay.card));
  }

  function render() {
    layer.clearLayers();
    state.markers.clear();
    const items = visible();
    const tags = state.labels && map.getZoom() >= LABEL_ZOOM ? placeTags(items) : new Set();
    // Dots first, tags on top.
    for (const c of items) if (!tags.has(c.id)) addDot(c);
    for (const c of items) if (tags.has(c.id)) addTag(c);
    renderList();
  }

  // Greedy label placement: the selected and cheapest chargers get a price tag
  // first; a tag that would overlap one already placed stays a dot.
  function placeTags(items) {
    const placed = [];
    const out = new Set();
    const priority = items.filter((c) => c.eff != null).sort((a, b) =>
      (b.id === state.selected?.id) - (a.id === state.selected?.id) || a.eff - b.eff);
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
    state.markers.set(c.id, m);
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
    state.markers.set(c.id, m);
  }

  // ---------- list ----------
  function renderList() {
    const all = visible();
    const bounds = map.getBounds();
    const inView = all.filter((c) => bounds.contains([c.lat, c.lon]));
    const sorters = {
      price: (a, b) => (a.eff ?? 99) - (b.eff ?? 99) || (b.max_kw || 0) - (a.max_kw || 0),
      power: (a, b) => (b.max_kw || 0) - (a.max_kw || 0) || (a.eff ?? 99) - (b.eff ?? 99),
      distance: (a, b) => dist(a) - dist(b),
    };
    inView.sort(sorters[state.sort] || sorters.price);

    const what = { price: "Cheapest", power: "Fastest", distance: "Nearest" }[state.sort];
    $("list-title").textContent = inView.length
      ? `${what} of ${inView.length} charger${inView.length === 1 ? "" : "s"} in view`
      : "No chargers in view";

    const list = $("list");
    if (!inView.length) {
      const filtered = Object.values(state.filters).some(Boolean);
      list.innerHTML = `<li class="empty"><strong>Nothing here${filtered ? " with these filters" : ""}</strong>
        <span>${filtered ? "Turn a filter off, or zoom out to see more of the island." : "Zoom out to see more of the island."}</span>
        <button class="chip" id="zoom-all">Show all of Madeira</button></li>`;
      $("zoom-all").onclick = () => map.fitBounds(MADEIRA);
      return;
    }
    list.innerHTML = inView.slice(0, 200).map((c, i) => `
      <li class="row" data-i="${i}" tabindex="0">
        <span class="badge${c.eff == null ? " none" : ""}${c.fast ? " fast" : ""}" style="--c:var(${c.colourVar})">
          <svg><use href="#${c.fast ? "i-bolt" : "i-plug"}"/></svg>
        </span>
        <span class="row-main">
          <span class="row-name">${esc(c.title)}</span>
          <span class="row-sub">${esc(subline(c))}</span>
        </span>
        ${c.eff != null
          ? `<span class="row-price">${euro(c.eff)}<small>per kWh</small></span>`
          : `<span class="row-price none">No price</span>`}
      </li>`).join("");
    const pick = (e) => {
      const li = e.target.closest(".row");
      if (li) select(inView[+li.dataset.i], { fly: true });
    };
    list.onclick = pick;
    list.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(e); } };
  }

  function subline(c) {
    const bits = [];
    if (c.max_kw) bits.push(`${fmtKw(c.max_kw)} kW`);
    const types = [...new Set((c.sockets || []).map((s) => s.type))];
    if (types.length) bits.push(types.join(", "));
    if (c.pay.card) bits.push("card");
    if (state.me) bits.push(`${dist(c).toFixed(1)} km`);
    return bits.join(" · ") || c.operator || "Details unknown";
  }

  // ---------- detail ----------
  function select(c, { fly = false } = {}) {
    state.selected = c;
    history.replaceState(null, "", `#${encodeURIComponent(c.id)}`);
    if (fly) map.setView([c.lat, c.lon], Math.max(map.getZoom(), 15));
    render();
    showDetail(c);
  }

  function navLinks(c) {
    const dest = `${c.lat},${c.lon}`;
    const links = {
      google: ["Google Maps", `https://www.google.com/maps/dir/?api=1&destination=${dest}`],
      apple: ["Apple Maps", `https://maps.apple.com/?daddr=${dest}`],
      waze: ["Waze", `https://waze.com/ul?ll=${dest}&navigate=yes`],
      other: ["Other app", `geo:${dest}?q=${dest}(${encodeURIComponent(c.title)})`],
    };
    const order = isIOS ? ["apple", "google", "waze"] : isAndroid ? ["google", "waze", "other"] : ["google", "apple", "waze"];
    return order.map((k) => links[k]);
  }

  const MIIO = isAndroid
    ? "https://play.google.com/store/search?q=miio&c=apps"
    : "https://apps.apple.com/pt/app/miio/id1462182013";

  function showDetail(c) {
    const t = c.tariff;
    const parts = [];
    if (t?.kwh) parts.push(`${euro(t.kwh)}/kWh`);
    if (t?.min) parts.push(`${euro(t.min)}/min`);
    if (t?.start) parts.push(`${euro(t.start)} per session`);
    const [primary, ...more] = navLinks(c);
    const place = [c.address, c.operator].filter(Boolean).join(" · ");

    const priceBox = c.eff != null
      ? `<div class="price-box" style="--c:var(${c.colourVar})">
           <div class="big">${euro(c.eff)}<small> /kWh</small></div>
           <div class="band">${BANDS[c.band]}</div>
           <div class="parts">${esc(parts.join(" + "))}</div>
         </div>
         <details class="note"><summary><svg><use href="#i-info"/></svg>What does this price include?</summary>
           <p>It's the charger operator's fee before VAT, worked out for a typical 20 kWh top-up.
           Your app's energy price (e.g. Miio) and the MOBI.E fee come on top. Those are about the same at
           every charger, so this is the part that makes one charger cheaper than another.${t?.later ? ` Note: ${esc(t.later)}.` : ""}</p>
         </details>`
      : `<div class="price-box none">No price published for this charger. Check your charging app before you start.</div>`;

    const pay = [];
    if (c.payUnknown) {
      pay.push(`<li class="warn"><svg><use href="#i-info"/></svg>Not on the MOBI.E network, so Miio probably won't work here. Check the operator's app or the charger.</li>`);
    } else {
      if (c.pay.apps) pay.push(`<li><svg><use href="#i-phone"/></svg>Miio or any MOBI.E app or card</li>`);
      if (c.pay.card) pay.push(`<li><svg><use href="#i-card"/></svg>Bank card at the charger</li>`);
    }

    const sockets = (c.sockets || []).map((s) =>
      `<li><svg><use href="#${(s.kw || 0) >= 50 ? "i-bolt" : "i-plug"}"/></svg>${s.count}× ${esc(s.type)}
        <span class="sub">${s.kw ? fmtKw(s.kw) + " kW" : ""}${socketPrice(s, t)}</span></li>`).join("");

    const v = $("detail-view");
    v.innerHTML = `
      <div class="detail">
        <div class="detail-top">
          <button class="text-btn" id="back"><svg><use href="#i-back"/></svg>All chargers</button>
          <button class="text-btn" id="close" aria-label="Close"><svg><use href="#i-close"/></svg></button>
        </div>
        <h2 id="detail-title">${esc(c.title)}</h2>
        <div class="place">${esc(place || "Operator unknown")}</div>

        <a class="nav-primary" href="${primary[1]}" target="_blank" rel="noopener">
          <svg><use href="#i-nav"/></svg>Navigate with ${primary[0]}</a>
        <div class="nav-more">${more.map(([n, h]) => `<a href="${h}" ${h.startsWith("geo:") ? "" : 'target="_blank" rel="noopener"'}>${n}</a>`).join("")}</div>

        ${priceBox}

        ${pay.length ? `<div class="section-label">How to pay</div><ul class="facts">${pay.join("")}</ul>` : ""}
        ${c.pay.apps ? `<a class="app-btn" href="${MIIO}" target="_blank" rel="noopener"><svg><use href="#i-phone"/></svg>Open Miio to charge</a>` : ""}

        ${sockets || c.opening_hours ? `<div class="section-label">Plugs</div><ul class="facts">${sockets}
          ${c.opening_hours ? `<li><svg><use href="#i-clock"/></svg>Open ${esc(c.opening_hours)}</li>` : ""}</ul>` : ""}

        <div class="code">${c.mobie ? "MOBI.E code" : "ID"}: ${esc(c.id)}</div>
      </div>`;
    $("list-view").hidden = true;
    v.hidden = false;
    v.querySelector(".detail").scrollTop = 0;
    $("back").onclick = () => closeDetail(true);
    $("close").onclick = () => closeDetail(false);
    setPanel(true);
    $("back").focus({ preventScroll: true });
  }

  function closeDetail(keepOpen) {
    if (!state.selected) return;
    state.selected = null;
    history.replaceState(null, "", location.pathname + location.search);
    $("detail-view").hidden = true;
    $("list-view").hidden = false;
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
    return bits.length ? ` · ${esc(bits.join(" + "))}` : "";
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
  // Swipe the sheet up or down by its handle.
  let startY = null;
  $("grip").addEventListener("touchstart", (e) => { startY = e.touches[0].clientY; }, { passive: true });
  $("grip").addEventListener("touchend", (e) => {
    if (startY == null) return;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dy) > 30) setPanel(dy < 0);
    startY = null;
  });

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
    if (state.labels && map.getZoom() < LABEL_ZOOM && !state.selected) {
      map.setZoom(LABEL_ZOOM); // show the tags straight away
    } else render();
  });
  document.querySelectorAll(".seg button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-checked", x === b));
      state.sort = b.dataset.sort;
      if (state.sort === "distance" && !state.me) locate();
      else renderList();
    }));
  $("locate").addEventListener("click", locate);

  map.on("moveend", renderList);
  let band = map.getZoom() >= LABEL_ZOOM;
  map.on("zoomend", () => {
    const now = map.getZoom() >= LABEL_ZOOM;
    if (now !== band) { band = now; render(); }
  });
  map.on("click", () => closeDetail(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(false); });

  let meMarker;
  function locate() {
    if (!navigator.geolocation) return;
    const btn = $("locate");
    btn.setAttribute("aria-busy", "true");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.removeAttribute("aria-busy");
        state.me = [pos.coords.latitude, pos.coords.longitude];
        meMarker?.remove();
        meMarker = L.circleMarker(state.me, {
          radius: 8, color: "#fff", weight: 3, fillColor: "#1c7ed6", fillOpacity: 1, interactive: false,
        }).addTo(map);
        map.setView(state.me, Math.max(map.getZoom(), 13));
        renderList();
      },
      () => {
        btn.removeAttribute("aria-busy");
        $("list-title").textContent = "Location is off. You can still browse the map.";
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
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
  function euro(v) { return "€" + v.toFixed(2); }
  function fmtKw(v) { return Number.isInteger(v) ? v : v.toFixed(1); }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }
})();
