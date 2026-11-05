/* ============================================================================
 * Rastro · rastreador de libros
 * Principio: solo se muestra lo que cada fuente confirma en el momento.
 *
 * Estructura modular (una web estática, sin build, gratis en GitHub Pages):
 *   1. Utilidades          — helpers puros
 *   2. Fuentes             — una función queryX() por fuente + storeLinks()
 *   3. Referencias         — lista persistente + generadores de cita
 *   4. Render              — pintado de cada sección
 *   5. Orquestación        — búsqueda y eventos
 *
 * Para añadir una fuente nueva: escribe su queryX() en (2), su chip y su
 * render en (4), y engánchala en la orquestación (5). Sin tocar lo demás.
 *
 * Límites reales (ver sección Fuentes de la web): sin backend propio; cada
 * consulta depende de que la fuente permita CORS y de sus cuotas gratuitas
 * (Google Books a veces agota la suya). Escalable = añadir fuentes/módulos
 * sin rehacer la app, no capacidad ilimitada.
 * ========================================================================== */

const $ = (sel) => document.querySelector(sel);

const state = { query: "", isbn: null, lang: "es" };

/* ==================== 1. Utilidades ==================== */

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

/* Selector de idioma de los libros. Codigos por fuente: Open Library usa
   ISO 639-2 (nivel de OBRA: coincide si alguna edicion existe en ese idioma),
   Archive.org nombres en ingles, Google Books ISO 639-1 (langRestrict).
   Casa del Libro no comunica el idioma: sus resultados NO se filtran y se
   indica en su seccion. "all" = sin filtro en ninguna fuente. */
const LANGS = {
  es: { ol: "spa", ia: "Spanish",    gb: "es", label: "español" },
  ca: { ol: "cat", ia: "Catalan",    gb: "ca", label: "catalán" },
  en: { ol: "eng", ia: "English",    gb: "en", label: "inglés" },
  fr: { ol: "fre", ia: "French",     gb: "fr", label: "francés" },
  de: { ol: "ger", ia: "German",     gb: "de", label: "alemán" },
  it: { ol: "ita", ia: "Italian",    gb: "it", label: "italiano" },
  pt: { ol: "por", ia: "Portuguese", gb: "pt", label: "portugués" },
};
function activeLang() { return state.lang === "all" ? null : LANGS[state.lang]; }

const STOP_TOKENS = new Set(["de", "del", "la", "el", "los", "las", "un", "una", "y", "en", "con", "por", "para", "the", "of", "and"]);

