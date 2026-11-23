/* Madeira EV Chargers: static map, no build step, no tracking. */
(() => {
  "use strict";

  const MADEIRA = [[32.62, -17.30], [33.10, -16.25]]; // includes Porto Santo
  const PALETTE = ["--p1", "--p2", "--p3", "--p4"];
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  const state = {
    all: [],
    filters: { fast: false, priced: false },
    sort: "price",
    me: null,
    layer: null,
    selected: null,
  };

  // ---------- map ----------
  const map = L.map("map", { zoomControl: false, preferCanvas: true }).fitBounds(MADEIRA);
  L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  state.layer = L.layerGroup().addTo(map);

  // ---------- data ----------
  Promise.all([
    fetch("data/chargers.geojson").then((r) => r.json()),
    fetch("data/tariffs.json").then((r) => r.json()).catch(() => ({})),
  ])
    .then(([geo, tariffs]) => {
      state.all = geo.features.map((f) => enrich(f, tariffs));
      colourByPrice(state.all);
      render();
    })
    .catch((e) => {
      document.getElementById("sheet-title").textContent = "Could not load chargers. Please refresh.";
      console.error(e);
    });

  function findTariff(p, tariffs) {
    const st = tariffs.stations || {};
    if (st[p.id]) return st[p.id];
    if (p.ref && st[p.ref]) return st[p.ref];
    if (p.tariff) return p.tariff; // official MOBI.E operator tariff
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
      lat, lon,
      tariff,
      eff: effectivePerKwh(tariff, p.max_kw),
      fast: (p.max_kw || 0) >= 50,
      mobie: /^([A-Z]{3}-)?[A-Z]{3}-\d{5}$/.test(p.id || ""),
      title: p.name || p.operator || p.network || "EV charger",
    };
  }

  // Colour into quartiles of the known prices, so "cheap" is relative to Madeira.
  function colourByPrice(items) {
    const known = items.map((c) => c.eff).filter((v) => v != null).sort((a, b) => a - b);
    const q = (p) => known[Math.min(known.length - 1, Math.floor(p * known.length))];
    const cuts = known.length ? [q(0.25), q(0.5), q(0.75)] : [];
    for (const c of items) {
      if (c.eff == null) { c.colourVar = "--p0"; continue; }
      let i = 0;
      while (i < cuts.length && c.eff > cuts[i]) i++;
      c.colourVar = PALETTE[i];
    }
  }

  // ---------- rendering ----------
  function visible() {
    return state.all.filter(
      (c) => (!state.filters.fast || c.fast) && (!state.filters.priced || c.eff != null)
    );
  }

  function render() {
    const items = visible();
    state.layer.clearLayers();
    for (const c of items) {
      const m = L.circleMarker([c.lat, c.lon], {
        radius: c.fast ? 10 : 7,
        color: c.fast ? "#111827" : "#ffffff",
        weight: c.fast ? 3 : 2,
        fillColor: css(c.colourVar),
        fillOpacity: 1,
      });
      m.bindTooltip(`${esc(c.title)}${c.eff != null ? " · " + euro(c.eff) + "/kWh" : ""}`);
      m.on("click", () => openCard(c));
      m.addTo(state.layer);
    }
    renderList();
  }

  function renderList() {
    const bounds = map.getBounds();
    const inView = visible().filter((c) => bounds.contains([c.lat, c.lon]));
    const sorters = {
      price: (a, b) => (a.eff ?? 99) - (b.eff ?? 99) || (b.max_kw || 0) - (a.max_kw || 0),
      power: (a, b) => (b.max_kw || 0) - (a.max_kw || 0) || (a.eff ?? 99) - (b.eff ?? 99),
      distance: (a, b) => dist(a) - dist(b),
    };
    inView.sort(sorters[state.sort] || sorters.price);

    const total = visible().length;
    document.getElementById("sheet-title").textContent =
      `${inView.length} of ${total} chargers in view`;

    const list = document.getElementById("list");
    list.innerHTML = inView
      .slice(0, 200)
      .map(
        (c, i) => `
        <li data-i="${i}">
          <span class="dot ${c.fast ? "fast" : ""}" style="--c:var(${c.colourVar})"></span>
          <div class="li-main">
            <div class="li-name">${esc(c.title)}</div>
            <div class="li-sub">${esc(subline(c))}</div>
          </div>
          <div class="li-price">${c.eff != null ? "≈ " + euro(c.eff) + "<small>per kWh</small>" : "<small>no price</small>"}</div>
        </li>`
      )
      .join("");
    list.onclick = (e) => {
      const li = e.target.closest("li");
      if (!li) return;
      const c = inView[+li.dataset.i];
      map.setView([c.lat, c.lon], Math.max(map.getZoom(), 15));
      openCard(c);
    };
  }

  function subline(c) {
    const bits = [];
    if (c.max_kw) bits.push(`${fmtKw(c.max_kw)} kW`);
    if (c.sockets?.length) bits.push(c.sockets.map((s) => s.type).join(", "));
    if (c.operator && c.operator !== c.title) bits.push(c.operator);
    if (state.me) bits.push(`${dist(c).toFixed(1)} km`);
    return bits.join(" · ") || "Details unknown";
  }

  function openCard(c) {
    state.selected = c;
    const t = c.tariff;
    const parts = [];
    if (t?.kwh) parts.push(`${euro(t.kwh)}/kWh`);
    if (t?.min) parts.push(`${euro(t.min)}/min`);
    if (t?.start) parts.push(`${euro(t.start)} start`);
    const dest = `${c.lat},${c.lon}`;
    const card = document.getElementById("card");
    card.innerHTML = `
      <button class="close" aria-label="Close">✕</button>
      <h2 id="card-title">${esc(c.title)}</h2>
      <div class="meta">${esc([c.operator, c.network, c.ref, c.address].filter(Boolean).join(" · ") || "Operator unknown")}</div>
      <div class="price-big" style="--c:var(${c.colourVar})">
        ${c.eff != null
          ? `<strong>≈ ${euro(c.eff)}/kWh</strong><span>${esc(parts.join(" + "))}${t?.updated ? " · checked " + esc(t.updated) : ""}</span>`
          : `<span>No price on file yet. Check Miio or your charging app.</span>`}
      </div>
      ${t?.note ? `<div class="meta">${esc(t.note)}</div>` : ""}
      ${t?.later ? `<div class="meta">⚠️ ${esc(t.later)}</div>` : ""}
      ${c.eff != null ? `<div class="meta">Operator price before VAT, MOBI.E fee and your app's fee.</div>` : ""}
      ${c.mobie ? "" : `<div class="meta">No MOBI.E code: Miio may not work here, you may need to pay at the charger.</div>`}
      <ul class="sockets">
        ${(c.sockets || []).map((s) => `<li>${s.count}× ${esc(s.type)}${s.kw ? " · " + fmtKw(s.kw) + " kW" : ""}${socketPrice(s, t)}</li>`).join("")
          || (c.max_kw ? `<li>Up to ${fmtKw(c.max_kw)} kW</li>` : "")}
        ${c.opening_hours ? `<li>🕒 ${esc(c.opening_hours)}</li>` : ""}
      </ul>
      <div class="nav">
        <a href="https://www.google.com/maps/dir/?api=1&destination=${dest}" target="_blank" rel="noopener">Google Maps</a>
        <a class="alt" href="https://maps.apple.com/?daddr=${dest}" target="_blank" rel="noopener">Apple Maps</a>
        <a class="alt" href="https://waze.com/ul?ll=${dest}&navigate=yes" target="_blank" rel="noopener">Waze</a>
      </div>
      <div class="id">${c.mobie ? "MOBI.E code" : "ID"}: ${esc(c.id)}</div>`;
    card.hidden = false;
    card.querySelector(".close").onclick = closeCard;
    document.getElementById("sheet").classList.remove("open");
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

  function closeCard() {
    document.getElementById("card").hidden = true;
    state.selected = null;
  }

  // ---------- controls ----------
  document.querySelectorAll(".chip[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.filter;
      state.filters[k] = !state.filters[k];
      b.setAttribute("aria-pressed", state.filters[k]);
      render();
    })
  );
  document.getElementById("sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    if (state.sort === "distance" && !state.me) locate();
    else renderList();
  });
  const sheet = document.getElementById("sheet");
  document.getElementById("sheet-handle").addEventListener("click", () => {
    const open = sheet.classList.toggle("open");
    document.getElementById("sheet-handle").setAttribute("aria-expanded", open);
    if (open) closeCard();
  });
  document.getElementById("locate").addEventListener("click", locate);
  map.on("moveend", renderList);
  map.on("click", closeCard);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeCard());

  let meMarker;
  function locate() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.me = [pos.coords.latitude, pos.coords.longitude];
        meMarker?.remove();
        meMarker = L.circleMarker(state.me, {
          radius: 8, color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1,
        }).addTo(map);
        map.setView(state.me, Math.max(map.getZoom(), 13));
        renderList();
      },
      () => alertLite("Location is off. You can still browse the map."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }
  function alertLite(msg) {
    document.getElementById("sheet-title").textContent = msg;
  }

  // ---------- helpers ----------
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
