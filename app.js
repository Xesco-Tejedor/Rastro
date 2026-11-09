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

const state = { query: "", isbn: null, lang: "es", original: null, variantLabel: null, _variantRun: false };

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

async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}

/* Selector de idioma de los libros. Codigos por fuente: Open Library usa
   ISO 639-2 (nivel de OBRA: coincide si alguna edicion existe en ese idioma),
   Archive.org nombres en ingles, Google Books ISO 639-1 (langRestrict).
   Casa del Libro no comunica el idioma: sus resultados NO se filtran y se
   indica en su seccion. "all" = sin filtro en ninguna fuente. */
const LANGS = {
  es: { ol: "spa", ia: "Spanish",    gb: "es", label: "español", cdl: ["Castellano", "Español"] },
  ca: { ol: "cat", ia: "Catalan",    gb: "ca", label: "catalán", cdl: ["Catalán"] },
  en: { ol: "eng", ia: "English",    gb: "en", label: "inglés", cdl: ["Inglés"] },
  fr: { ol: "fre", ia: "French",     gb: "fr", label: "francés", cdl: ["Francés"] },
  de: { ol: "ger", ia: "German",     gb: "de", label: "alemán", cdl: ["Alemán"] },
  it: { ol: "ita", ia: "Italian",    gb: "it", label: "italiano", cdl: ["Italiano"] },
  pt: { ol: "por", ia: "Portuguese", gb: "pt", label: "portugués", cdl: ["Portugués"] },
};
function activeLang() { return state.lang === "all" ? null : LANGS[state.lang]; }

const STOP_TOKENS = new Set(["de", "del", "la", "el", "los", "las", "un", "una", "y", "en", "con", "por", "para", "the", "of", "and"]);