function normTxt(str) {
  return (str || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/* Coincidencia amplia pero honesta: todos los términos significativos en el
   título, o alguno en el autor. Evita presentar como hallazgo algo ajeno. */
function matchesQueryLoose(title, creator) {
  if (state.isbn) return true;
  const toks = normTxt(state.query).split(/[^a-z0-9áéíóúüñ]+/).filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
  if (!toks.length) return true;
  const t = normTxt(title);
  const c = normTxt(creator);
  return toks.every((x) => t.includes(x)) || (c && toks.some((x) => c.includes(x)));
}

/* Dedupe insensible a mayúsculas y tildes */
function dedupeNames(names) {
  return (names || []).filter(
    (v, i, a) => a.findIndex((x) => normTxt(x) === normTxt(v)) === i
  );
}

/* ==================== 2. Fuentes ==================== */

async function queryOpenLibrary(query, isbn) {
  const L = activeLang();
  const fields = "key,title,author_name,first_publish_year,isbn,ia,ebook_access,has_fulltext,cover_i,publisher,language";
  let url = isbn
    ? `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}&limit=8&fields=${fields}`
    : `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=12&fields=${fields}`;
  if (L) url += `&language=${L.ol}`; // nivel de obra: alguna edicion en ese idioma
  const data = await fetchJson(url);
  return (data.docs || []).map((d) => ({
    source: "Open Library",
    key: d.key,
    title: d.title || "Sin título",
    authors: d.author_name || [],
    year: d.first_publish_year || null,
    publisher: (d.publisher || [])[0] || null,
    isbn: (d.isbn || [])[0] || null,
    isbns: d.isbn || [],
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
    ia: d.ia || [],
    ebookAccess: d.ebook_access || "no_ebook",
    hasFulltext: !!d.has_fulltext,
    languages: d.language || [],
    workUrl: "https://openlibrary.org" + d.key,
  }));
}

async function queryArchiveOrg(query, isbn) {
  const L = activeLang();
  const q = (isbn ? `${isbn} AND mediatype:texts` : `(${query}) AND mediatype:texts`) +
    (L ? ` AND language:(${L.ia})` : "");
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
    authors: dedupeNames(b.authors),
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
  const L = activeLang();
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8${L ? "&langRestrict=" + L.gb : ""}`;
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

/* Resolución de EDICIÓN en el idioma elegido. El filtro language= de Open
   Library es a nivel de OBRA; aquí se confirma la edición concreta leyendo
   los metadatos de sus ediciones (nunca se infiere por título o portada). */
async function editionsInLang(work, L) {
  const data = await fetchJson(`https://openlibrary.org${work.key}/editions.json?limit=50`);
  const langKey = "/languages/" + L.ol;
  return (data.entries || [])
    .filter((e) => (e.languages || []).some((x) => x.key === langKey))
    .map((e) => {
      const y = (e.publish_date || "").match(/(\d{4})/);
      return {
        source: "Open Library",
        key: e.key,
        title: e.title || work.title,
        authors: work.authors,
        year: y ? y[1] : null,
        publisher: (e.publishers || [])[0] || null,
        isbn: (e.isbn_13 || [])[0] || (e.isbn_10 || [])[0] || null,
        isbns: [...(e.isbn_13 || []), ...(e.isbn_10 || [])],
        cover: (e.covers && e.covers.length) ? `https://covers.openlibrary.org/b/id/${e.covers[0]}-M.jpg` : work.cover,
        workUrl: "https://openlibrary.org" + e.key,
        ia: e.ocaid ? [e.ocaid] : [],
        editionLang: L.label,
      };
    });
}

/* Acceso por ÍTEM en Archive.org, de los metadatos del propio ítem:
   restringido -> préstamo por comprobar; no restringido -> lectura en línea. */
async function iaAccess(ocaid) {
  const md = ((await fetchJson(`https://archive.org/metadata/${encodeURIComponent(ocaid)}`)).metadata) || {};
  return String(md["access-restricted-item"]) === "true" ? "borrowable" : "public";
}

/* ---------- Descargas gratuitas (derechos claros, consulta real) ---------- */

/* Standard Ebooks: catálogo SOLO en inglés, dominio público en EE. UU.
   OPDS/Atom con CORS abierto y ficheros estáticos verificables por HEAD. */
async function queryStandardEbooks(query) {
  const L = activeLang();
  if (L && L.gb !== "en") return { items: [], skipped: true };
  const url = `https://standardebooks.org/feeds/opds/all?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const doc = new DOMParser().parseFromString(await res.text(), "application/xml");
  const items = [...doc.querySelectorAll("entry")].map((e) => {
    const links = [...e.querySelectorAll("link")];
    const acq = links.filter((l) => (l.getAttribute("rel") || "").includes("acquisition"));
    const href = (type, skip) => {
      const l = acq.find((x) => x.getAttribute("type") === type && !(skip && skip.test(x.getAttribute("href") || "")));
      return l ? l.getAttribute("href") : null;
    };
    const alt = links.find((l) => (l.getAttribute("rel") || "").endsWith("alternate") && (l.getAttribute("type") || "").includes("html"));
    return {
      source: "Standard Ebooks",
      title: (e.querySelector("title") || {}).textContent || "Sin título",
      authors: [...e.querySelectorAll("author name")].map((a) => a.textContent),
      url: alt ? alt.getAttribute("href") : null,
      epub: href("application/epub+zip", /_advanced\.epub/),
      azw3: href("application/x-mobipocket-ebook"),
      web: href("application/xhtml+xml"),
    };
  }).filter((b) => b.epub || b.web);
  /* Descarga verificada: HEAD real a cada fichero antes de mostrarlo. */
  const checked = await Promise.all(items.slice(0, 8).map(async (b) => {
    if (!b.epub) return b;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(b.epub, { method: "HEAD", signal: ctrl.signal });
      clearTimeout(t);
      return r.ok ? b : { ...b, epub: null };
    } catch { return { ...b, epub: null }; }
  }));
  return { items: checked.filter((b) => b.epub || b.web), skipped: false };
}

/* Wikisource: texto libre en la edición del idioma elegido (con "todos", la
   española). El EPUB lo genera al abrirlo la herramienta oficial WS Export;
   sin CORS en ese servicio, no verificable ítem a ítem: se rotula como
   "generado al abrirlo" y se excluyen subpáginas (capítulos sueltos). */
async function queryWikisource(query, isbn) {
  if (isbn) return []; // Wikisource no indexa por ISBN de forma fiable
  const L = activeLang();
  const lg = L ? L.gb : "es";
  const url = `https://${lg}.wikisource.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=0&srlimit=8&format=json&origin=*`;
  const data = await fetchJson(url);
  return (((data.query && data.query.search) || []))
    .map((h) => h.title)
    .filter((t) => !t.includes("/")) // sin capítulos sueltos
    .filter((t) => matchesQueryLoose(t, ""))
    .slice(0, 5)
    .map((t) => {
      const page = encodeURIComponent(t.replace(/ /g, "_"));
      return {
        source: "Wikisource",
        title: t,
        authors: [],
        url: `https://${lg}.wikisource.org/wiki/${page}`,
        epub: `https://ws-export.wmcloud.org/?format=epub&lang=${lg}&page=${page}`,
        wikiLang: lg,
      };
    });
}

/* ---------- Búsqueda directa en tiendas (esta versión no las consulta) ---------- */

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

/* ==================== 3. Referencias (lista persistente) ==================== */

const LIST_KEY = "rastro_lista_v1";
const REF_REG = {}; // id -> item citables de la búsqueda actual

function refIdFor(item) {
  return normTxt((item.title || "") + "|" + ((item.authors || [])[0] || "") + "|" + (item.year || "") + "|" + (item.isbn || "") + "|" + (item.kind || ""));
}

function regRef(item) {
  const id = refIdFor(item);
  REF_REG[id] = item;
  return id;
}

function loadList() {
  try { return JSON.parse(localStorage.getItem(LIST_KEY)) || []; } catch { return []; }
}
function saveList(list) {
  localStorage.setItem(LIST_KEY, JSON.stringify(list));
}

async function addToList(id) {
  const item = REF_REG[id];
  if (!item) return;
  const entry = {
    id,
    title: item.title || item.name || "Sin título",
    authors: dedupeNames(item.authors || (item.creator ? [item.creator] : [])),
    year: item.year || null,
    publisher: item.publisher || null,
    isbn: item.isbn || null,
    url: item.url || item.workUrl || item.link || (item.ia && item.ia[0] ? `https://archive.org/details/${item.ia[0]}` : null),
    kind: item.kind || "print",
    editionNote: null,
  };
  if (entry.authors.some(isOrg)) {
    entry.roleNote = "la fuente lista una entidad como autor: puede ser editora o colaboradora; confirma su rol en la ficha";
  }
  if (entry.kind === "ebook") {
    entry.editionNote = "ejemplar digital: la edición escaneada/publicada se ve en la ficha enlazada";
  }
  /* Citas a partir de una EDICION identificada: si la ficha viene de Open Library
     (datos a nivel de obra), se resuelve la edición por ISBN. Si no se puede,
     NO se mezclan datos de obra con datos de edición: se usa solo obra y se señala. */
  if (item.source === "Open Library" && entry.kind !== "ebook") {
    const isbn = item.isbn || (item.isbns || [])[0] || null;
    if (isbn) {
      try {
        const ed = await fetchJson(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`);
        entry.title = ed.title || entry.title;
        const m = (ed.publish_date || "").match(/(\d{4})/);
        entry.year = m ? m[1] : null;
        entry.publisher = (ed.publishers || [])[0] || null;
        entry.isbn = isbn;
        entry.url = "https://openlibrary.org" + ed.key;
      } catch {
        entry.editionNote = "edición no identificada (sin ficha para su ISBN): se citan solo datos de la obra (título, autores, primera publicación)";
        entry.publisher = null;
        entry.url = item.workUrl || entry.url;
      }
    } else {
      entry.editionNote = "edición no identificada (sin ISBN): se citan solo datos de la obra (título, autores, primera publicación)";
      entry.publisher = null;
    }
  }
  /* loadList despues del await: evita perder entradas al añadir varias a la vez */
  const list = loadList();
  if (!list.some((x) => x.id === id)) { list.push(entry); saveList(list); }
  renderList();
}

function removeFromList(id) {
  saveList(loadList().filter((x) => x.id !== id));
  renderList();
}

/* ---- Datos que faltan: se señalan, nunca se inventan ---- */
function missingFields(it) {
  const m = [];
  if (!realAuthors(it.authors).length) m.push("autor");
  if (!it.year) m.push("año");
  if (!it.publisher) m.push("editorial");
  return m;
}

/* ---- Nombres: "Nombre Apellido1 Apellido2" -> {sur, init} ---- */
const PARTICLES = new Set(["de", "del", "la", "las", "los", "y", "van", "von", "da", "di"]);
const ORG_WORDS = new Set(["biblioteca", "ministerio", "editorial", "universidad", "instituto", "fundacion", "consejo", "academia", "gobierno", "junta", "departamento", "servicio", "archivo", "museo", "cineteca", "filmoteca", "agencia", "comision", "parlamento", "ayuntamiento", "diputacion", "sociedad", "asociacion", "colegio"]);
function isOrg(full) {
  return normTxt(full).split(/[^a-z0-9]+/).some((w) => ORG_WORDS.has(w));
}
function cleanName(full) {
  return (full || "").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}
function splitName(full) {
  full = cleanName(full);
  if (isOrg(full)) return { sur: full, init: "", given: "", corp: true };
  if (!full) return { sur: "", init: "", given: "" };
  if (full.includes(",")) { // ya viene "Apellidos, Nombre"
    const [sur, ...rest] = full.split(",");
    const given = rest.join(" ").trim();
    const init = given.split(" ").filter(Boolean).filter((w) => !PARTICLES.has(normTxt(w))).map((w) => w[0].toUpperCase() + ".").join(" ");
    return { sur: sur.trim(), init, given };
  }
  const w = full.split(" ");
  const isInitTok = (t) => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]\.?$/.test(t);
  /* Heurística: un apellido si el penúltimo token es una inicial ("Amy J. Binder" ->
     Binder, Amy J.); dos apellidos en nombres de 3+ palabras ("Carlos Ruiz Zafón");
     las partículas quedan dentro del apellido ("Ortega y Gasset", "van Beethoven"). */
  let take = w.length >= 3 && !isInitTok(w[w.length - 2]) && !PARTICLES.has(normTxt(w[w.length - 2])) ? 2 : 1;
  while (w.length - take - 1 >= 0) {
    const prev = normTxt(w[w.length - take - 1]);
    if (["y", "e", "i"].includes(prev) && w.length - take - 2 >= 0) { take += 2; continue; } // "Ortega y Gasset"
    if (PARTICLES.has(prev)) { take += 1; continue; } // "van Beethoven", "de la Torre"
    break;
  }
  const sur = w.slice(-take).join(" ");
  const given = w.slice(0, -take).join(" ");
  const init = w.slice(0, -take).filter((x) => !PARTICLES.has(normTxt(x))).map((x) => x[0].toUpperCase() + ".").join(" ");
  return { sur, init, given };
}
function plainName(full) { // "Apellidos, Nombre" -> "Nombre Apellidos"
  full = cleanName(full);
  if (full.includes(",")) {
    const [sur, ...rest] = full.split(",");
    return (rest.join(" ").trim() + " " + sur.trim()).trim();
  }
  return full;
}

/* ---- Generadores de cita. Título en cursiva solo en HTML; al exportar, texto plano. ---- */
function citeAPA7(it) {
  const a = realAuthors(it.authors);
  let auth;
  if (!a.length) auth = null;
  else if (a.length <= 20) {
    const parts = a.map((n) => { const p = splitName(n); return `${p.sur}${p.init ? ", " + p.init : ""}`; });
    auth = parts.length > 1 ? parts.slice(0, -1).join(", ") + ", & " + parts.at(-1) : parts[0];
  } else {
    const parts = a.map((n) => { const p = splitName(n); return `${p.sur}${p.init ? ", " + p.init : ""}`; });
    auth = parts.slice(0, 19).join(", ") + ", … " + parts.at(-1);
  }
  const year = it.year ? `(${it.year}).` : "(s. f.).";
  const title = `${it.title}.`;
  const pub = it.publisher ? ` ${it.publisher}.` : "";
  const url = it.kind === "ebook" && it.url ? ` ${it.url}` : "";
  return auth ? `${auth} ${year} ${title}${pub}${url}` : `${title} ${year}${pub}${url}`;
}

function citeChicago(it) {
  // Chicago 18, bibliografia (guia oficial CMOS): Apellido, Nombre [primer autor invertido; resto en orden natural]. Titulo. Editorial, Ano.
  const a = realAuthors(it.authors);
  const inv = (n) => { if (isOrg(n)) return n; const p = splitName(n); return p.given ? `${p.sur}, ${p.given}` : p.sur; };
  let auth = "";
  if (a.length === 1) auth = inv(a[0]) + ".";
  else if (a.length > 1) {
    const rest = a.slice(1, a.length > 10 ? 7 : undefined).map((n) => (isOrg(n) ? n : plainName(n)));
    const restTxt = rest.length > 1 ? rest.slice(0, -1).join(", ") + ", and " + rest.at(-1) : "and " + rest[0];
    auth = `${inv(a[0])}, ${restTxt}${a.length > 10 ? " et al" : ""}.`;
  }
  const pub = it.publisher ? ` ${it.publisher},` : "";
  const year = it.year ? ` ${it.year}.` : " s. f.";
  const url = it.kind === "ebook" && it.url ? ` ${it.url}` : "";
  return auth ? `${auth} ${it.title}.${pub}${year}${url}` : `${it.title}.${pub}${year}${url}`;
}

function citeMLA(it) {
  const a = realAuthors(it.authors);
  let auth = "";
  const inv1 = (n) => { if (isOrg(n)) return n; const p = splitName(n); return p.given ? `${p.sur}, ${p.given}` : p.sur; };
  if (a.length === 1) auth = inv1(a[0]) + ".";
  else if (a.length === 2) auth = `${inv1(a[0])}, and ${isOrg(a[1]) ? a[1] : plainName(a[1])}.`;
  else if (a.length > 2) auth = `${inv1(a[0])}, et al.`;
  const pub = it.publisher ? `${it.publisher}, ` : "";
  const year = it.year ? `${it.year}.` : "s. f.";
  return `${auth ? auth + " " : ""}${it.title}. ${pub}${year}${it.kind === "ebook" && it.url ? " " + it.url : ""}`;
}

function citeBibTeX(it) {
  const _ba = realAuthors(it.authors); const keyBase = _ba.length ? normTxt(splitName(it.authors[0]).sur).replace(/[^a-z]/g, "") : normTxt(it.title).split(" ")[0].replace(/[^a-z]/g, "");
  const key = `${keyBase}${it.year || "sf"}`;
  const lines = [`@book{${key},`];
  if (_ba.length) lines.push(`  author = {${_ba.map((n) => { const p = splitName(n); return p.given ? `${p.sur}, ${p.given}` : p.sur; }).join(" and ")}},`);
  lines.push(`  title = {${it.title}},`);
  if (it.year) lines.push(`  year = {${it.year}},`);
  if (it.publisher) lines.push(`  publisher = {${it.publisher}},`);
  if (it.isbn) lines.push(`  isbn = {${it.isbn}},`);
  if (it.kind === "ebook" && it.url) lines.push(`  url = {${it.url}},`);
  lines.push(`}`);
  return lines.join("\n");
}

const ANON_RE = /^(an[oó]nimo|anon\.?|anonymous)$/i;
function realAuthors(a) { return (a || []).filter((n) => !ANON_RE.test(cleanName(n))); }

const FORMATS = {
  apa7: { label: "APA 7ª ed.", fn: citeAPA7 },
  chicago: { label: "Chicago 18ª ed. (bibliografía)", fn: citeChicago },
  mla: { label: "MLA 9ª ed.", fn: citeMLA },
  bibtex: { label: "BibTeX", fn: citeBibTeX },
};

function sortedList() {
  return loadList().slice().sort((x, y) =>
    normTxt((realAuthors(x.authors)[0] ? splitName(realAuthors(x.authors)[0]).sur : x.title)).localeCompare(normTxt((realAuthors(y.authors)[0] ? splitName(realAuthors(y.authors)[0]).sur : y.title)), "es"));
}

function renderList() {
  const list = sortedList();
  const fmt = $("#lista-formato").value;
  const box = $("#lista-items");
  document.querySelectorAll(".lista-count").forEach((el) => (el.textContent = list.length ? `(${list.length})` : ""));
  $("#lista-empty").hidden = list.length > 0;
  box.innerHTML = list.map((it, i) => {
    const miss = missingFields(it);
    const cite = FORMATS[fmt].fn(it);
    const htmlCite = fmt === "bibtex" ? `<pre>${esc(cite)}</pre>` : esc(cite).replace(esc(it.title) + ".", `<i>${esc(it.title)}</i>.`);
    return `<li class="ref-item">
      <div class="ref-text">${i + 1}. ${htmlCite}</div>
      <div class="ref-side">
        ${miss.length ? `<span class="badge badge-pending">sin datos de ${miss.join(", ")}</span>` : ""}
        ${it.editionNote ? `<span class="badge badge-pending" title="${esc(it.editionNote)}">${it.kind === "ebook" ? "edición por confirmar en la ficha" : "edición no identificada"}</span>` : ""}
        ${it.roleNote ? `<span class="badge badge-pending" title="${esc(it.roleNote)}">rol de la entidad por confirmar</span>` : ""}
        ${it.url ? `<a class="mini-btn" href="${esc(it.url)}" target="_blank" rel="noopener" title="Ver ficha fuente">↗</a>` : ""}
        <button class="mini-btn" data-edit="${esc(it.id)}" title="Completar o corregir datos">✎</button>
        <button class="mini-btn" data-del="${esc(it.id)}" title="Quitar de la lista">✕</button>
      </div>
    </li>`;
  }).join("");
  box.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => removeFromList(b.dataset.del)));
  box.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => toggleEdit(b.dataset.edit)));
}

/* Edicion manual: la referencia no parece validada solo por estar en un catalogo;
   quien la usa puede completar o corregir los datos dudosos. */
function toggleEdit(id) {
  const list = loadList();
  const it = list.find((x) => x.id === id);
  if (!it) return;
  const li = [...document.querySelectorAll(".ref-item")].find((el) => el.querySelector(`[data-edit="${CSS.escape(id)}"]`));
  if (!li) return;
  if (li.querySelector(".ref-edit")) { renderList(); return; }
  const form = document.createElement("div");
  form.className = "ref-edit";
  form.innerHTML = `
    <label>Autores (separados por ;) — para fijar el apellido escribe «Apellido, Nombre»; una entidad (editorial, biblioteca…) se escribe completa tal cual <input data-f="authors" value="${esc((it.authors || []).join("; "))}"></label>
    <label>Título <input data-f="title" value="${esc(it.title)}"></label>
    <label>Año <input data-f="year" value="${esc(it.year || "")}" placeholder="vacío = s. f."></label>
    <label>Editorial <input data-f="publisher" value="${esc(it.publisher || "")}"></label>
    <label>ISBN <input data-f="isbn" value="${esc(it.isbn || "")}"></label>
    <label>URL <input data-f="url" value="${esc(it.url || "")}"></label>
    <label class="chk"><input type="checkbox" data-f="kind" ${it.kind === "ebook" ? "checked" : ""}> recurso en línea (la cita incluye la URL)</label>
    <button class="btn-ghost" data-save>Guardar</button>`;
  li.appendChild(form);
  form.querySelector("[data-save]").addEventListener("click", () => {
    it.authors = form.querySelector('[data-f="authors"]').value.split(";").map((x) => x.trim()).filter(Boolean);
    it.title = form.querySelector('[data-f="title"]').value.trim() || it.title;
    it.year = form.querySelector('[data-f="year"]').value.trim() || null;
    it.publisher = form.querySelector('[data-f="publisher"]').value.trim() || null;
    it.isbn = form.querySelector('[data-f="isbn"]').value.trim() || null;
    it.url = form.querySelector('[data-f="url"]').value.trim() || null;
    it.kind = form.querySelector('[data-f="kind"]').checked ? "ebook" : "print";
    it.editionNote = null; // quien edita asume la responsabilidad de los datos
    it.roleNote = it.authors.some(isOrg) ? it.roleNote : null;
    saveList(list);
    renderList();
  });
}

function exportText() {
  const fmt = $("#lista-formato").value;
  const list = sortedList();
  const sep = fmt === "bibtex" ? "\n\n" : "\n";
  return list.map((it, i) => fmt === "bibtex" ? FORMATS[fmt].fn(it) : `${i + 1}. ${FORMATS[fmt].fn(it)}`).join(sep);
}

/* ==================== 4. Render ==================== */

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

function refBtn(item) {
  return `<button class="add-ref" data-ref="${esc(regRef(item))}" title="Añadir a mi lista de referencias">＋ Referencia</button>`;
}

function cardBadges(book) {
  const out = [];
  if (book.ia && book.ia.length && (book.ebookAccess === "public")) out.push('<span class="badge badge-free">lectura gratis</span>');
  else if (book.ia && book.ia.length && book.ebookAccess === "borrowable") out.push('<span class="badge badge-pending">préstamo: por comprobar</span>');
  return out.join("");
}

function renderFree(olBooks, iaDocs, filteredFree, L) {
  const box = $("#free-cards");
  const pendingBox = $("#pending-cards");
  const pendingWrap = $("#free-pending");
  let known;
  if (filteredFree) {
    /* Modo idioma: solo ejemplares cuya edición está confirmada en ese idioma
       por metadatos de Open Library, con acceso leído del propio ítem en
       Archive.org. */
    box.innerHTML = filteredFree.slice(0, 8).map((b) => `
      <div class="card" data-ia="${esc(b.ia[0])}">
        ${b.cover ? `<img src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
        <div class="card-badges">${b.access === "public" ? '<span class="badge badge-free">lectura gratis</span>' : '<span class="badge badge-pending">préstamo: por comprobar</span>'}</div>
        <h3>${esc(b.title)}</h3>
        <p class="meta">${esc(b.authors.join(", "))}${b.year ? " · " + b.year : ""}</p>
        <p class="meta">Edición en ${esc(L.label)} confirmada por metadatos · ${b.access === "public" ? "Lectura en línea" : "Préstamo con cuenta gratuita, disponibilidad por comprobar en la ficha"} · Archive.org</p>
        ${refBtn({ ...b, kind: "ebook", url: `https://archive.org/details/${b.ia[0]}` })}
      </div>`).join("") || `<p class="empty-note">No se ha confirmado acceso gratuito a una edición en ${esc(L.label)} para esta búsqueda.</p>`;
    known = new Set(filteredFree.map((b) => b.ia[0]));
  } else {
  const withAccess = olBooks.filter((b) => b.ia && b.ia.length && (b.ebookAccess === "public" || b.ebookAccess === "borrowable"));
  let html = "";
  withAccess.slice(0, 8).forEach((b) => {
    const mode = b.ebookAccess === "public"
      ? "Lectura en línea · Archive.org"
      : "Préstamo con cuenta gratuita · disponibilidad por comprobar en la ficha · Archive.org";
    html += `<div class="card" data-ia="${esc(b.ia[0])}">
      ${b.cover ? `<img src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
      <div class="card-badges">${cardBadges(b)}</div>
      <h3>${esc(b.title)}</h3>
      <p class="meta">${esc(b.authors.join(", "))}${b.year ? " · " + b.year : ""}</p>
      <p class="meta">${mode}</p>
      ${refBtn({ ...b, kind: "ebook", url: `https://archive.org/details/${b.ia[0]}` })}
    </div>`;
  });
  box.innerHTML = html || '<p class="empty-note">No se ha confirmado acceso gratuito (lectura o préstamo) para esta búsqueda en Open Library / Archive.org.</p>';
  known = new Set(withAccess.flatMap((b) => b.ia));
  }

  /* Hallazgos de Archive.org sin disponibilidad confirmada: separados y
     filtrados para no presentar como hallazgo algo ajeno a la búsqueda.
     Con idioma elegido, el idioma de cada ítem ya viene filtrado por la
     propia búsqueda de Archive.org (metadatos por ítem). */
  const extra = iaDocs
    .filter((d) => !known.has(d.identifier))
    .filter((d) => matchesQueryLoose(d.title, d.creator))
    .slice(0, 6);
  pendingBox.innerHTML = extra.map((d) => `<div class="card" data-ia="${esc(d.identifier)}">
      <div class="card-badges"><span class="badge badge-pending">por comprobar</span></div>
      <h3>${esc(d.title)}</h3>
      <p class="meta">${esc(d.creator)}${d.year ? " · " + esc(d.year) : ""}</p>
      <p class="meta">${L ? `Idioma (${esc(L.label)}) confirmado en los metadatos del ítem · ` : "Ejemplar localizado en Archive.org · "}condiciones de acceso en la ficha</p>
      ${refBtn({ title: d.title, authors: d.creator ? [d.creator] : [], year: d.year, url: d.url, kind: "ebook" })}
    </div>`).join("");
  pendingWrap.hidden = extra.length === 0;

  [...box.querySelectorAll(".card[data-ia]"), ...pendingBox.querySelectorAll(".card[data-ia]")].forEach((c) =>
    c.addEventListener("click", () => window.open(`https://archive.org/details/${c.dataset.ia}`, "_blank", "noopener")));
}

function renderCdl(items, L) {
  const box = $("#cdl-cards");
  const btn = $("#cdl-show-unfiltered");
  $("#cdl-note").textContent = "Precio y disponibilidad online comunicados ahora mismo por la propia tienda." +
    (L ? " Casa del Libro no indica el idioma de cada libro en su consulta: con un idioma elegido, sus resultados quedan apartados porque Rastro no puede confirmarlo." : "");
  box.innerHTML = items.slice(0, 8).map((b, i) => `
    <div class="card" data-cdl="${i}">
      <h3>${esc(b.name)}</h3>
      <p class="meta">${esc(b.authors.join(", "))}${b.publisher ? " · " + esc(b.publisher) : ""}${b.year ? " · " + esc(b.year) : ""}</p>
      ${b.binding ? `<p class="meta">${esc(b.binding)}</p>` : ""}
      ${b.price != null
        ? `<p class="price">${b.price.toFixed(2).replace(".", ",")} €${b.previous && b.previous > b.price ? `<span class="was">${b.previous.toFixed(2).replace(".", ",")} €</span>` : ""}</p>`
        : '<p class="meta">Precio no comunicado</p>'}
      ${b.availability ? `<p class="avail${/sin stock|agotado|no disponible/i.test(b.availability) ? " out" : ""}">${esc(b.availability)}</p>` : ""}
      ${refBtn({ title: b.name, authors: b.authors, year: b.year, publisher: b.publisher, isbn: b.isbn, url: b.url, kind: "print" })}
    </div>`).join("") || '<p class="empty-note">Casa del Libro no ha devuelto resultados para esta búsqueda.</p>';
  box.querySelectorAll(".card[data-cdl]").forEach((c) =>
    c.addEventListener("click", () => {
      const b = items[+c.dataset.cdl];
      if (b && b.url) window.open(b.url, "_blank", "noopener");
    }));
  /* Con idioma elegido, los resultados sin filtrar se ocultan por defecto;
     el usuario decide verlos con un botón explícito y rotulado. */
  if (L && items.length) {
    box.hidden = true;
    btn.hidden = false;
    btn.textContent = `Ver ${items.length} resultados de Casa del Libro sin filtrar por idioma (la tienda no lo comunica)`;
    btn.onclick = () => { box.hidden = false; btn.hidden = true; };
  } else {
    box.hidden = false;
    btn.hidden = true;
  }
}

function renderCatalog(olBooks, gbBooks, gbError, editionCards, unconfirmed, L) {
  const box = $("#catalog-cards");
  const src = editionCards || olBooks;
  let html = src.slice(0, 12).map((b, i) => `
    <div class="card" data-ol="${i}">
      ${b.cover ? `<img src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
      ${b.editionLang ? `<div class="card-badges"><span class="badge badge-real">edición en ${esc(b.editionLang)}</span></div>` : ""}
      <h3>${esc(b.title)}</h3>
      <p class="meta">${esc(b.authors.join(", "))}${b.year ? " · " + b.year : ""}</p>
      ${b.publisher ? `<p class="meta">${esc(b.publisher)}</p>` : ""}
      ${b.isbn ? `<p class="meta">ISBN ${esc(b.isbn)}</p>` : ""}
      ${refBtn(b)}
    </div>`).join("");
  if (gbBooks && gbBooks.length) {
    // Solo fichas de Google Books que no dupliquen título+autor de Open Library
    const seen = new Set(src.map((b) => (b.title + "|" + b.authors.join(",")).toLowerCase()));
    const extra = gbBooks.filter((g) => !seen.has((g.title + "|" + g.authors.join(",")).toLowerCase())).slice(0, 6);
    extra.forEach((g) => {
      html += `<div class="card" data-gb>
        ${g.cover ? `<img src="${esc(g.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
        <h3>${esc(g.title)}</h3>
        <p class="meta">${esc(g.authors.join(", "))}${g.year ? " · " + esc(g.year) : ""}</p>
        ${g.publisher ? `<p class="meta">${esc(g.publisher)}</p>` : ""}
        ${g.price ? `<p class="meta">eBook Google Play: ${esc(g.price)}</p>` : ""}
        <p class="meta">Fuente: Google Books</p>
        ${refBtn({ ...g, kind: g.price ? "ebook" : "print" })}
      </div>`;
    });
  }
  box.innerHTML = html || `<p class="empty-note">${L ? `No se ha confirmado ninguna edición en ${esc(L.label)} en Open Library para esta búsqueda` : `No hay fichas bibliográficas para esta búsqueda en Open Library`}${gbError ? " y Google Books no está disponible ahora" : ""}.</p>`;
  box.querySelectorAll(".card[data-ol]").forEach((c) =>
    c.addEventListener("click", () => openModal(src[+c.dataset.ol])));
  /* Obras que Open Library sitúa en el idioma pero cuya edición concreta no
     se ha identificado: separadas y rotuladas, fuera de las coincidencias. */
  const uw = $("#catalog-unconfirmed");
  if (L && unconfirmed && unconfirmed.length) {
    $("#unconfirmed-cards").innerHTML = unconfirmed.slice(0, 6).map((b, i) => `
      <div class="card" data-uu="${i}">
        ${b.cover ? `<img src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
        <div class="card-badges"><span class="badge badge-pending">idioma del ejemplar sin confirmar</span></div>
        <h3>${esc(b.title)}</h3>
        <p class="meta">${esc(b.authors.join(", "))}${b.year ? " · " + b.year : ""}</p>
        ${refBtn(b)}
      </div>`).join("");
    uw.hidden = false;
    $("#unconfirmed-cards").querySelectorAll(".card[data-uu]").forEach((c) =>
      c.addEventListener("click", () => openModal(unconfirmed[+c.dataset.uu])));
  } else {
    uw.hidden = true;
  }
  box.querySelectorAll(".card[data-gb]").forEach((c, i) =>
    c.addEventListener("click", () => { const l = gbBooks.filter((g) => g.link)[i]; if (l && l.link) window.open(l.link, "_blank", "noopener"); }));
}

function renderStores() {
  const box = $("#store-links");
  box.innerHTML = storeLinks(state.query, state.isbn).map((s) => `
    <a class="store-btn" href="${s.url}" target="_blank" rel="noopener">
      <span class="store-name">${esc(s.name)}</span>
      <span class="store-kind">${esc(s.kind)} · buscar "${esc(state.isbn || state.query)}"</span>
    </a>`).join("");
}

function renderDownloads(se, ws) {
  const box = $("#dl-cards");
  let html = "";
  (se.items || []).forEach((b) => {
    html += `<div class="card">
      <div class="card-badges"><span class="badge badge-free">descarga verificada</span></div>
      <h3>${esc(b.title)}</h3>
      <p class="meta">${esc(b.authors.join(", "))}</p>
      <p class="meta">Standard Ebooks · dominio público en EE. UU. (otros países pueden variar) · catálogo en inglés</p>
      <p class="dl-links">
        ${b.epub ? `<a href="${esc(b.epub)}" target="_blank" rel="noopener">EPUB</a>` : ""}
        ${b.azw3 ? `<a href="${esc(b.azw3)}" target="_blank" rel="noopener">Kindle (AZW3)</a>` : ""}
        ${b.web ? `<a href="${esc(b.web)}" target="_blank" rel="noopener">Leer en la web</a>` : ""}
      </p>
      ${refBtn({ title: b.title, authors: b.authors, year: null, publisher: "Standard Ebooks", url: b.url, kind: "ebook" })}
    </div>`;
  });
  ws.forEach((b) => {
    html += `<div class="card">
      <div class="card-badges"><span class="badge badge-pending">EPUB generado al abrirlo</span></div>
      <h3>${esc(b.title)}</h3>
      <p class="meta">Wikisource (${esc(b.wikiLang)}) · texto libre; licencia de cada obra en su página</p>
      <p class="dl-links">
        <a href="${esc(b.epub)}" target="_blank" rel="noopener">Descargar EPUB</a>
        <a href="${esc(b.url)}" target="_blank" rel="noopener">Leer / ficha</a>
      </p>
      ${refBtn({ title: b.title, authors: [], year: null, url: b.url, kind: "ebook" })}
    </div>`;
  });
  box.innerHTML = html || '<p class="empty-note">Sin descargas gratuitas localizadas en Standard Ebooks ni Wikisource para esta búsqueda e idioma.</p>';
}

/* ---------- Modal ---------- */

function openModal(b) {
  const links = storeLinks(b.title + " " + b.authors.join(" "), b.isbn || (b.isbns && b.isbns[0]) || null);
  $("#modal-body").innerHTML = `
    ${b.cover ? `<img src="${esc(b.cover)}" alt="">` : ""}
    <h3>${esc(b.title)}</h3>
    <p class="meta">${esc(b.authors.join(", "))}${b.year ? " · " + b.year : ""}</p>
    ${b.publisher ? `<p class="meta">${esc(b.publisher)}</p>` : ""}
    ${b.isbn ? `<p class="meta">ISBN ${esc(b.isbn)}</p>` : ""}
    <p style="margin:10px 0">${refBtn(b)}</p>
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

/* ==================== 5. Orquestación ==================== */

/* Botones "＋ Referencia": captura en document para que el clic no llegue
   a la tarjeta (que abriría modal o tienda). */
document.addEventListener("click", async (e) => {
  const b = e.target.closest(".add-ref");
  if (!b) return;
  e.stopPropagation();
  e.preventDefault();
  b.textContent = "…";
  await addToList(b.dataset.ref);
  b.textContent = "✓ En tu lista";
  setTimeout(() => (b.textContent = "＋ Referencia"), 1500);
}, true);

$("#lista-formato").addEventListener("change", renderList);
$("#lista-vaciar").addEventListener("click", () => { saveList([]); renderList(); });
$("#lista-copiar").addEventListener("click", async () => {
  const t = exportText();
  if (!t) return;
  try { await navigator.clipboard.writeText(t); $("#lista-copiar").textContent = "Copiada ✓"; }
  catch { $("#lista-copiar").textContent = "No se pudo copiar"; }
  setTimeout(() => ($("#lista-copiar").textContent = "Copiar lista"), 1500);
});
$("#lista-descargar-html").addEventListener("click", () => {
  const list = sortedList();
  if (!list.length) return;
  const fmt = $("#lista-formato").value;
  const body = list.map((it, i) => {
    const c = FORMATS[fmt].fn(it);
    const html = fmt === "bibtex" ? `<pre>${esc(c)}</pre>` : `<p>${i + 1}. ${esc(c).replace(esc(it.title) + ".", `<i>${esc(it.title)}</i>.`)}</p>`;
    return html;
  }).join("\n");
  const doc = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Referencias · Rastro</title><style>body{font-family:Georgia,'Times New Roman',serif;max-width:820px;margin:40px auto;line-height:1.7;color:#111}p{padding-left:2.5em;text-indent:-2.5em}pre{white-space:pre-wrap}</style></head><body><h1>Referencias (${FORMATS[fmt].label})</h1>\n${body}\n</body></html>`;
  const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `rastro-referencias-${fmt}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#lista-descargar").addEventListener("click", () => {
  const t = exportText();
  if (!t) return;
  const fmt = $("#lista-formato").value;
  const blob = new Blob([t + "\n"], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `rastro-referencias-${fmt}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
});

renderList();

$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("#search-input").value.trim();
  if (!raw) return;
  state.query = raw;
  state.isbn = detectIsbn(raw);
  state.lang = $("#lang-select").value;
  $("#results").hidden = false;
  $("#search-btn").disabled = true;
  clearChips();
  const L = activeLang();
  setChip("lang", L ? `Idioma: ${L.label}` : "Idioma: todos", "");
  $("#free-cards").innerHTML = "";
  $("#pending-cards").innerHTML = "";
  $("#free-pending").hidden = true;
  $("#dl-cards").innerHTML = "";
  $("#cdl-cards").innerHTML = "";
  $("#catalog-cards").innerHTML = "";
  renderStores();
  document.getElementById("results").scrollIntoView({ behavior: "smooth", block: "start" });

  setChip("ol", "Open Library", "loading");
  setChip("ia", "Archive.org", "loading");
  setChip("cdl", "Casa del Libro", "loading");
  setChip("gb", "Google Books", "loading");
  setChip("se", "Standard Ebooks", "loading");
  setChip("ws", "Wikisource", "loading");

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

  const seP = queryStandardEbooks(raw)
    .then((r) => { setChip("se", r.skipped ? "Standard Ebooks: solo en inglés" : `Standard Ebooks: ${r.items.length} descargas`, r.skipped ? "" : "ok"); return r; })
    .catch(() => { setChip("se", "Standard Ebooks: sin respuesta", "warn"); return { items: [], skipped: false }; });
  const wsP = queryWikisource(raw, state.isbn)
    .then((r) => { setChip("ws", `Wikisource: ${r.length} obras`, "ok"); return r; })
    .catch(() => { setChip("ws", "Wikisource: sin respuesta", "warn"); return []; });

  const [ol, ia, cdl, gb, se, ws] = await Promise.all([olP, iaP, cdlP, gbP, seP, wsP]);

  /* Con idioma elegido: confirmar la EDICIÓN en ese idioma por metadatos.
     Obras sin edición identificada -> bloque separado "sin confirmar".
     Acceso gratuito: solo ítems de Archive.org de una edición confirmada,
     con el acceso leído de los metadatos de cada ítem. */
  let editionCards = null, unconfirmed = null, filteredFree = null;
  if (L) {
    editionCards = []; unconfirmed = []; filteredFree = [];
    const perWork = await Promise.all(ol.map((w) => editionsInLang(w, L).catch(() => null)));
    const iaCandidates = [];
    perWork.forEach((eds, i) => {
      if (!eds || !eds.length) { unconfirmed.push(ol[i]); return; }
      editionCards.push(eds.find((e) => e.isbn || e.cover) || eds[0]);
      eds.filter((e) => e.ia.length).forEach((e) => iaCandidates.push(e));
    });
    const withAccess = await Promise.all(
      iaCandidates.slice(0, 8).map(async (e) => ({ ...e, access: await iaAccess(e.ia[0]).catch(() => "borrowable") }))
    );
    filteredFree = withAccess;
  }

  renderFree(ol, ia, filteredFree, L);
  renderDownloads(se, ws);
  renderCdl(cdl, L);
  renderCatalog(ol, gb.books, gb.error, editionCards, unconfirmed, L);
  $("#search-btn").disabled = false;
});
