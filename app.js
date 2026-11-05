/* Rastro · rastreador de libros
 * Principio: solo se muestra lo que cada fuente confirma en el momento.
 * - Consultas reales (JSON, en directo): Open Library, Archive.org, Casa del Libro, Google Books.
 * - Búsqueda directa (enlaces preparados): IberLibro, AbeBooks, Amazon, La Central, Laie.
 */

const $ = (sel) => document.querySelector(sel);

const state = { query: "", isbn: null };

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function detectIsbn(raw) {
  const clean = raw.replace(/[-\s]/g, "");
  if (/^(97[89])?\d{9}[\dXx]$/.test(clean) && (clean.length === 10 || clean.length === 13)) return clean;
  return null;
}

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

/* ---------- Fuentes de consulta real ---------- */

async function queryOpenLibrary(query, isbn) {
  const fields = "key,title,author_name,first_publish_year,isbn,ia,ebook_access,has_fulltext,cover_i,publisher";
  const url = isbn
    ? `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}&limit=8&fields=${fields}`
    : `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=12&fields=${fields}`;
  const data = await fetchJson(url);
  return (data.docs || []).map((d) => ({
    source: "Open Library",
    key: d.key,
    title: d.title || "Sin título",
    authors: d.author_name || [],
    year: d.first_publish_year || null,
    isbn: (d.isbn || [])[0] || null,
    isbns: d.isbn || [],
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
    ia: d.ia || [],
    ebookAccess: d.ebook_access || "no_ebook",
    hasFulltext: !!d.has_fulltext,
    workUrl: "https://openlibrary.org" + d.key,
  }));
}

async function queryArchiveOrg(query, isbn) {
  const q = isbn ? `${isbn} AND mediatype:texts` : `(${query}) AND mediatype:texts`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&rows=6&output=json`;
  const data = await fetchJson(url);
  return ((data.response && data.response.docs) || []).map((d) => ({
    identifier: d.identifier,
    title: d.title || "Sin título",
    creator: Array.isArray(d.creator) ? d.creator.join(", ") : d.creator || "",
    year: d.year || null,
    url: `https://archive.org/details/${d.identifier}`,
  }));
}

async function queryCasaDelLibro(query, isbn) {
  const q = isbn || query;
  const url = `https://api.empathy.co/search/v1/query/cdl/search?query=${encodeURIComponent(q)}&lang=es&store=es&rows=8&start=0`;
  const data = await fetchJson(url);
  const items = (data.catalog && data.catalog.content) || [];
  return items.map((b) => ({
    name: b.name || "Sin título",
    authors: b.authors
      ? b.authors.filter(
          (v, i, a) =>
            a.findIndex(
              (x) =>
                x
                  .normalize("NFD")
                  .replace(/[\u0300-\u036f]/g, "")
                  .toLowerCase() ===
                v
                  .normalize("NFD")
                  .replace(/[\u0300-\u036f]/g, "")
                  .toLowerCase()
            ) === i
        )
      : [],
    price: b.price && typeof b.price.current === "number" ? b.price.current : null,
    previous: b.price && typeof b.price.previous === "number" ? b.price.previous : null,
    availability: b.availability || null,
    binding: b.encuadernation || null,
    year: b.yearPublication || null,
    publisher: b.editorial || null,
    isbn: b.ean || b.isbn || null,
    url: b.url || null,
    type: b.productType || null,
  }));
}

async function queryGoogleBooks(query, isbn) {
  const q = isbn ? `isbn:${isbn}` : query;
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8&langRestrict=es`;
  const data = await fetchJson(url);
  return (data.items || []).map((it) => {
    const v = it.volumeInfo || {};
    const s = it.saleInfo || {};
    return {
      title: v.title || "Sin título",
      authors: v.authors || [],
      year: v.publishedDate ? v.publishedDate.slice(0, 4) : null,
      publisher: v.publisher || null,
      isbn: ((v.industryIdentifiers || [])[0] || {}).identifier || null,
      cover: v.imageLinks ? v.imageLinks.thumbnail : null,
      link: v.infoLink || null,
      price: s.listPrice ? `${s.listPrice.amount} ${s.listPrice.currencyCode}` : null,
    };
  });
}

/* ---------- Búsqueda directa en tiendas ---------- */

function storeLinks(query, isbn) {
  const term = encodeURIComponent(isbn || query);
  return [
    { name: "IberLibro", kind: "segunda mano", url: `https://www.iberlibro.com/servlet/SearchResults?kn=${term}` },
    { name: "AbeBooks", kind: "segunda mano", url: `https://www.abebooks.com/servlet/SearchResults?kn=${term}` },
    { name: "Amazon", kind: "gran tienda", url: `https://www.amazon.es/s?k=${term}` },
    { name: "La Central", kind: "librería", url: `https://www.lacentral.com/buscador?s=${term}` },
    { name: "Laie", kind: "librería", url: `https://www.laie.es/es/searchres/all?search=${term}` },
  ];
}

/* ---------- Render ---------- */