function normTxt(str) {
  return (str || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/* Año presentable: "0", "0000" y similares no son una fecha. */
function cleanYear(y) {
  const m = String(y == null ? "" : y).match(/(\d{4})/);
  return m && +m[1] ? m[1] : null;
}

/* ================= Variantes de búsqueda asistidas =================
   Glosario controlado es->en y sinónimos en español. Cada equivalente
   en inglés se verificó contra Open Library (8 nov 2026): devuelve
   obras reales de su tema. No se traduce nada en tiempo de ejecución:
   solo se sugieren términos de este glosario, materias reales del
   catálogo de Open Library, o repetir la misma consulta sin filtro de
   idioma. La consulta original se conserva y la variante activa se
   muestra siempre, con vuelta a la original. */
const GLOSS_EN = {
  joya: "jewelry", joyas: "jewelry", joyeria: "jewellery", alhajas: "jewelry",
  bisuteria: "costume jewelry",
  victoriano: "Victorian", victoriana: "Victorian",
  eduardiano: "Edwardian", eduardiana: "Edwardian",
  isabelino: "Elizabethan", isabelina: "Elizabethan",
  georgiano: "Georgian", georgiana: "Georgian",
  modernismo: "Art Nouveau", deco: "Art Deco",
  medieval: "medieval", renacimiento: "Renaissance",
  barroco: "Baroque", barroca: "Baroque",
  gotico: "Gothic", gotica: "Gothic",
  romanico: "Romanesque", romanica: "Romanesque",
  xix: "19th century", xx: "20th century", xviii: "18th century",
  mueble: "antique furniture", muebles: "antique furniture", mobiliario: "antique furniture",
  silla: "chairs", sillas: "chairs",
  lampara: "lamps", lamparas: "lamps",
  espejo: "mirrors", espejos: "mirrors",
  ceramica: "ceramics", porcelana: "porcelain",
  plata: "silver", plateria: "silver", oro: "gold",
  vidrio: "glassware", cristal: "glassware",
  marfil: "ivory", bronce: "bronze",
  reloj: "antique clocks", relojes: "antique clocks",
  grabado: "engravings", grabados: "engravings", estampa: "engravings", estampas: "engravings",
  litografia: "lithography",
  tapiz: "tapestries", tapices: "tapestries",
  moneda: "coins", monedas: "coins", numismatica: "numismatics",
  sello: "postage stamps", sellos: "postage stamps", estampillas: "postage stamps", filatelia: "philately",
  mapa: "antique maps", mapas: "antique maps", cartografia: "cartography",
  incunable: "incunabula", incunables: "incunabula",
  manuscrito: "manuscripts", manuscritos: "manuscripts",
  encuadernacion: "bookbinding", libris: "bookplates",
  tipografia: "typography", caligrafia: "calligraphy",
  moda: "fashion history", trajes: "costume history",
  encaje: "lace", encajes: "lace", bordado: "embroidery",
  juguete: "antique toys", juguetes: "antique toys",
  muneca: "dolls", munecas: "dolls",
  medalla: "medals", medallas: "medals",
  camafeo: "cameos", camafeos: "cameos",
  abalorio: "beads", abalorios: "beads",
  esmalte: "enamel", esmaltes: "enamel",
  espada: "swords", espadas: "swords", armas: "arms armour",
  antiguedades: "antiques", antiguo: "antique", antigua: "antique",
  siglo: "century",
  postal: "postcards", postales: "postcards",
  cartel: "posters", carteles: "posters",
  fotografia: "photography",
  pelo: "hair",
};
/* Valores que funcionan como adjetivo: se anteponen al sustantivo al
   componer la variante (joyas victorianas -> "Victorian jewelry"). */
const ADJ_EN = new Set([
  "Victorian", "Edwardian", "Elizabethan", "Georgian", "medieval", "Renaissance",
  "Baroque", "Gothic", "Romanesque", "antique", "costume", "Art", "19th", "20th", "18th",
  "hair", "fashion", "postage", "fountain",
]);
const GLOSS_SYN = {
  joyas: ["joyería", "alhajas"], joyeria: ["joyas", "alhajas"], alhajas: ["joyas"],
  muebles: ["mobiliario"], mobiliario: ["muebles"],
  grabados: ["estampas"], estampas: ["grabados"],
  monedas: ["numismática"], numismatica: ["monedas"],
  sellos: ["filatelia"], filatelia: ["sellos"], estampillas: ["sellos"],
  mapas: ["cartografía"], cartografia: ["mapas antiguos"],
  antiguo: ["antigüedades"], antiguedades: ["antigüedades"],
};

function sigTokens(raw) {
  return normTxt(raw).split(/[^a-z0-9áéíóúüñ]+/).filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
}

/* Variante en inglés solo si TODOS los términos significativos tienen
   equivalente en el glosario; si falta alguno, no se compone una
   consulta mezcla que cambiaría el sentido. */
const STYLE_EN = new Set([
  "Victorian", "Edwardian", "Elizabethan", "Georgian", "medieval", "Renaissance",
  "Baroque", "Gothic", "Romanesque", "Art Nouveau", "Art Deco", "19th century", "20th century", "18th century",
]);
function glossEn(t) {
  /* Singular flexible: victorianas -> victoriana, joyas -> joya. */
  return GLOSS_EN[t] || GLOSS_EN[t.replace(/as$/, "a")] || GLOSS_EN[t.replace(/s$/, "")] || null;
}
function englishVariant(raw) {
  const toks = sigTokens(raw);
  if (!toks.length) return null;
  let parts = toks.map(glossEn);
  if (parts.some((p) => !p)) return null;
  /* «siglo XIX» ya queda en "19th century": se retira el "century" suelto,
     y cualquier término simple ya contenido en otro compuesto
     (mapas antiguos -> "antique maps", no "antique maps antique"). */
  if (parts.some((p) => /^\d{2}th century$/.test(p))) parts = parts.filter((p) => p !== "century");
  parts = parts.filter((p, i) =>
    p.includes(" ") || !parts.some((q, j) => j !== i && q.includes(" ") && q.split(" ").includes(p)));
  const style = [], adj = [], noun = [];
  parts.forEach((p) => (STYLE_EN.has(p) ? style : ADJ_EN.has(p.split(" ")[0]) ? adj : noun).push(p));
  const v = [...style, ...adj, ...noun].join(" ");
  return v && normTxt(v) !== normTxt(raw) ? v : null;
}

function applySynonym(raw, token, syn) {
  const escT = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("\\b" + escT + "\\b", "i");
  if (!re.test(raw)) return null;
  let out = raw.replace(re, syn);
  /* Concordancia mínima: variante singular + adjetivo plural femenino
     (joyas victorianas -> joyería victoriana). */
  if (!/s$/.test(syn)) {
    out = out.replace(new RegExp("(" + syn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+\\w*?)as\\b", "i"), "$1a");
  }
  return out;
}

/* Raíz comparativa de 5 letras para solape léxico sin morfología
   compleja (veganismo~vegana, joya~joyas). */
function stem5(t) { return t.slice(0, 5); }
function stemsOverlap(aToks, bToks) {
  /* Solape por prefijo común (min. 4 caracteres): joya~joyas, vegan~*. */
  return aToks.some((a) => bToks.some((b) => {
    const n = Math.min(a.length, b.length, 5);
    return n >= 4 && a.slice(0, n) === b.slice(0, n);
  }));
}

/* Palabras de intención didáctica/formato: no son tema, pero tampoco
   prescindibles en silencio: una variante que las suelta lo declara. */
const INTENT_WORDS = new Set(["aprender", "aprende", "aprendizaje", "ensenar", "enseñar", "ensenanza", "enseñanza", "curso", "cursos", "tutorial", "tutoriales", "introduccion", "introducción", "manual", "manuales", "guia", "guía", "principiante", "principiantes"]);
function droppedIntentWords(raw, clean) {
  const kept = new Set(sigTokens(clean || raw));
  return [...new Set(sigTokens(raw).filter((t) => INTENT_WORDS.has(t) && !kept.has(t)))];
}

/* Pertinencia de una ficha frente a la consulta activa: términos de
   contenido en título o autor. Se retiran palabras de formato/intención
   (libro, novela, autor, niños...) y enlaces (para, sobre...): con una
   sola palabra común no basta cuando la consulta aporta 4+ términos
   («Little Women» no trata de la guerra civil por contener «women»).
   Sin términos medibles no se filtra. */
const PERT_STOP = new Set([...INTENT_WORDS, "libro", "libros", "novela", "novelas", "obra", "obras", "autor", "autora", "autores", "autoras", "escritor", "escritora", "escrito", "escrita", "escritos", "escritas", "lectura", "leer", "para", "sobre", "como", "entre", "desde", "donde", "cuando", "años", "anos", "edad", "niños", "ninos", "niñas", "ninas", "infantil", "infantiles", "juvenil", "juveniles", "por", "del", "los", "las", "una", "uno", "book", "books", "novel", "novels", "author", "authors", "writer", "writers", "written", "about", "children", "child", "kids", "with", "from", "that", "this", "the", "and", "for"]);
function pertinenceTerms(q) {
  return normTxt(q).split(/[^a-z0-9áéíóúüñ]+/).filter((t) => t.length >= 3 && !PERT_STOP.has(t));
}
function pertinentHit(query, hayRaw) {
  const terms = pertinenceTerms(query);
  if (!terms.length) return true;
  const hay = normTxt(hayRaw);
  /* Raíz de 5 letras para familia morfológica y cambio de idioma cercano
     («victorianas» casa con «Victorian», «mujeres» con «mujer»). */
  const hits = terms.filter((t) => hay.includes(t) || (t.length >= 5 && hay.includes(t.slice(0, 5)))).length;
  return hits >= (terms.length >= 4 ? 2 : 1);
}


/* ==================== Por materia de catálogo ====================
   Cuando la búsqueda por términos da poco (o se muestra una variante),
   las fichas por MATERIA respetan el tema porque la materia la asigna el
   catálogo al registrar la obra: se nombra siempre la materia que
   respalda cada ficha. Una condición de autoría (mujer/hombre) se
   verifica en Wikidata; lo no verificable queda marcado, no inventado. */
const FICTION_RE = /novela|ficci[oó]n|fiction|\bnovel|relato|cuento/i;
const JUVENILE_RE = /niñ|infantil|juvenil|children|kids\b|child\b/i;
const GENDER_FEM_RE = /mujer|mujeres|autora|escritora|femenin|\bwomen\b|\bwoman\b|\bfemale\b/i;
const GENDER_MALE_RE = /hombre|hombres|escritor\b|masculin|\bmen\b|\bmale\b/i;

function subjectSlug(name) {
  return name.toLowerCase().replace(/[()]/g, "").replace(/--/g, "_").replace(/[,.;:]/g, " ")
    .replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}
async function olSubjectProbe(slug) {
  try {
    const d = await fetchJson(`https://openlibrary.org/subjects/${encodeURIComponent(slug)}.json?limit=1`);
    return d && d.work_count ? d.work_count : 0;
  } catch { return 0; }
}
async function olSubjectWorks(slug, limit) {
  const d = await fetchJson(`https://openlibrary.org/subjects/${encodeURIComponent(slug)}.json?limit=${limit || 60}`);
  return (d && d.works) || [];
}
async function wikidataGender(name) {
  try {
    const s = await fetchJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=es&uselang=es&format=json&origin=*&limit=3`);
    const cand = (s.search || []).find((c) =>
      normTxt(c.label || "") === normTxt(name) &&
      /escritor|poeta|novelista|autor|writer|poet|novelist|author|dramaturg|guionista/i.test(c.description || ""));
    if (!cand) return null;
    const c = await fetchJson(`https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${cand.id}&property=P21&format=json&origin=*`);
    const v = ((c.claims || {}).P21 || [])[0];
    const id = v && v.mainsnak && v.mainsnak.datavalue && v.mainsnak.datavalue.value && v.mainsnak.datavalue.value.id;
    return id === "Q6581072" ? "female" : id === "Q6581097" ? "male" : null;
  } catch { return null; }
}

async function queryCCUCSubject(subjectWords) {
  const clean = subjectWords.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const cql = `alma.subjects all "${clean}"`;
  const url = "https://eu04.alma.exlibrisgroup.com/view/sru/34CSUC_NETWORK?version=1.2&operation=searchRetrieve&maximumRecords=12&query=" +
    encodeURIComponent(cql);
  const xml = await fetchText(url);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("diagnostic")) throw new Error("SRU diagnostic");
  const total = Number((doc.querySelector("numberOfRecords") || {}).textContent || 0);
  const df = (rec, tag, code) =>
    [...rec.querySelectorAll(`datafield[tag="${tag}"] subfield[code="${code}"]`)].map((x) => x.textContent.trim());
  const items = [...doc.querySelectorAll("recordData > record")].map((rec) => {
    const ctrl = (t) => ((rec.querySelector(`controlfield[tag="${t}"]`) || {}).textContent || "").trim();
    const mms = ctrl("001");
    const ta = (df(rec, "245", "a")[0] || "Sin título").replace(/\s*[/:;]\s*$/, "");
    const authors = dedupeNames([...df(rec, "100", "a"), ...df(rec, "700", "a")].map((a) => a.replace(/[.,;:\s]+$/, "")));
    const dateRaw = df(rec, "260", "c")[0] || df(rec, "264", "c")[0] || ctrl("008").slice(7, 11);
    const y = (dateRaw || "").match(/(\d{4})/);
    return {
      title: ta, authors, year: cleanYear(y ? y[1] : null),
      url: `https://ccuc.csuc.cat/discovery/fulldisplay?docid=alma${encodeURIComponent(mms)}&context=L&vid=${CCUC_VID}&lang=es`,
    };
  });
  return { total, items };
}

async function updateSubjectBlock(scarceArg) {
  const block = $("#block-subject");
  if (!block) return;
  block.hidden = true;
  const raw = state.query;
  if (state.isbn || (!scarceArg && !state.original)) return;
  const clean = cleanedQuery(raw) || raw;
  const enFromGloss = englishVariant(clean);
  const variantIsEn = state.variantLabel && /ingl[eé]s/i.test(state.variantLabel);
  let topicText = enFromGloss || (variantIsEn ? clean : null);
  if (!topicText) {
    /* Puente Wikipedia: tema canónico en español -> título en inglés
       («guerra civil española» -> «Spanish Civil War»), verificado por
       el propio Wikipedia (langlinks). */
    const wiki = await wikipediaTopicVariants(clean).catch(() => null);
    topicText = wiki && wiki.enTitle;
  }
  if (!topicText) return;
  /* Términos de tema: se retiran formato, intención y restricciones de
     autoría (no forman parte de la materia). */
  const topicToks = sigTokens(topicText).filter((t) =>
    !PERT_STOP.has(t) && !FICTION_RE.test(t) && !JUVENILE_RE.test(t) &&
    !GENDER_FEM_RE.test(t) && !GENDER_MALE_RE.test(t) && !INTENT_WORDS.has(t));
  if (!topicToks.length) return;
  const fic = FICTION_RE.test(raw), juv = JUVENILE_RE.test(raw);
  const gender = GENDER_FEM_RE.test(raw) ? "female" : (GENDER_MALE_RE.test(raw) ? "male" : null);

  let sug;
  try { sug = await fetchJson(`https://openlibrary.org/search/subjects.json?q=${encodeURIComponent(topicToks.join(" "))}`); }
  catch { return; }
  const cands = (sug.docs || []).filter((d) => d.name && (d.work_count || 0) > 5);
  if (!cands.length) return;
  const best = cands[0];
  const baseSlug = subjectSlug(best.name);

  /* Materia específica por intención: se cosechan las materias de las
     propias obras del tema amplio y se prueban subdivisiones verificadas
     (la materia solo se usa si el catálogo confirma que tiene obras). */
  let chosenSlug = null, chosenLabel = null, harvestedBase = null;
  const broadWorks = await olSubjectWorks(baseSlug, 60).catch(() => []);
  if (fic || juv) {
    const subjCount = {};
    broadWorks.forEach((w) => (w.subject || []).forEach((x) => { subjCount[x] = (subjCount[x] || 0) + 1; }));
    const bases = Object.keys(subjCount).filter((x) => {
      const toks = sigTokens(x);
      const skel = (x) => x.replace(/[aeiou]/g, "");
      const tokEq = (t, u) => skel(u).startsWith(skel(t).slice(0, 3)) || skel(t).startsWith(skel(u).slice(0, 3));
      return toks.length > topicToks.length && topicToks.every((t) => toks.some((u) => tokEq(t, u)));
    }).sort((a, b) => subjCount[b] - subjCount[a]);
    harvestedBase = bases[0] || null;
    const probes = [];
    if (harvestedBase) {
      const bs = subjectSlug(harvestedBase);
      if (fic) probes.push({ slug: bs + "_fiction", label: harvestedBase + " -- Fiction" });
      if (juv) { probes.push({ slug: bs + "_juvenile_literature", label: harvestedBase + " -- Juvenile literature" }); probes.push({ slug: bs + "_juvenile_fiction", label: harvestedBase + " -- Juvenile fiction" }); }
    }
    if (fic) probes.push({ slug: baseSlug + "_fiction", label: best.name + " -- Fiction" });
    if (juv) { probes.push({ slug: baseSlug + "_juvenile_literature", label: best.name + " -- Juvenile literature" }); probes.push({ slug: baseSlug + "_juvenile_fiction", label: best.name + " -- Juvenile fiction" }); }
    for (const pr of probes) {
      if (await olSubjectProbe(pr.slug) > 0) { chosenSlug = pr.slug; chosenLabel = pr.label; break; }
    }
  }
  if (!chosenSlug) { chosenSlug = baseSlug; chosenLabel = best.name; }

  let works = chosenSlug === baseSlug ? broadWorks : await olSubjectWorks(chosenSlug, 60).catch(() => []);
  let filtered = true;
  if (fic) { const f = works.filter((w) => (w.subject || []).some((x) => /fiction|novela|ficci/i.test(x))); if (f.length) works = f; else filtered = false; }
  if (juv) { const f = works.filter((w) => (w.subject || []).some((x) => /juvenil|children/i.test(x))); if (f.length) works = f; else filtered = false; }
  if (!works.length) return;

  /* CCUC con la misma materia (LCSH en inglés es lo habitual en su SRU). */
  const ccucWords = (harvestedBase || best.name).replace(/--/g, " ") + (fic ? " Fiction" : juv ? " Juvenile literature" : "");
  const ccuc = await queryCCUCSubject(ccucWords).catch(() => null);

  /* Render */
  const note = $("#subject-note"), cardsBox = $("#subject-cards"), ccucBox = $("#subject-ccuc");
  const shown = works.slice(0, 8);
  const prettyLabel = chosenLabel.replace(/,\s*/g, ", ").replace(/\s*--\s*/g, " › ");
  note.innerHTML = `La búsqueda por palabras da poco. Estas obras llevan en su registro la materia <strong>«${esc(prettyLabel)}»</strong>, asignada por el catálogo (Open Library), no interpretada por Rastro.` +
    (filtered ? "" : ` No todas llevan la subdivisión de ficción o público: se muestran las del tema.`);

  cardsBox.innerHTML = shown.map((w, i) => {
    const author = (w.authors || [])[0] && (w.authors || [])[0].name || "";
    const year = w.first_publish_year || null;
    const cover = w.cover_id ? `https://covers.openlibrary.org/b/id/${w.cover_id}-M.jpg` : null;
    const freeOk = (w.availability && (w.availability.is_readable || w.availability.is_browseable)) || w.public_scan;
    const url = "https://openlibrary.org" + w.key;
    return `<div class="card" data-sb="${i}">
      ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
      <div class="card-badges">${freeOk ? '<span class="badge badge-free">lectura gratis</span>' : ""}<span class="badge badge-real" data-gbadge="${i}">materia de catálogo</span></div>
      <h3>${esc(w.title || "Sin título")}</h3>
      <p class="meta">${esc(author)}${year ? " · " + year : ""}</p>
      <p class="meta">Materia: ${esc(prettyLabel)} · Open Library</p>
      ${refBtn({ title: w.title || "", authors: author ? [author] : [], year, url, kind: freeOk ? "ebook" : "print" })}
    </div>`;
  }).join("");
  cardsBox.querySelectorAll(".card[data-sb]").forEach((c) =>
    c.addEventListener("click", (ev) => { if (ev.target.closest("button")) return; window.open("https://openlibrary.org" + shown[+c.dataset.sb].key, "_blank", "noopener"); }));

  if (ccuc && ccuc.total > 0) {
    const official = `https://ccuc.csuc.cat/discovery/search?query=lsr02,contains,${encodeURIComponent(ccucWords)}&vid=${CCUC_VID}&lang=es`;
    ccucBox.innerHTML = `<p class="section-note sub">En el CCUC (universidades catalanas, Biblioteca de Catalunya y CSUC), <a href="${esc(official)}" target="_blank" rel="noopener">${ccuc.total} registros con esa materia</a>:</p>
      <div class="cards">${ccuc.items.slice(0, 6).map((b) => `
        <div class="card" data-ccu="${esc(b.url)}">
          <h3>${esc(b.title)}</h3>
          <p class="meta">${esc(b.authors.join(", "))}${b.year ? " · " + b.year : ""}</p>
          <p class="meta">Materia en el registro del catálogo colectivo CCUC · biblioteca y disponibilidad en la ficha enlazada</p>
        </div>`).join("")}</div>`;
    ccucBox.querySelectorAll(".card[data-ccu]").forEach((c) =>
      c.addEventListener("click", () => window.open(c.dataset.ccu, "_blank", "noopener")));
  } else {
    ccucBox.innerHTML = "";
  }
  block.hidden = false;

  /* Verificación de autoría en Wikidata (solo si la búsqueda la pide). */
  if (gender) {
    const gNote = document.createElement("p");
    gNote.className = "section-note sub";
    gNote.textContent = gender === "female"
      ? "Verificando la autoría mujer en Wikidata…"
      : "Verificando la autoría varón en Wikidata…";
    note.after(gNote);
    const results = await Promise.all(shown.map(async (w) => {
      const a = (w.authors || [])[0];
      return a && a.name ? await wikidataGender(a.name) : null;
    }));
    results.forEach((g, i) => {
      const el = cardsBox.querySelector(`[data-gbadge="${i}"]`);
      if (!el) return;
      if (g === gender) { el.textContent = gender === "female" ? "autora mujer · verificado en Wikidata" : "autor varón · verificado en Wikidata"; el.classList.add("badge-free"); }
      else if (g) { el.textContent = (g === "female" ? "autora mujer" : "autor varón") + " · Wikidata"; el.classList.add("badge-pending"); }
      else { el.textContent = "autoría no verificada"; el.classList.add("badge-pending"); }
    });
    const okCount = results.filter((g) => g === gender).length;
    gNote.innerHTML = gender === "female"
      ? `Autoría mujer: <strong>${okCount} de ${shown.length} verificadas en Wikidata</strong> (propiedad sexo/género del registro de la persona). Las demás quedan marcadas: no se afirma lo no verificado.`
      : `Autoría varón: <strong>${okCount} de ${shown.length} verificados en Wikidata</strong>. Las demás quedan marcadas: no se afirma lo no verificado.`;
  }
}

/* Cobertura de contenido (guardrail de conservación): una expansión
   generada (tema de Wikipedia, materia OL) solo se propone si conserva
   TODOS los términos de contenido de la consulta limpia; «Joya» no es
   variante de «joyas victorianas» porque suelta «victoriana». */
function coversContent(variantText, contentToks) {
  const vToks = sigTokens(variantText);
  const tokCovered = (qt, vt) => {
    const n = Math.min(qt.length, vt.length, 5);
    if (n >= 4 && qt.slice(0, n) === vt.slice(0, n)) return true;
    /* Plurales con familia morfológica: «joyas» se cubre por «joyería»
       (raíz «joy-»); solo si el término acaba en -s, para no admitir
       cambios de palabra («huerto» no se cubre por «agricultura»). */
    return qt.length >= 4 && qt.endsWith("s") && vt.slice(0, 3) === qt.slice(0, 3);
  };
  return contentToks.every((qt) => vToks.some((vt) => tokCovered(qt, vt)));
}

/* Andamiaje de pregunta natural: se retira solo lo que no aporta tema
   (quiero/busco/libros sobre...). Nunca se inventa intención: la
   variante son los propios términos del usuario, aligerados. */
function cleanedQuery(raw) {
  let q = " " + raw.toLowerCase().replace(/[¿?¡!.,;:]+/g, " ") + " ";
  const SCAFF = [
    " quiero ", " quisiera ", " busco ", " necesito ", " encuentra ", " encontrar ",
    " dime ", " dame ", " recomiéndame ", " recomiendame ", " cómo ", " como ",
    " qué ", " que ", " dónde ", " donde ", " hay ", " algún ", " alguna ",
    " libros de ", " libros sobre ", " libros para ", " libro de ", " libro sobre ",
    " novelas de ", " novelas sobre ", " novela de ", " novela sobre ",
    " ensayos de ", " ensayos sobre ", " ensayo de ", " ensayo sobre ",
    " obras de ", " obras sobre ", " lecturas de ", " lecturas sobre ",
    " aprender a ", " aprender ", " introducción a ", " introduccion a ",
    " me gustaría ", " me gustaria ", " puedes ", " puedo ",
  ];
  SCAFF.forEach((p) => { q = q.split(p).join(" "); });
  q = q.replace(/\s+/g, " ").trim().replace(/^(la|el|los|las|the)\s+/i, "");
  return q && q !== raw.toLowerCase().trim() && sigTokens(q).length ? q : null;
}

/* Tema canónico con Wikipedia (mismo operador y API que la Wikisource que
   Rastro ya consulta): el buscador de artículos acepta lenguaje natural y
   sus títulos son términos canónicos de tema para cualquier dominio.
   Solo se aceptan títulos con solape léxico con la consulta: sin solape,
   preferimos silencio a ruido. Devuelve también el equivalente inglés
   (langlink) del primer tema aceptado. */
async function wikipediaTopicVariants(raw) {
  const topics = [];
  let enTitle = null;
  try {
    const d = await fetchJson(`https://es.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(raw)}&srnamespace=0&srlimit=4&format=json&origin=*`);
    const qToks = sigTokens(raw);
    for (const h of ((d.query && d.query.search) || [])) {
      const clean = (h.title || "").replace(/\s*\(.*\)\s*$/, "").trim();
      const tToks = sigTokens(clean);
      if (!tToks.length) continue;
      if (!stemsOverlap(qToks, tToks) && !normTxt(raw).includes(normTxt(clean))) continue;
      topics.push(clean);
      if (topics.length >= 2) break;
    }
    if (topics.length) {
      const ll = await fetchJson(`https://es.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(topics[0])}&prop=langlinks&lllang=en&format=json&origin=*&redirects=1`);
      const pages = (ll.query && ll.query.pages) || {};
      for (const k of Object.keys(pages)) {
        const l = pages[k].langlinks && pages[k].langlinks[0];
        if (l && l["*"]) { enTitle = l["*"].replace(/\s*\(.*\)\s*$/, "").trim(); break; }
      }
    }
  } catch { /* sin Wikipedia: el resto de fuentes de variantes sigue */ }
  return { topics, enTitle };
}

/* Puerta de pertinencia: una variante solo se ofrece si Open Library
   devuelve obras reales (>=3) y alguno de los primeros títulos contiene
   un término de la variante. No se ofrecen reformulaciones que no
   recuperan libros de su tema. */
async function variantGate(text) {
  try {
    const d = await fetchJson(`https://openlibrary.org/search.json?q=${encodeURIComponent(text)}&fields=title&limit=3`);
    if ((d.numFound || 0) < 3) return false;
    const stems = sigTokens(text).map(stem5);
    if (!stems.length) return true;
    return (d.docs || []).slice(0, 3).some((doc) => {
      const t = normTxt(doc.title || "");
      return stems.some((st) => t.includes(st));
    });
  } catch { return false; }
}

/* Materias reales del catálogo de Open Library relacionadas con la
   consulta (o con alguno de sus términos si la consulta entera no da). */
async function subjectVariants(raw, limit = 2) {
  const out = [];
  const seen = new Set([normTxt(raw)]);
  const tryQ = async (q) => {
    try {
      const d = await fetchJson(`https://openlibrary.org/search/subjects.json?q=${encodeURIComponent(q)}`);
      for (const doc of (d.docs || [])) {
        if (out.length >= limit) break;
        const name = (doc.name || "").trim();
        if (!name || (doc.work_count || 0) < 3) continue;
        const n = normTxt(name);
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(name);
      }
    } catch { /* sin sugerencias de materias */ }
  };
  await tryQ(raw);
  if (!out.length) {
    for (const t of sigTokens(raw)) {
      if (out.length >= limit) break;
      await tryQ(t);
    }
  }
  return out;
}

/* Reformulación IA autorizada por el usuario (9 nov 2026): su propia
   cuenta gratuita de Cloudflare Workers AI (worker rastro-rewrite,
   modelo Mistral Small 3.1). La consulta se envía a Cloudflare, que no
   la retiene ni la usa para entrenar (política enlazada en Fuentes).
   Si el worker falla o la cuota diaria se agota, Rastro sigue igual. */
async function aiRewrite(raw) {
  try {
    const r = await fetch("https://rastro-rewrite.francesc-adria-perello.workers.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: raw }),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.queries || []).filter((x) => x && x.text);
  } catch { return []; }
}

function runVariant(v) {
  if (!state.original) state.original = { query: state.query, lang: state.lang };
  state.variantLabel = v.label;
  $("#search-input").value = v.text;
  if (v.lang) $("#lang-select").value = v.lang;
  state._variantRun = true;
  $("#search-form").requestSubmit();
}

async function updateVariantsBlock(scarceArg) {
  const block = $("#block-variants"), chips = $("#variant-chips"), note = $("#variants-note");
  if (!block) return;
  const raw = state.query, L = activeLang();
  const scarce = scarceArg && !state.isbn;
  if (!state.original && !scarce) { block.hidden = true; return; }
  block.hidden = false;
  const items = [];
  const seen = new Set([normTxt(raw)]);
  if (state.original && normTxt(state.original.query) !== normTxt(raw)) seen.add(normTxt(state.original.query));
  const push = (v) => { if (v && v.text && !seen.has(normTxt(v.text))) { seen.add(normTxt(v.text)); items.push(v); } };

  /* Recolección en paralelo: glosario verificado, Wikipedia (tema canónico
     de cualquier dominio + equivalente inglés), materias OL, limpieza de
     andamiaje. Después, puerta de pertinencia para todos. */
  const en = englishVariant(raw);
  const cq = cleanedQuery(raw);
  /* Términos de contenido: lo que queda tras retirar el andamiaje. El
     guardrail exige que toda expansión generada los conserve todos. */
  const contentToks = sigTokens(cq || raw);
  const intentDrop = droppedIntentWords(raw, cq);
  /* Wikipedia busca mejor con el tema limpio que con la pregunta cruda:
     «aprender macramé» devolvía biografías por la palabra «aprender». */
  const wikiQuery = cq || sigTokens(raw).join(" ") || raw;
  const wikiP = wikipediaTopicVariants(wikiQuery);
  const subsP = subjectVariants(raw);
  /* La reformulación IA solo se pide con escasez real (no al mostrar una
     variante ya activa): así no se gasta cuota en búsquedas fructíferas. */
  const aiP = scarce ? aiRewrite(raw) : Promise.resolve([]);
  /* Declaración de pérdida: si el usuario pedía aprender/curso/tutorial...,
     la variante que no conserva esa palabra lo dice en su etiqueta. */
  const declareLoss = (v) => {
    const missing = intentDrop.filter((w) => !coversContent(v.text, [w]));
    if (missing.length) v.label += " · sin «" + missing.join("», «") + "»";
    return v;
  };
  if (en) push(declareLoss({ text: en, label: "en inglés · todos los idiomas", lang: "all" }));
  for (const t of sigTokens(raw)) {
    for (const syn of (GLOSS_SYN[t] || [])) {
      push(declareLoss({ text: applySynonym(raw, t, syn), label: "sinónimo" }));
    }
  }
  if (cq) push(declareLoss({ text: cq, label: "términos clave" }));
  const [wiki, subs, ai] = await Promise.all([wikiP, subsP, aiP]);
  /* Primero la reformulación IA (conservación de restricciones por
     instrucción; la puerta de pertinencia filtra como con el resto). */
  ai.forEach((x) => push({
    text: x.text,
    label: x.lang === "en" ? "reformulación IA · en inglés · todos los idiomas" : "reformulación IA (Cloudflare)",
    lang: x.lang === "en" ? "all" : undefined,
  }));
  const coveredTopics = wiki.topics.filter((t) => coversContent(t, contentToks));
  coveredTopics.forEach((t) => push(declareLoss({ text: t, label: "tema de Wikipedia" })));
  if (wiki.enTitle && coveredTopics.length && normTxt(coveredTopics[0]) === normTxt(wiki.topics[0])) push(declareLoss({ text: wiki.enTitle, label: "en inglés · todos los idiomas", lang: "all" }));
  subs.filter((nm) => coversContent(nm, contentToks)).forEach((nm) => push(declareLoss({ text: nm, label: "materia de Open Library" })));

  /* Puerta de pertinencia en paralelo: solo chips que recuperan libros. */
  const gated = await Promise.all(items.map(async (v) => (await variantGate(v.text)) ? v : null));
  const passed = gated.filter(Boolean);
  if (L) passed.push({ text: raw, label: "la misma consulta sin filtro de idioma", lang: "all" });
  const top = passed.slice(0, 5);
  if (state.original) {
    const o = state.original;
    const langDiff = o.lang !== state.lang ? `, con idioma ${o.lang === "all" ? "todos" : LANGS[o.lang].label}` : "";
    note.innerHTML = `Mostrando la variante <strong>«${esc(raw)}»</strong>${state.variantLabel ? ` (${esc(state.variantLabel)})` : ""}. ` +
      `Tu búsqueda original: <strong>«${esc(o.query)}»</strong>${langDiff}. ` +
      `<button type="button" class="btn-ghost" id="variant-back">Volver a la búsqueda original</button>`;
    const back = $("#variant-back");
    if (back) back.addEventListener("click", () => {
      state.original = null; state.variantLabel = null;
      $("#search-input").value = o.query;
      $("#lang-select").value = o.lang;
      state._variantRun = true;
      $("#search-form").requestSubmit();
    });
  } else {
    note.textContent = top.length
      ? "La búsqueda devuelve muy poco. Estas variantes pueden ser más fructíferas; la consulta activa se indica siempre y puedes volver a la original."
      : "La búsqueda devuelve muy poco y no se han encontrado variantes fiables para estos términos.";
  }
  chips.innerHTML = top.map((v, i) =>
    `<button type="button" class="chip variant" data-v="${i}">«${esc(v.text)}» <span class="variant-tag">${esc(v.label)}</span></button>`).join("");
  chips.querySelectorAll("[data-v]").forEach((b) =>
    b.addEventListener("click", () => runVariant(top[+b.dataset.v])));
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
  const L = activeLang();
  const base = `https://api.empathy.co/search/v1/query/cdl/search?query=${encodeURIComponent(q)}&lang=es&store=es&rows=8&start=0`;
  const mapItem = (b) => ({
    name: b.name || "Sin título",
    authors: dedupeNames(b.authors),
    price: b.price && typeof b.price.current === "number" ? b.price.current : null,
    previous: b.price && typeof b.price.previous === "number" ? b.price.previous : null,
    availability: b.availability || null,
    binding: b.encuadernation || null,
    year: cleanYear(b.yearPublication),
    publisher: b.editorial || null,
    isbn: b.ean || b.isbn || null,
    url: b.url || null,
    type: b.productType || null,
  });
  const run = async (extra) => {
    const data = await fetchJson(base + extra);
    const cat = data.catalog || {};
    return { total: cat.numFound || 0, items: (cat.content || []).map(mapItem) };
  };
  /* La tienda sí comunica idioma (faceta facetLang: Castellano, Catalán…):
     con idioma elegido se filtra en la propia consulta, así el contador y
     las fichas son resultados en ese idioma. Con ISBN no se filtra: una
     edición concreta puede no tener el idioma etiquetado en la tienda. */
  const langFilters = (!isbn && L && L.cdl)
    ? L.cdl.map((l) => `&filter=${encodeURIComponent("facetLang:" + l)}`).join("")
    : "";
  const main = await run(langFilters);
  let unfiltered = null;
  if (langFilters && main.total === 0) {
    const u = await run("");
    if (u.total > 0) unfiltered = u;
  }
  return { total: main.total, items: main.items, unfiltered, langLabel: langFilters ? L.label : null };
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
        year: cleanYear(y ? y[1] : null),
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
  }).filter((b) => b.epub || b.web)
    .filter((b) => matchesQueryLoose(b.title, b.authors.join(", "))); // no presentar como hallazgo algo ajeno
  /* Descarga verificada: HEAD real a cada fichero antes de mostrarse. */
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

/* ---------- Bibliotecas: CCUC (consulta real por SRU) ---------- */
/* Catàleg Col·lectiu de les Universitats de Catalunya: universidades
   catalanas, Biblioteca de Catalunya y otras bibliotecas del consorcio CSUC
   (cobertura catalana, no todas las universidades). SRU de Alma con CORS
   abierto: el navegador consulta directamente, sin proxy ni claves.
   La zona de red no indexa ISBN (probado: alma.isbn devuelve 0); con una
   búsqueda por ISBN se consulta por el título resuelto y la ficha lo indica.
   El SRU no incluye disponibilidad por biblioteca: cada tarjeta enlaza la
   ficha del CCUC, donde se ven las bibliotecas que lo tienen y su estado. */
const CCUC_VID = "34CSUC_NETWORK:CSUC_CCUC_UNION";
/* El 035 (p. ej. ES-BaCBU) solo indica PROCEDENCIA del registro, no fondos:
   comprobado contra Primo (registros ES-BaCBU cuyas bibliotecas son CLR/UB/URL
   sin BC). Por eso NO se rotula ninguna biblioteca concreta: las que tienen
   el ejemplar se ven solo en la ficha enlazada del CCUC. */

async function queryCCUC(query) {
  const clean = query.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  const cql = `alma.all_for_ui all "${clean}"`;
  const url = "https://eu04.alma.exlibrisgroup.com/view/sru/34CSUC_NETWORK?version=1.2&operation=searchRetrieve&maximumRecords=30&query=" +
    encodeURIComponent(cql);
  const xml = await fetchText(url);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("diagnostic")) throw new Error("SRU diagnostic");
  const total = Number((doc.querySelector("numberOfRecords") || {}).textContent || 0);
  const df = (rec, tag, code) =>
    [...rec.querySelectorAll(`datafield[tag="${tag}"] subfield[code="${code}"]`)].map((s) => s.textContent.trim());
  const items = [...doc.querySelectorAll("recordData > record")].map((rec) => {
    const ctrl = (t) => ((rec.querySelector(`controlfield[tag="${t}"]`) || {}).textContent || "").trim();
    const mms = ctrl("001");
    const ta = (df(rec, "245", "a")[0] || "Sin título").replace(/\s*[/:;]\s*$/, "");
    const tb = (df(rec, "245", "b")[0] || "").replace(/\s*[/:;]\s*$/, "");
    const authors = dedupeNames([...df(rec, "100", "a"), ...df(rec, "700", "a")].map((a) => a.replace(/[.,;:\s]+$/, "")));
    const pub = df(rec, "260", "b")[0] || df(rec, "264", "b")[0] || null;
    const dateRaw = df(rec, "260", "c")[0] || df(rec, "264", "c")[0] || ctrl("008").slice(7, 11);
    const y = (dateRaw || "").match(/(\d{4})/);
    return {
      title: tb ? ta + " " + tb : ta,
      authors,
      year: cleanYear(y ? y[1] : null),
      publisher: pub ? pub.replace(/[.,;:]+$/, "").trim() : null,
      isbn: (df(rec, "020", "a")[0] || "").split(" ")[0] || null,
      url: `https://ccuc.csuc.cat/discovery/fulldisplay?docid=alma${encodeURIComponent(mms)}&context=L&vid=${CCUC_VID}&lang=es`,
    };
  }).map((b) => ({ ...b, title: b.title.replace(/"{2,}/g, '"') }));
  /* El SRU ordena por relevancia de catálogo y suele anteponer artículos
     SOBRE la obra a la propia obra; por eso se piden 30 registros y se
     reordenan aquí: primero los títulos que empiezan por la búsqueda. */
  const nq = normTxt(clean);
  const head = nq.split(/[^a-z0-9áéíóúüñ]+/).filter((x) => x.length >= 3).slice(0, 2).join(" ");
  const rank = (b) => { const t = normTxt(b.title); return t.startsWith(nq) ? 0 : (head && t.startsWith(head) ? 1 : 2); };
  items.sort((a, b) => rank(a) - rank(b));
  return { total, items };
}


/* ---------- Más bibliotecas: España y mundo (consultas reales) ---------- */
/* Fuentes verificadas una a una desde el propio origen de Rastro (CORS
   abierto, sin clave ni cuenta). Criterio: bibliotecas nacionales y
   catálogos colectivos de mayor cobertura con acceso libre y directo.
   Lo que NO se pudo verificar (WorldCat: clave; British Library, SUDOC,
   NDL, SBN, Trove: sin API libre consultable) NO se anuncia como cubierto.
   Ninguna fuente incluye disponibilidad por ejemplar en su respuesta
   abierta: cada tarjeta enlaza la ficha oficial, donde se confirma. */

/* Parser MARC21 tolerante con espacios de nombres (Alma SRU, DNB, K10plus). */
function marc21Items(doc, linkFor) {
  const df = (rec, tag, code) =>
    [...rec.getElementsByTagNameNS("*", "datafield")]
      .filter((d) => d.getAttribute("tag") === tag)
      .flatMap((d) => [...d.getElementsByTagNameNS("*", "subfield")])
      .filter((s) => s.getAttribute("code") === code)
      .map((s) => s.textContent.trim());
  return [...doc.getElementsByTagNameNS("*", "recordData")].map((rd) => {
    const rec = [...rd.children].find((c) => c.localName === "record");
    if (!rec) return null;
    const ctrl = (t) => {
      const f = [...rec.getElementsByTagNameNS("*", "controlfield")].find((c) => c.getAttribute("tag") === t);
      return f ? f.textContent.trim() : "";
    };
    const ta = (df(rec, "245", "a")[0] || "Sin título").replace(/\s*[/:;]\s*$/, "");
    const tb = (df(rec, "245", "b")[0] || "").replace(/\s*[/:;]\s*$/, "");
    const authors = dedupeNames([...df(rec, "100", "a"), ...df(rec, "700", "a")].map((a) => a.replace(/[.,;:\s]+$/, "")));
    const pub = df(rec, "260", "b")[0] || df(rec, "264", "b")[0] || null;
    const dateRaw = df(rec, "260", "c")[0] || df(rec, "264", "c")[0] || ctrl("008").slice(7, 11);
    const y = (dateRaw || "").match(/(\d{4})/);
    const id = ctrl("001");
    return {
      title: tb ? ta + " " + tb : ta,
      authors,
      year: cleanYear(y ? y[1] : null),
      publisher: pub ? pub.replace(/[.,;:]+$/, "").trim() : null,
      isbn: (df(rec, "020", "a")[0] || "").split(" ")[0] || null,
      url: id ? linkFor(id) : null,
    };
  }).filter(Boolean);
}

/* Parser UNIMARC (BnF: marcxchange-v2, format="UNIMARC"). */
function unimarcItems(doc) {
  const df = (rec, tag, code) =>
    [...rec.getElementsByTagNameNS("*", "datafield")]
      .filter((d) => d.getAttribute("tag") === tag)
      .flatMap((d) => [...d.getElementsByTagNameNS("*", "subfield")])
      .filter((s) => s.getAttribute("code") === code)
      .map((s) => s.textContent.trim());
  return [...doc.getElementsByTagNameNS("*", "recordData")].map((rd) => {
    const rec = [...rd.children].find((c) => c.localName === "record");
    if (!rec) return null;
    const ctrl = (t) => {
      const f = [...rec.getElementsByTagNameNS("*", "controlfield")].find((c) => c.getAttribute("tag") === t);
      return f ? f.textContent.trim() : "";
    };
    const ta = (df(rec, "200", "a")[0] || "Sin título").replace(/\s*[/:;]\s*$/, "");
    const te = (df(rec, "200", "e")[0] || "").replace(/\s*[/:;]\s*$/, "");
    const authors = dedupeNames(
      [...df(rec, "700", "a"), ...df(rec, "701", "a"), ...df(rec, "702", "a")]
        .map((a, i, arr) => a.replace(/[.,;:\s]+$/, ""))
        .map((a) => a));
    /* Nombre propio UNIMARC va en $b tras el apellido: se añade si existe. */
    const firsts = [...df(rec, "700", "b"), ...df(rec, "701", "b"), ...df(rec, "702", "b")];
    const authorsFull = authors.map((a, i) => firsts[i] ? a + ", " + firsts[i].replace(/[.,;:\s]+$/, "") : a);
    const pub = df(rec, "210", "c")[0] || null;
    const dateRaw = df(rec, "210", "d")[0] || "";
    const y = dateRaw.match(/(\d{4})/);
    const ark = rec.getAttribute("id") || ctrl("003").replace(/^.*(ark:\/\S+).*$/, "$1") || "";
    return {
      title: te ? ta + " " + te : ta,
      authors: authorsFull,
      year: cleanYear(y ? y[1] : null),
      publisher: pub ? pub.replace(/[.,;:]+$/, "").trim() : null,
      isbn: (df(rec, "010", "a")[0] || "").split(" ")[0] || null,
      url: ark ? "https://catalogue.bnf.fr/" + ark.replace(/^https?:\/\/catalogue\.bnf\.fr\//, "") : null,
    };
  }).filter(Boolean);
}

function sruDoc(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const nEl = doc.getElementsByTagNameNS("*", "numberOfRecords")[0];
  const total = Number(nEl ? nEl.textContent : 0);
  /* BnF emite a veces un diagnóstico parcial ("erreur de traitement") pese a
     devolver registros válidos: solo es error si no hay ninguno. */
  if (!total && doc.getElementsByTagNameNS("*", "diagnostic").length) throw new Error("SRU diagnostic");
  return { doc, total };
}

/* Reordenación igual que CCUC: primero los títulos que empiezan por la
   búsqueda (los SRU ordenan por relevancia de catálogo). */
function rankWorkFirst(items, clean) {
  const nq = normTxt(clean);
  const head = nq.split(/[^a-z0-9áéíóúüñ]+/).filter((x) => x.length >= 3).slice(0, 2).join(" ");
  const rank = (b) => { const t = normTxt(b.title); return t.startsWith(nq) ? 0 : (head && t.startsWith(head) ? 1 : 2); };
  return items.sort((a, b) => rank(a) - rank(b));
}

/* Configuración por fuente: nombre, cobertura visible y consulta. */
const LIB_SOURCES = [
  {
    id: "bne", chip: "BNE", name: "Biblioteca Nacional de España",
    note: "Depósito legal de España; no es un censo de todo lo publicado.",
    searchUrl: (q) => `https://catalogo.bne.es/discovery/search?query=any,contains,${encodeURIComponent(q)}&vid=34BNE_INST:BNE&lang=es`,
    query: async (clean, isbn) => {
      const cql = `alma.all_for_ui all "${clean}"`;
      const url = "https://catalogo.bne.es/view/sru/34BNE_INST?version=1.2&operation=searchRetrieve&maximumRecords=50&query=" + encodeURIComponent(cql);
      const { doc, total } = sruDoc(await fetchText(url));
      const items = marc21Items(doc, (mms) => `https://catalogo.bne.es/discovery/fulldisplay?docid=alma${encodeURIComponent(mms)}&context=L&vid=34BNE_INST:BNE&lang=es`);
      return { total, items: rankWorkFirst(items, clean) };
    },
  },
  {
    id: "loc", chip: "Library of Congress", name: "Library of Congress (EE. UU.)",
    note: "La mayor biblioteca del mundo; más fuerte en fondos en inglés.",
    searchUrl: (q) => `https://www.loc.gov/books/?q=${encodeURIComponent(q)}`,
    query: async (clean, isbn) => {
      const url = `https://www.loc.gov/books/?fo=json&c=25&q=${encodeURIComponent(isbn || clean)}`;
      const j = await (await fetch(url)).json();
      const items = (j.results || []).map((it) => ({
        title: it.title || "Sin título",
        authors: (it.contributor || []).map((a) => a.replace(/\b\w/g, (c) => c.toUpperCase())),
        year: cleanYear(it.date),
        publisher: null,
        isbn: null,
        url: it.url || null,
      }));
      return { total: (j.pagination && (j.pagination.of || j.pagination.total)) || items.length, items: rankWorkFirst(items, clean) };
    },
  },
  {
    id: "bnf", chip: "BnF", name: "Biblioteca Nacional de Francia (BnF)",
    note: "Catálogo general francés; más fuerte en producción francesa.",
    searchUrl: (q) => `https://catalogue.bnf.fr/rechercher.do?motRecherche=${encodeURIComponent(q)}&critereRecherche=0`,
    query: async (clean, isbn) => {
      const cql = isbn ? `bib.isbn all "${isbn}"` : `(bib.title all "${clean}" or bib.author all "${clean}")`;
      const url = "https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&maximumRecords=50&query=" + encodeURIComponent(cql);
      const { doc, total } = sruDoc(await fetchText(url));
      const items = unimarcItems(doc);
      return { total, items: rankWorkFirst(items, clean) };
    },
  },
  {
    id: "dnb", chip: "DNB", name: "Biblioteca Nacional Alemana (DNB)",
    note: "Producción de Alemania y en alemán desde 1913.",
    searchUrl: (q) => `https://portal.dnb.de/opac.htm?method=simpleSearch&query=${encodeURIComponent(q)}`,
    query: async (clean, isbn) => {
      /* Su índice de título hace AND literal de palabras y un artículo inicial
         ("La") puede anular la coincidencia: se retira solo para esta fuente. */
      const cleanNoArt = clean.replace(/^(el|la|los|las|un|una|the|der|die|das|ein|le|les|l')\s+/i, "");
      const cql = isbn ? `num=${isbn}` : `title=${cleanNoArt.replace(/"/g," ")}`;
      const url = "https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&recordSchema=MARC21-xml&maximumRecords=50&query=" + encodeURIComponent(cql);
      const { doc, total } = sruDoc(await fetchText(url));
      const items = marc21Items(doc, (id) => `https://d-nb.info/${encodeURIComponent(id)}`);
      return { total, items: rankWorkFirst(items, clean) };
    },
  },
  {
    id: "k10", chip: "K10plus", name: "K10plus (catálogo colectivo alemán)",
    note: "Mayor catálogo colectivo de bibliotecas científicas alemanas.",
    searchUrl: (q) => `https://kxp.k10plus.de/DB=2.1/CMD?ACT=SRCHA&IKT=1016&TRM=${encodeURIComponent(q)}`,
    query: async (clean, isbn) => {
      const cql = isbn ? `pica.isb=${isbn}` : `pica.all="${clean}"`;
      const url = "https://sru.k10plus.de/gvk?version=1.1&operation=searchRetrieve&recordSchema=marcxml&maximumRecords=50&query=" + encodeURIComponent(cql);
      const { doc, total } = sruDoc(await fetchText(url));
      const items = marc21Items(doc, (ppn) => `https://kxp.k10plus.de/DB=2.1/PPNSET?PPN=${encodeURIComponent(ppn)}`);
      return { total, items: rankWorkFirst(items, clean) };
    },
  },
  {
    id: "libris", chip: "LIBRIS", name: "LIBRIS (catálogo colectivo sueco)",
    note: "Catálogo colectivo de las bibliotecas de Suecia.",
    searchUrl: (q) => `https://libris.kb.se/hitlist?q=${encodeURIComponent(q)}`,
    query: async (clean, isbn) => {
      const url = `https://libris.kb.se/xsearch?format=json&n=25&query=${encodeURIComponent(isbn || clean)}`;
      const j = await (await fetch(url)).json();
      const xs = j.xsearch || {};
      const items = (xs.list || []).map((it) => ({
        title: it.title || "Sin título",
        authors: it.creator ? [String([].concat(it.creator)[0]).replace(/[.,;:\s]+$/, "")] : [],
        year: cleanYear([].concat(it.date || "")[0]),
        publisher: it.publisher ? String([].concat(it.publisher)[0]).replace(/[.,;:]+$/, "").trim() : null,
        isbn: it.isbn || null,
        url: it.identifier || null,
      }));
      return { total: xs.records || items.length, items: rankWorkFirst(items, clean) };
    },
  },
];

async function queryAllLibs(raw, isbn) {
  const clean = raw.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  return Promise.all(LIB_SOURCES.map(async (s) => {
    try {
      const r = await s.query(clean, isbn);
      setChip(s.id, `${s.chip}: ${r.total} ${r.total === 1 ? "registro" : "registros"}`, "ok");
      return { src: s, total: r.total, items: r.items, error: false };
    } catch (e) {
      setChip(s.id, `${s.chip}: sin respuesta`, "warn");
      return { src: s, total: 0, items: [], error: true };
    }
  }));
}

function renderLibs(results) {
  const box = $("#libs-groups");
  if (!results || !results.length) { box.innerHTML = ""; return; }
  box.innerHTML = results.map((r) => {
    if (r.error) {
      return `<div class="lib-group" id="libgroup-${r.src.id}"><h3>${esc(r.src.name)}</h3><p class="empty-note">Sin respuesta en este momento; se reintenta en la próxima búsqueda.</p></div>`;
    }
    if (!r.items.length) {
      const nota = r.total > 0
        ? `El catálogo devuelve ${r.total} registros de coincidencia amplia, pero ninguno coincide claramente con la búsqueda entre los primeros recuperados. <a href="${esc(r.src.searchUrl(state.isbn || state.query))}" target="_blank" rel="noopener">Ver la búsqueda en la web oficial de ${esc(r.src.chip)}</a>`
        : "Sin registros para esta búsqueda.";
      return `<div class="lib-group" id="libgroup-${r.src.id}"><h3>${esc(r.src.name)}</h3><p class="empty-note">${nota}</p></div>`;
    }
    const qNorm = normTxt(state.isbn || state.query);
    const terms = qNorm.split(/[^a-z0-9áéíóúüñ]+/).filter((x) => x.length >= 3);
    const inTitle = (b) => {
      const hay = normTxt(b.title + " " + b.authors.join(" "));
      return terms.some((t) => hay.includes(t));
    };
    const cardHtml = (b, i) => `
      <div class="card" data-lib="${r.src.id}-${i}">
        <h3>${esc(b.title)}</h3>
        <p class="meta">${esc(b.authors.join(", "))}${b.year ? " · " + esc(b.year) : ""}</p>
        ${b.publisher ? `<p class="meta">${esc(b.publisher)}</p>` : ""}
        ${b.isbn ? `<p class="meta">ISBN ${esc(b.isbn)}</p>` : ""}
        <p class="meta">${esc(r.src.chip)} · disponibilidad y biblioteca concreta se confirman en la ficha enlazada</p>
        ${refBtn({ title: b.title, authors: b.authors, year: b.year, publisher: b.publisher, isbn: b.isbn, url: b.url, kind: "print" })}
      </div>`;
    const fetched = r.items.length;
    const first = r.items.slice(0, 4).map(cardHtml).join("");
    const restHtml = fetched > 4 ? r.items.slice(4).map((b, i) => cardHtml(b, i + 4)).join("") : "";
    const counts = `<p class="section-note sub" data-count="${r.src.id}">Se muestran ${Math.min(4, fetched)} de ${r.total} ${r.total === 1 ? "registro" : "registros"}.</p>`;
    const relNote = (!state.isbn && terms.length && !r.items.slice(0, 4).some(inTitle))
      ? `<p class="section-note sub">Los términos coinciden en la descripción u otros campos del registro, no en el título ni el autor.</p>`
      : "";
    const restDiv = fetched > 4 ? `<div class="cards" id="librest-${r.src.id}" hidden>${restHtml}</div>` : "";
    const moreBtn = fetched > 4 ? `<p><button type="button" class="btn-ghost lib-more" data-more="${r.src.id}">Mostrar ${fetched - 4} más en Rastro</button></p>` : "";
    const more = r.total > fetched ? `<p class="section-note sub"><a href="${esc(r.src.searchUrl(state.isbn || state.query))}" target="_blank" rel="noopener">Ver los ${r.total} registros en la web oficial de ${esc(r.src.chip)}</a></p>` : "";
    return `<details class="lib-group" id="libgroup-${r.src.id}"><summary>${esc(r.src.name)} <span class="lib-total">${r.total} ${r.total === 1 ? "registro" : "registros"}</span></summary><p class="section-note sub">${esc(r.src.note)}</p>${counts}${relNote}<div class="cards">${first}</div>${restDiv}${moreBtn}${more}</details>`;
  }).join("");
  box.querySelectorAll(".lib-more").forEach((btn) =>
    btn.addEventListener("click", () => {
      const rest = document.getElementById("librest-" + btn.dataset.more);
      if (rest) rest.hidden = false;
      const r = results.find((x) => x.src.id === btn.dataset.more);
      const cnt = box.querySelector(`[data-count="${btn.dataset.more}"]`);
      if (cnt && r) cnt.textContent = `Se muestran ${r.items.length} de ${r.total} ${r.total === 1 ? "registro" : "registros"}.`;
      btn.closest("p").remove();
    }));
  box.querySelectorAll(".card[data-lib]").forEach((c) =>
    c.addEventListener("click", () => {
      const [sid, idx] = c.dataset.lib.split("-");
      const r = results.find((x) => x.src.id === sid);
      const b = r && r.items[+idx];
      if (b && b.url) window.open(b.url, "_blank", "noopener");
    }));
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


/* Burbujas clicables: pulsar una burbuja despliega los resultados de su
   fuente (los grupos de bibliotecas vienen plegados) y se desplaza a ellos. */
const CHIP_TARGETS = {
  ol: "block-free", ia: "block-free", se: "block-dl", ws: "block-dl",
  cdl: "block-cdl", gb: "block-catalog", ccuc: "block-ccuc",
  bne: "libgroup-bne", loc: "libgroup-loc", bnf: "libgroup-bnf",
  dnb: "libgroup-dnb", k10: "libgroup-k10", libris: "libgroup-libris",
};
$("#status-bar").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip || !chip.id.startsWith("chip-")) return;
  const target = document.getElementById(CHIP_TARGETS[chip.id.slice(5)] || "");
  if (!target) return;
  if (target.tagName === "DETAILS") target.open = true;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
});

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
  /* Sin filtro de idioma, Open Library empareja de forma aproximada
     (descripción o metadatos): solo se ofrecen como lectura las fichas
     pertinentes en título o autor, nunca coincidencias vagas. */
  const pertinent = state.isbn ? withAccess : withAccess.filter((b) => pertinentHit(state.query, b.title + " " + b.authors.join(" ")));
  let html = "";
  pertinent.slice(0, 8).forEach((b) => {
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
  known = new Set(pertinent.flatMap((b) => b.ia));
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

function renderCdl(res, L) {
  const box = $("#cdl-cards");
  const btn = $("#cdl-show-unfiltered");
  const items = res.items || [];
  const rel = $("#cdl-rel");
  /* Relevancia: si los primeros resultados no contienen los términos en
     título ni autor, la tienda los ha emparejado de forma aproximada
     (descripción, metadatos o stemming): se muestran, pero explicado. */
  const showRel = (list) => {
    const qNormD = normTxt(state.isbn || state.query);
    const termsD = qNormD.split(/[^a-z0-9áéíóúüñ]+/).filter((x) => x.length >= 3);
    const inTitleD = (b) => {
      const hay = normTxt(b.name + " " + b.authors.join(" "));
      return termsD.some((t) => hay.includes(t));
    };
    rel.hidden = !(!state.isbn && termsD.length && list.length && !list.slice(0, 4).some(inTitleD));
  };
  const note = $("#cdl-note");
  note.textContent = "Precio y disponibilidad online comunicados ahora mismo por la propia tienda." +
    (res.langLabel ? ` Filtrado por idioma (${res.langLabel}), que la tienda sí comunica.` : "");
  const paint = (list) => {
    box.innerHTML = list.slice(0, 8).map((b, i) => `
    <div class="card" data-cdl="${i}">
      <h3>${esc(b.name)}</h3>
      <p class="meta">${esc(b.authors.join(", "))}${b.publisher ? " · " + esc(b.publisher) : ""}${b.year ? " · " + esc(b.year) : ""}</p>
      ${b.binding ? `<p class="meta">${esc(b.binding)}</p>` : ""}
      ${b.price != null
        ? `<p class="price">${b.price.toFixed(2).replace(".", ",")} €${b.previous && b.previous > b.price ? `<span class="was">${b.previous.toFixed(2).replace(".", ",")} €</span>` : ""}</p>`
        : '<p class="meta">Precio no comunicado</p>'}
      ${b.availability ? `<p class="avail${/sin stock|agotado|no disponible/i.test(b.availability) ? " out" : ""}">${esc(b.availability)}</p>` : ""}
      ${refBtn({ title: b.name, authors: b.authors, year: b.year, publisher: b.publisher, isbn: b.isbn, url: b.url, kind: "print" })}
    </div>`).join("");
    box.querySelectorAll(".card[data-cdl]").forEach((c) =>
      c.addEventListener("click", () => {
        const b = list[+c.dataset.cdl];
        if (b && b.url) window.open(b.url, "_blank", "noopener");
      }));
  };
  if (!items.length) {
    if (res.unfiltered && res.unfiltered.total > 0) {
      /* Cero bajo el filtro de idioma: ausencia real declarada; las
         coincidencias aproximadas de la tienda quedan a un clic, claramente
         separadas y nunca presentadas como éxito. */
      box.innerHTML = `<p class="empty-note">Sin resultados en ${esc(res.langLabel)} para esta búsqueda.</p>`;
      btn.hidden = false;
      btn.textContent = `Ver ${res.unfiltered.total} ${res.unfiltered.total === 1 ? "resultado" : "resultados"} de la tienda sin filtrar por idioma (búsqueda aproximada: pueden no ser pertinentes)`;
      btn.onclick = () => {
        paint(res.unfiltered.items);
        showRel(res.unfiltered.items);
        btn.hidden = true;
        /* La sección ya no muestra el modo filtrado: la etiqueta pasa a
           reflejar la vista efectiva. El idioma elegido sigue activo en
           las demás fuentes y en una nueva búsqueda. */
        note.textContent = "Precio y disponibilidad online comunicados ahora mismo por la propia tienda. " +
          "Mostrando resultados de la tienda sin filtrar por idioma (búsqueda aproximada: pueden no ser pertinentes); " +
          "el filtro de idioma elegido sigue activo en el resto de fuentes.";
      };
    } else {
      box.innerHTML = '<p class="empty-note">Casa del Libro no ha devuelto resultados para esta búsqueda.</p>';
      btn.hidden = true;
    }
    rel.hidden = true;
    return;
  }
  btn.hidden = true;
  paint(items);
  showRel(items);
}

function renderCatalog(olBooks, gbBooks, gbError, editionCards, unconfirmed, L) {
  const box = $("#catalog-cards");
  const src = editionCards || olBooks;
  /* Coincidencia aproximada de Open Library (descripción o metadatos):
     se muestran las fichas, pero explicado, nunca como éxito. */
  const relOL = $("#catalog-rel");
  if (relOL) relOL.hidden = !(!state.isbn && src.length && !src.slice(0, 4).some((b) => pertinentHit(state.query, b.title + " " + b.authors.join(" "))));
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

function renderCCUC(res) {
  const meta = $("#ccuc-meta");
  const box = $("#ccuc-cards");
  const after = $("#ccuc-after");
  meta.innerHTML = "";
  after.innerHTML = "";
  const official = `https://ccuc.csuc.cat/discovery/search?query=any,contains,${encodeURIComponent(state.isbn || state.query)}&vid=${CCUC_VID}&lang=es`;
  if (!res || !res.items.length) {
    meta.innerHTML = res && res.total === null
      ? '<p class="empty-note">El CCUC no se puede consultar por ISBN en esta versión (su zona de red no lo indexa). Prueba por título o autor.</p>'
      : (res && res.total > 0
        ? `<p class="empty-note">El CCUC devuelve ${res.total} registros, pero ninguno coincide claramente con la búsqueda entre los primeros recuperados. <a href="${esc(official)}" target="_blank" rel="noopener">Ver la búsqueda en la web oficial del CCUC</a></p>`
        : '<p class="empty-note">El CCUC no ha devuelto registros para esta búsqueda.</p>');
    return;
  }
  const cardHtml = (b, i) => `
    <div class="card" data-ccuc="${i}">
      <h3>${esc(b.title)}</h3>
      <p class="meta">${esc(b.authors.join(", "))}${b.year ? " · " + esc(b.year) : ""}</p>
      ${b.publisher ? `<p class="meta">${esc(b.publisher)}</p>` : ""}
      ${b.isbn ? `<p class="meta">ISBN ${esc(b.isbn)}</p>` : ""}
      <p class="meta">Catálogo colectivo CCUC · las bibliotecas que lo tienen y su disponibilidad se confirman en la ficha enlazada</p>
      ${refBtn({ title: b.title, authors: b.authors, year: b.year, publisher: b.publisher, isbn: b.isbn, url: b.url, kind: "print" })}
    </div>`;
  const fetched = res.items.length;
  const shown = Math.min(8, fetched);
  const counts = `<p class="section-note sub" data-count="ccuc">Se muestran ${shown} de ${res.total} ${res.total === 1 ? "registro" : "registros"}.</p>`;
  const qNormC = normTxt(state.isbn || state.query);
  const termsC = qNormC.split(/[^a-z0-9áéíóúüñ]+/).filter((x) => x.length >= 3);
  const inTitleC = (b) => {
    const hay = normTxt(b.title + " " + b.authors.join(" "));
    return termsC.some((t) => hay.includes(t));
  };
  const relNoteC = (!state.isbn && termsC.length && !res.items.slice(0, 8).some(inTitleC))
    ? `<p class="section-note sub">Los términos coinciden en la descripción u otros campos del registro, no en el título ni el autor.</p>`
    : "";
  const restDiv = fetched > 8 ? `<div class="cards" id="ccuc-rest" hidden>${res.items.slice(8).map((b, i) => cardHtml(b, i + 8)).join("")}</div>` : "";
  const moreBtn = fetched > 8 ? `<p><button type="button" class="btn-ghost" id="ccuc-more">Mostrar ${fetched - 8} más en Rastro</button></p>` : "";
  const more = res.total > fetched ? `<p class="section-note sub"><a href="${esc(official)}" target="_blank" rel="noopener">Ver los ${res.total} registros en la web oficial del CCUC</a></p>` : "";
  meta.innerHTML = counts + relNoteC;
  box.innerHTML = res.items.slice(0, 8).map(cardHtml).join("");
  after.innerHTML = restDiv + moreBtn + more;
  const moreBtnEl = $("#ccuc-more");
  if (moreBtnEl) moreBtnEl.addEventListener("click", () => {
    $("#ccuc-rest").hidden = false;
    const cnt = meta.querySelector('[data-count="ccuc"]');
    if (cnt) cnt.textContent = `Se muestran ${fetched} de ${res.total} ${res.total === 1 ? "registro" : "registros"}.`;
    moreBtnEl.closest("p").remove();
  });
  box.querySelectorAll(".card[data-ccuc]").forEach((c) =>
    c.addEventListener("click", () => { const b = res.items[+c.dataset.ccuc]; if (b && b.url) window.open(b.url, "_blank", "noopener"); }));
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
      <div class="card-badges"><span class="badge badge-free">fichero comprobado</span></div>
      <h3>${esc(b.title)}</h3>
      <p class="meta">${esc(b.authors.join(", "))}</p>
      <p class="meta">Standard Ebooks · libre de derechos en EE. UU. según la fuente · España y otros países: sin verificar (detalle en la página del libro)</p>
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
      <p class="meta">Wikisource (${esc(b.wikiLang)}) · licencia de cada obra en su página · sin verificar para España</p>
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
  if (state._variantRun) state._variantRun = false;
  else { state.original = null; state.variantLabel = null; }
  state.query = raw;
  state.isbn = detectIsbn(raw);
  state.lang = $("#lang-select").value;
  $("#results").hidden = false;
  $("#search-btn").disabled = true;
  clearChips();
  /* Las variantes de la búsqueda anterior no deben verse durante la nueva:
     se limpian aquí y se repintan al terminar (banner incluido). */
  const vb0 = $("#block-variants");
  if (vb0) { vb0.hidden = true; $("#variant-chips").innerHTML = ""; $("#variants-note").textContent = ""; }
  const sb0 = $("#block-subject"); if (sb0) { sb0.hidden = true; $("#subject-cards").innerHTML = ""; $("#subject-ccuc").innerHTML = ""; }
  const L = activeLang();
  setChip("lang", L ? `Idioma: ${L.label}` : "Idioma: todos", "");
  $("#free-cards").innerHTML = "";
  $("#pending-cards").innerHTML = "";
  $("#free-pending").hidden = true;
  $("#dl-cards").innerHTML = "";
  $("#cdl-cards").innerHTML = "";
  $("#catalog-cards").innerHTML = "";
  $("#ccuc-cards").innerHTML = "";
  renderStores();
  document.getElementById("results").scrollIntoView({ behavior: "smooth", block: "start" });

  setChip("ol", "Open Library", "loading");
  setChip("ia", "Archive.org", "loading");
  setChip("cdl", "Casa del Libro", "loading");
  setChip("gb", "Google Books", "loading");
  setChip("se", "Standard Ebooks", "loading");
  setChip("ws", "Wikisource", "loading");
  setChip("ccuc", "CCUC (bibliotecas)", "loading");
  LIB_SOURCES.forEach((s) => setChip(s.id, s.chip, "loading"));

  const olP = queryOpenLibrary(raw, state.isbn)
    .then((r) => { setChip("ol", `Open Library: ${r.length} fichas`, "ok"); return r; })
    .catch(() => { setChip("ol", "Open Library: sin respuesta", "warn"); return []; });
  const iaP = queryArchiveOrg(raw, state.isbn)
    .then((r) => { setChip("ia", `Archive.org: ${r.length} ejemplares`, "ok"); return r; })
    .catch(() => { setChip("ia", "Archive.org: sin respuesta", "warn"); return []; });
  const cdlP = queryCasaDelLibro(raw, state.isbn)
    .then((r) => { setChip("cdl", `Casa del Libro: ${r.total} resultados`, "ok"); return r; })
    .catch(() => { setChip("cdl", "Casa del Libro: sin respuesta", "warn"); return { total: 0, items: [], unfiltered: null, langLabel: null }; });
  const gbP = queryGoogleBooks(raw, state.isbn)
    .then((r) => { setChip("gb", `Google Books: ${r.length} fichas`, "ok"); return { books: r, error: false }; })
    .catch(() => { setChip("gb", "Google Books: no disponible ahora (cuota)", "warn"); return { books: [], error: true }; });

  const seP = queryStandardEbooks(raw)
    .then((r) => { setChip("se", r.skipped ? "Standard Ebooks: solo en inglés" : `Standard Ebooks: ${r.items.length} descargas`, r.skipped ? "" : "ok"); return r; })
    .catch(() => { setChip("se", "Standard Ebooks: sin respuesta", "warn"); return { items: [], skipped: false }; });
  const wsP = queryWikisource(raw, state.isbn)
    .then((r) => { setChip("ws", `Wikisource: ${r.length} obras`, "ok"); return r; })
    .catch(() => { setChip("ws", "Wikisource: sin respuesta", "warn"); return []; });

  /* CCUC no indexa ISBN en su zona de red (probado: alma.isbn devuelve 0).
     Con un ISBN se busca por el título que Open Library resuelve para ese
     ISBN, y el chip lo indica: nunca se presenta como búsqueda por ISBN. */
  const ccucP = (async () => {
    let q = raw, byTitle = false;
    if (state.isbn) {
      const ols = await olP;
      if (ols && ols[0] && ols[0].title) { q = ols[0].title; byTitle = true; }
    }
    try {
      const r = await queryCCUC(q);
      if (state.isbn && !byTitle) {
        /* ISBN sin título resuelto: el SRU de la zona de red no indexa ISBN
           (probado), así que 0 registros no significa ausencia: se dice. */
        setChip("ccuc", "CCUC: no consulta por ISBN; prueba por título o autor", "");
        return { total: null, items: [] };
      }
      setChip("ccuc", `CCUC: ${r.total} registros${byTitle ? " (por título)" : ""}`, "ok");
      return r;
    } catch { setChip("ccuc", "CCUC: sin respuesta", "warn"); return { total: 0, items: [] }; }
  })();

  const libsP = queryAllLibs(raw, state.isbn);
  const [ol, ia, cdl, gb, se, ws, ccuc, libs] = await Promise.all([olP, iaP, cdlP, gbP, seP, wsP, ccucP, libsP]);

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
    filteredFree = state.isbn ? withAccess : withAccess.filter((b) => pertinentHit(raw, b.title + " " + b.authors.join(" ")));
  }

  renderFree(ol, ia, filteredFree, L);
  renderDownloads(se, ws);
  renderCdl(cdl, L);
  renderCCUC(ccuc);
  renderLibs(libs);
  renderCatalog(ol, gb.books, gb.error, editionCards, unconfirmed, L);
  /* Escaso = ninguna fuente muestra coincidencia clara en título/autor
     entre sus primeras fichas (los totales de coincidencia amplia, como
     los 50 de LoC para esta consulta, no cuentan como resultado útil). */
  const vq = normTxt(state.isbn || raw).split(/[^a-z0-9áéíóúüñ]+/).filter((t) => t.length >= 3);
  const titleHit = (list, get) => vq.length > 0 && list.slice(0, 4).some((b) => {
    const hay = normTxt(get(b));
    return vq.some((t) => hay.includes(t));
  });
  /* Escaso = muy pocos resultados pertinentes en conjunto (los totales de
     coincidencia amplia, como los 50 de LoC para esta consulta, no cuentan
     como resultado útil: solo suman fuentes con coincidencia clara en
     título/autor entre sus primeras fichas). Con más de 3 pertinentes no
     se ofrecen variantes. */
  let pertinentItems = ol.length;
  if ((cdl.total || 0) > 0 && titleHit(cdl.items, (b) => b.name + " " + b.authors.join(" "))) pertinentItems += cdl.total;
  if ((ccuc.total || 0) > 0 && titleHit(ccuc.items, (b) => b.title + " " + b.authors.join(" "))) pertinentItems += ccuc.total;
  libs.forEach((r) => {
    if (!r.error && (r.total || 0) > 0 && titleHit(r.items, (b) => b.title + " " + b.authors.join(" "))) pertinentItems += r.total;
  });
  updateVariantsBlock(pertinentItems <= 3).catch(() => {});
  updateSubjectBlock(pertinentItems <= 3).catch(() => {});
  $("#search-btn").disabled = false;
});