function setChip(id, text, cls) {
  let el = document.getElementById("chip-" + id);
  if (!el) {
    el = document.createElement("span");
    el.id = "chip-" + id;
    el.className = "chip";
    $("#status-bar").appendChild(el);
  }
  el.className = "chip " + (cls || "");
  el.textContent = text;
}

function clearChips() { $("#status-bar").innerHTML = ""; }

function cardBadges(book) {
  const out = [];
  if (book.ia && book.ia.length && (book.ebookAccess === "public")) out.push('<span class="badge badge-free">lectura gratis</span>');
  else if (book.ia && book.ia.length && book.ebookAccess === "borrowable") out.push('<span class="badge badge-borrow">préstamo gratis</span>');
  return out.join("");
}

function renderFree(olBooks, iaDocs) {
  const box = $("#free-cards");
  const withAccess = olBooks.filter((b) => b.ia && b.ia.length && (b.ebookAccess === "public" || b.ebookAccess === "borrowable"));
  let html = "";
  withAccess.slice(0, 8).forEach((b) => {
    const mode = b.ebookAccess === "public" ? "Lectura en línea" : "Préstamo con cuenta gratuita";
    html += `<div class="card" data-ia="${esc(b.ia[0])}">
      ${b.cover ? `<img src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
      <div class="card-badges">${cardBadges(b)}</div>
      <h3>${esc(b.title)}</h3>
      <p class="meta">${esc(b.authors.join(", "))}${b.year ? " · " + b.year : ""}</p>
      <p class="meta">${mode} · Archive.org</p>
    </div>`;
  });
  const known = new Set(withAccess.flatMap((b) => b.ia));
  const extra = iaDocs.filter((d) => !known.has(d.identifier)).slice(0, 6);
  extra.forEach((d) => {
    html += `<div class="card" data-ia="${esc(d.identifier)}">
      <div class="card-badges"><span class="badge badge-free">archive.org</span></div>
      <h3>${esc(d.title)}</h3>
      <p class="meta">${esc(d.creator)}${d.year ? " · " + esc(d.year) : ""}</p>
      <p class="meta">Ejemplar digital localizado en Archive.org</p>
    </div>`;
  });
  box.innerHTML = html || '<p class="empty-note">No se han localizado ejemplares digitales gratuitos para esta búsqueda en Open Library / Archive.org.</p>';
  box.querySelectorAll(".card[data-ia]").forEach((c) =>
    c.addEventListener("click", () => window.open(`https://archive.org/details/${c.dataset.ia}`, "_blank", "noopener")));
}

function renderCdl(items) {
  const box = $("#cdl-cards");
  box.innerHTML = items.slice(0, 8).map((b, i) => `
    <div class="card" data-cdl="${i}">
      <h3>${esc(b.name)}</h3>
      <p class="meta">${esc(b.authors.join(", "))}${b.publisher ? " · " + esc(b.publisher) : ""}${b.year ? " · " + esc(b.year) : ""}</p>
      ${b.binding ? `<p class="meta">${esc(b.binding)}</p>` : ""}
      ${b.price != null
        ? `<p class="price">${b.price.toFixed(2).replace(".", ",")} €${b.previous && b.previous > b.price ? `<span class="was">${b.previous.toFixed(2).replace(".", ",")} €</span>` : ""}</p>`
        : '<p class="meta">Precio no comunicado</p>'}
      ${b.availability ? `<p class="avail${/sin stock|agotado|no disponible/i.test(b.availability) ? " out" : ""}">${esc(b.availability)}</p>` : ""}
    </div>`).join("") || '<p class="empty-note">Casa del Libro no ha devuelto resultados para esta búsqueda.</p>';
  box.querySelectorAll(".card[data-cdl]").forEach((c) =>
    c.addEventListener("click", () => {
      const b = items[+c.dataset.cdl];
      if (b && b.url) window.open(b.url, "_blank", "noopener");
    }));
}

function renderCatalog(olBooks, gbBooks, gbError) {
  const box = $("#catalog-cards");
  let html = olBooks.slice(0, 12).map((b, i) => `
    <div class="card" data-ol="${i}">
      ${b.cover ? `<img src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
      <h3>${esc(b.title)}</h3>
      <p class="meta">${esc(b.authors.join(", "))}${b.year ? " · " + b.year : ""}</p>
      ${b.isbn ? `<p class="meta">ISBN ${esc(b.isbn)}</p>` : ""}
    </div>`).join("");
  box.innerHTML = html || '<p class="empty-note">No hay fichas bibliográficas para esta búsqueda en Open Library' + (gbError ? " y Google Books no está disponible ahora." : " y Google Books no ha aportado más fichas.") + '</p>';
  box.querySelectorAll(".card[data-ol]").forEach((c) =>
    c.addEventListener("click", () => openModal(olBooks[+c.dataset.ol])));
  if (gbBooks && gbBooks.length) {
    // Añade solo fichas de Google Books que no dupliquen título+autor de Open Library
    const seen = new Set(olBooks.map((b) => (b.title + "|" + b.authors.join(",")).toLowerCase()));
    const extra = gbBooks.filter((g) => !seen.has((g.title + "|" + g.authors.join(",")).toLowerCase())).slice(0, 6);
    extra.forEach((g) => {
      const div = document.createElement("div");
      div.className = "card";
      div.innerHTML = `
        ${g.cover ? `<img src="${esc(g.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
        <h3>${esc(g.title)}</h3>
        <p class="meta">${esc(g.authors.join(", "))}${g.year ? " · " + esc(g.year) : ""}</p>
        ${g.publisher ? `<p class="meta">${esc(g.publisher)}</p>` : ""}
        ${g.price ? `<p class="meta">eBook Google Play: ${esc(g.price)}</p>` : ""}
        <p class="meta">Fuente: Google Books</p>`;
      if (g.link) div.addEventListener("click", () => window.open(g.link, "_blank", "noopener"));
      box.appendChild(div);
    });
  }
}

function renderStores() {
  const box = $("#store-links");
  box.innerHTML = storeLinks(state.query, state.isbn).map((s) => `
    <a class="store-btn" href="${s.url}" target="_blank" rel="noopener">
      <span class="store-name">${esc(s.name)}</span>
      <span class="store-kind">${esc(s.kind)} · buscar "${esc(state.isbn || state.query)}"</span>
    </a>`).join("");
}

/* ---------- Modal ---------- */

function openModal(b) {
  const links = storeLinks(b.title + " " + b.authors.join(" "), b.isbn || (b.isbns && b.isbns[0]) || null);
  $("#modal-body").innerHTML = `
    ${b.cover ? `<img src="${esc(b.cover)}" alt="">` : ""}
    <h3>${esc(b.title)}</h3>
    <p class="meta">${esc(b.authors.join(", "))}${b.year ? " · " + b.year : ""}</p>
    ${b.isbn ? `<p class="meta">ISBN ${esc(b.isbn)}</p>` : ""}
    <div class="modal-section">
      <h4>Ver ficha</h4>
      <div class="modal-stores"><a class="store-btn" href="${esc(b.workUrl)}" target="_blank" rel="noopener"><span class="store-name">Open Library</span></a></div>
    </div>
    <div class="modal-section">
      <h4>Buscar esta edición en tiendas <span class="badge badge-link">búsqueda directa</span></h4>
      <p class="meta">El precio y el stock se comprueban en la web de cada tienda.</p>
      <div class="modal-stores">${links.map((s) => `
        <a class="store-btn" href="${s.url}" target="_blank" rel="noopener">
          <span class="store-name">${esc(s.name)}</span><span class="store-kind">${esc(s.kind)}</span>
        </a>`).join("")}
      </div>
    </div>`;
  $("#modal").hidden = false;
}

$("#modal-close").addEventListener("click", () => ($("#modal").hidden = true));
$("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) $("#modal").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#modal").hidden = true; });

/* ---------- Orquestación ---------- */

$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("#search-input").value.trim();
  if (!raw) return;
  state.query = raw;
  state.isbn = detectIsbn(raw);
  $("#results").hidden = false;
  $("#search-btn").disabled = true;
  clearChips();
  $("#free-cards").innerHTML = "";
  $("#cdl-cards").innerHTML = "";
  $("#catalog-cards").innerHTML = "";
  renderStores();
  document.getElementById("results").scrollIntoView({ behavior: "smooth", block: "start" });

  setChip("ol", "Open Library", "loading");
  setChip("ia", "Archive.org", "loading");
  setChip("cdl", "Casa del Libro", "loading");
  setChip("gb", "Google Books", "loading");

  const olP = queryOpenLibrary(raw, state.isbn)
    .then((r) => { setChip("ol", `Open Library: ${r.length} fichas`, "ok"); return r; })
    .catch(() => { setChip("ol", "Open Library: sin respuesta", "warn"); return []; });
  const iaP = queryArchiveOrg(raw, state.isbn)
    .then((r) => { setChip("ia", `Archive.org: ${r.length} ejemplares`, "ok"); return r; })
    .catch(() => { setChip("ia", "Archive.org: sin respuesta", "warn"); return []; });
  const cdlP = queryCasaDelLibro(raw, state.isbn)
    .then((r) => { setChip("cdl", `Casa del Libro: ${r.length} resultados`, "ok"); return r; })
    .catch(() => { setChip("cdl", "Casa del Libro: sin respuesta", "warn"); return []; });
  const gbP = queryGoogleBooks(raw, state.isbn)
    .then((r) => { setChip("gb", `Google Books: ${r.length} fichas`, "ok"); return { books: r, error: false }; })
    .catch(() => { setChip("gb", "Google Books: no disponible ahora (cuota)", "warn"); return { books: [], error: true }; });

  const [ol, ia, cdl, gb] = await Promise.all([olP, iaP, cdlP, gbP]);
  renderFree(ol, ia);
  renderCdl(cdl);
  renderCatalog(ol, gb.books, gb.error);
  $("#search-btn").disabled = false;
});
