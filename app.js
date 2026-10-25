const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p/w342";
const BACKDROP_BASE = "https://image.tmdb.org/t/p/w300";
const OMDB_BASE = "https://www.omdbapi.com/";

// Seuils du score de qualité (voir enrichQuality) :
// - en dessous de LOW_VOTE_THRESHOLD votes TMDB, le film est jugé "confidentiel"
//   et on va chercher un signal ailleurs (OMDb, puis Wikidata en dernier recours).
const LOW_VOTE_THRESHOLD = 100;
const OMDB_RELIABLE_VOTES = 500;

// Les pays exclusifs sont configurés via la barre rapide de drapeaux

let currentPage = 1;
let isLoadingMore = false;
let hasMorePages = true;
let library = [];
let libraryHandle = null;
let dateBreakpoints = [];
let genreNameMap = {};
let activeQuickCountry = null;
const detailsCache = new Map();
const qualityCache = new Map();
const actorCreditsCache = new Map();

// ---------- petit stockage clé/valeur pour garder le handle de fichier entre sessions ----------
const DB_NAME = "cine-app";
const STORE = "kv";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- bibliothèque (fichier JSON dans /Ciné) ----------
// loadLibrary() (re)charge la bibliothèque. Appelée au démarrage, et à nouveau
// à chaque clic sur l'onglet "Ma bibliothèque" : ce clic est un vrai geste
// utilisateur, ce qui permet de redemander la permission d'accès au fichier
// (requestPermission) sans passer par le sélecteur de fichier si elle a expiré.
async function loadLibrary(requestGesture) {
  const supported = "showOpenFilePicker" in window;
  document.getElementById("connectFile").hidden = !supported;
  document.getElementById("newFile").hidden = !supported;

  if (supported) {
    if (!libraryHandle) {
      try {
        libraryHandle = await idbGet("libraryHandle");
      } catch (e) {
        libraryHandle = null;
      }
    }
    if (libraryHandle) {
      let perm = await libraryHandle.queryPermission({ mode: "readwrite" });
      if (perm !== "granted" && requestGesture) {
        try {
          perm = await libraryHandle.requestPermission({ mode: "readwrite" });
        } catch (e) {
          // annulé ou refusé : on continue avec le repli ci-dessous
        }
      }
      if (perm === "granted") {
        await loadLibraryFromHandle();
        setFileStatus("Connecté : " + libraryHandle.name);
        renderLibrary();
        updateLibCount();
        return;
      }
      setFileStatus(`Fichier lié (${libraryHandle.name}) — cliquez "Connecter" pour réautoriser`);
    } else {
      setFileStatus("Aucun fichier connecté — cliquez \"Connecter\" ou \"Nouveau fichier\".");
    }
  } else {
    setFileStatus("Ce navigateur ne supporte pas la connexion directe au fichier — utilisez Export/Import.");
  }

  // Pas de fichier connecté : la bibliothèque vient du cache local
  // (localStorage), fusionné avec un éventuel cine-liste.json placé à côté de
  // la page (usage local ; ce fichier est dans .gitignore et n'existe pas sur
  // GitHub Pages, où la requête échoue sans conséquence).
  const cached = localStorage.getItem("cineLibraryCache");
  const cachedLibrary = cached ? JSON.parse(cached) : [];
  library = cachedLibrary;
  try {
    const res = await fetch("cine-liste.json", { cache: "no-store" });
    if (res.ok) {
      const fileLibrary = await res.json();
      const byKey = new Map();
      fileLibrary.forEach((item) => byKey.set(item.media_type + ":" + item.id, item));
      cachedLibrary.forEach((item) => {
        const key = item.media_type + ":" + item.id;
        if (!byKey.has(key)) byKey.set(key, item);
      });
      library = [...byKey.values()];
      localStorage.setItem("cineLibraryCache", JSON.stringify(library));
    }
  } catch (e) {
    // fichier absent ou page ouverte en file:// : le cache local suffit
  }
  renderLibrary();
  updateLibCount();
}

async function initLibrary() {
  await loadLibrary(false);
}

async function loadLibraryFromHandle() {
  const file = await libraryHandle.getFile();
  const text = await file.text();
  try {
    library = text.trim() ? JSON.parse(text) : [];
  } catch (e) {
    library = [];
  }
}

// Garantit une date d'insertion (added_at) à chaque film avant écriture : les
// entrées qui n'en ont pas (ancien fichier, import) reçoivent la date du jour.
function stampMissingInsertDates() {
  const today = new Date().toISOString();
  library.forEach((item) => {
    if (!item.added_at) item.added_at = today;
  });
}

async function saveLibraryToHandle() {
  if (!libraryHandle) return;
  stampMissingInsertDates();
  const perm = await libraryHandle.requestPermission({ mode: "readwrite" });
  if (perm !== "granted") {
    toast("Permission d'écriture refusée");
    return;
  }
  const writable = await libraryHandle.createWritable();
  await writable.write(JSON.stringify(library, null, 2));
  await writable.close();
}

async function persistLibrary() {
  stampMissingInsertDates();
  if (libraryHandle) {
    await saveLibraryToHandle();
  } else {
    localStorage.setItem("cineLibraryCache", JSON.stringify(library));
  }
}

async function addToLibrary(item) {
  if (library.some((x) => x.id === item.id && x.media_type === item.media_type)) {
    toast("Déjà dans la bibliothèque");
    return;
  }
  library.push({ ...item, added_at: new Date().toISOString() });
  await persistLibrary();
  renderLibrary();
  updateLibCount();
  refreshLibraryBadges();
  toast("Ajouté à la bibliothèque");
}

async function removeFromLibrary(id, mediaType) {
  library = library.filter((x) => !(x.id === id && x.media_type === mediaType));
  await persistLibrary();
  renderLibrary();
  updateLibCount();
  refreshLibraryBadges();
}

function isInLibrary(id, mediaType) {
  return library.some((x) => x.id === id && x.media_type === mediaType);
}

// Met à jour le badge "Déjà retenu" des cartes de recherche déjà affichées,
// par exemple quand un film est ajouté/retiré via le bouton "+" plus bas sur
// sa propre carte, ou retiré depuis l'onglet Bibliothèque pendant que les
// résultats de recherche restent visibles en arrière-plan.
function refreshLibraryBadges() {
  document.querySelectorAll("#results .card").forEach((card) => {
    const badge = card.querySelector(".already-in-library-badge");
    if (!badge) return;
    badge.hidden = !isInLibrary(Number(card.dataset.id), card.dataset.mediaType);
  });
}

function renderLibrary() {
  const el = document.getElementById("libraryResults");
  if (!library.length) {
    el.innerHTML = '<p class="empty">Aucun film ou série enregistré pour l\'instant.</p>';
    return;
  }
  el.innerHTML = "";
  library
    .slice()
    .reverse()
    .forEach((item) => el.appendChild(renderCard(item, item.media_type, true)));
  refreshCardVisibility("libraryResults");
}

function updateLibCount() {
  document.getElementById("libCount").textContent = library.length;
}

function updateSearchCount(count) {
  document.getElementById("searchCount").textContent = count;
}

// ---------- cases de période S1/S2 (de 2005 à aujourd'hui) ----------
const PERIOD_START_YEAR = 2005;

function buildSemesterBreakpoints() {
  const today = new Date();
  const points = [];
  let year = PERIOD_START_YEAR;
  let half = 0;
  while (true) {
    const d = new Date(year, half === 0 ? 0 : 6, 1);
    if (d > today) break;
    points.push(d);
    if (half === 0) { half = 1; } else { half = 0; year++; }
  }
  // Pas de point "aujourd'hui" — on utilise getPeriodEndDate() pour la borne haute
  return points;
}

function formatISODate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatStartBreakpoint(idx) {
  const d = dateBreakpoints[idx];
  if (!d) return "Aujourd'hui";
  const half = d.getMonth() < 6 ? 1 : 2;
  return `S${half} ${d.getFullYear()}`;
}

function formatEndBreakpoint(idx) {
  if (idx > 0) return formatStartBreakpoint(idx - 1);
  return formatStartBreakpoint(0);
}

// état de la sélection des cases
let periodMinIdx = 0;
let periodMaxIdx = 0;

function initDateRange() {
  dateBreakpoints = buildSemesterBreakpoints();
  // Sélection initiale = dernier semestre
  const lastSemIdx = dateBreakpoints.length - 1;
  periodMinIdx = lastSemIdx >= 0 ? lastSemIdx : 0;
  periodMaxIdx = periodMinIdx;
  renderPeriodCells();
}

function renderPeriodCells() {
  const container = document.getElementById("periodCells");
  if (!container) return;
  const total = dateBreakpoints.length;

  // Construire des groupes : { year, cells: [{idx, label, isToday}] }
  const groups = [];
  let currentGroup = null;

  dateBreakpoints.forEach((d, i) => {
    const year = d.getFullYear();
    const half = d.getMonth() < 6 ? 1 : 2;
    const label = `S${half}`;

    if (!currentGroup || currentGroup.year !== year) {
      currentGroup = { year, cells: [] };
      groups.push(currentGroup);
    }
    currentGroup.cells.push({ idx: i, label, isToday: false });
  });

  // Générer le HTML par groupe
  let html = "";
  groups.forEach(group => {
    const firstIdx = group.cells[0]?.idx ?? 0;
    const lastIdx  = group.cells[group.cells.length - 1]?.idx ?? 0;

    // L'année est active si au moins une cellule est dans la plage sélectionnée
    const groupHasSelected = group.cells.some(c => c.idx >= periodMinIdx && c.idx <= periodMaxIdx);
    const yearCls = ["period-year-label", groupHasSelected ? "year-active" : ""].filter(Boolean).join(" ");
    const yearHtml = group.year
      ? `<button type="button" class="${yearCls}" data-first-idx="${firstIdx}" data-last-idx="${lastIdx}" title="${group.year}">${group.year}</button>`
      : `<span class="${yearCls}">—</span>`;

    const cellsHtml = group.cells.map(({ idx, label }) => {
      const isSelected = idx >= periodMinIdx && idx <= periodMaxIdx;
      const cls = [
        "period-cell",
        isSelected ? "is-selected" : "",
        label === "S1" ? "is-s1" : "is-s2",
      ].filter(Boolean).join(" ");
      return `<button type="button" class="${cls}" data-idx="${idx}" title="${formatStartBreakpoint(idx)}">${label}</button>`;
    }).join("");

    html += `<div class="period-group">${yearHtml}<div class="period-group-cells">${cellsHtml}</div></div>`;
  });

  container.innerHTML = html;

  // Listener : clic sur une cellule S1/S2
  container.querySelectorAll(".period-cell").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      periodMinIdx = idx;
      periodMaxIdx = idx;
      renderPeriodCells();
      btn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      saveFilters();
      search(1);
    });
  });

  // Listener : clic sur l'année → sélectionne S1 ET S2
  container.querySelectorAll(".period-year-label[data-first-idx]").forEach(lbl => {
    lbl.addEventListener("click", (e) => {
      e.stopPropagation();
      periodMinIdx = Number(lbl.dataset.firstIdx);
      periodMaxIdx = Number(lbl.dataset.lastIdx);
      renderPeriodCells();
      lbl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      saveFilters();
      search(1);
    });
  });

  // Scroll vers la sélection au chargement
  const selectedBtn = container.querySelector(".is-selected");
  if (selectedBtn) {
    setTimeout(() => selectedBtn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" }), 50);
  }
}

// Proxy pour compatibilité avec buildDiscoverUrl
function getPeriodMinIdx() { return periodMinIdx; }
function getPeriodMaxIdx() { return periodMaxIdx; }

// Calcule la date de FIN du semestre pointé par idx
// S1 (début jan) → fin = 30 juin de la même année
// S2 (début juil) → fin = 31 décembre de la même année
// Dernier point (Aujourd'hui) → date du jour
function getPeriodEndDate(idx) {
  if (idx >= dateBreakpoints.length) return new Date();
  const d = dateBreakpoints[idx];
  if (d.getMonth() < 6) {
    return new Date(d.getFullYear(), 5, 30);
  } else {
    return new Date(d.getFullYear(), 11, 31);
  }
}


// ---------- recherche TMDB ----------
async function fetchGenres(mediaType) {
  const res = await fetch(`${TMDB_BASE}/genre/${mediaType}/list?api_key=${TMDB_API_KEY}&language=fr-FR`);
  const data = await res.json();
  return data.genres || [];
}

function getMediaType() {
  return document.querySelector(".segmented").dataset.mediaType;
}

function setMediaType(value) {
  const segmented = document.querySelector(".segmented");
  segmented.dataset.mediaType = value;
  segmented.querySelectorAll(".segmented-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === value);
  });
}

async function populateGenres() {
  const mediaType = getMediaType();
  const menu = document.getElementById("genreMenu");
  try {
    const genres = await fetchGenres(mediaType);
    genreNameMap = Object.fromEntries(genres.map((g) => [g.id, g.name]));
    menu.innerHTML = genres
      .map(
        (g) => `
        <div class="genre-option" data-id="${g.id}" data-state="admitted">
          <span>${g.name}</span>
          <span class="genre-option-toggle" aria-hidden="true"></span>
        </div>`
      )
      .join("");
  } catch (e) {
    menu.innerHTML = "";
  }
  updateGenreToggleLabel();
}

function getExcludedGenreIds() {
  return [...document.querySelectorAll('#genreMenu .genre-option[data-state="excluded"]')].map((el) => el.dataset.id);
}

function setSelectedGenreIds(excludedIds) {
  document.querySelectorAll("#genreMenu .genre-option").forEach((el) => {
    el.dataset.state = excludedIds.includes(el.dataset.id) ? "excluded" : "admitted";
  });
  updateGenreToggleLabel();
}

function updateGenreToggleLabel() {
  const toggle = document.getElementById("genreToggle");
  const all = document.querySelectorAll("#genreMenu .genre-option");
  const excludedCount = document.querySelectorAll('#genreMenu .genre-option[data-state="excluded"]').length;
  const admittedCount = all.length - excludedCount;
  // Le nombre affiché est celui des genres NON exclus (autorisés), pas des exclus.
  if (excludedCount === 0) toggle.textContent = "Genres";
  else toggle.textContent = `${admittedCount} genres`;
}



function buildDiscoverUrl(mediaType, page) {
  const excludedGenreIds = getExcludedGenreIds();
  const noteMin = document.getElementById("noteMin").value;
  const dateField = mediaType === "movie" ? "primary_release_date" : "first_air_date";
  
  // Tri dynamique basé sur le switch et la direction
  const sortBy = getSortBy();
  const sortDir = getSortDir();
  let sort = "";
  if (sortBy === "note") {
    sort = `vote_average.${sortDir}`;
  } else {
    const field = mediaType === "movie" ? "primary_release_date" : "first_air_date";
    sort = `${field}.${sortDir}`;
  }

  const params = new URLSearchParams({
    api_key: TMDB_API_KEY,
    language: "fr-FR",
    sort_by: sort,
    page: String(page),
    "vote_count.gte": "20",
    include_adult: "false",
  });
  if (excludedGenreIds.length) params.set("without_genres", excludedGenreIds.join(","));
  if (noteMin) params.set("vote_average.gte", noteMin);

  if (activeQuickCountry) {
    params.set("with_origin_country", activeQuickCountry);
  }

  const minIdx = getPeriodMinIdx();
  const maxIdx = getPeriodMaxIdx();
  if (dateBreakpoints.length) {
    // borne basse : début du semestre min (sauf si c'est le tout premier)
    if (minIdx > 0) {
      params.set(`${dateField}.gte`, formatISODate(dateBreakpoints[minIdx]));
    }
    // borne haute : fin réelle du semestre max (pas son début)
    const endDate = getPeriodEndDate(maxIdx);
    const today = new Date();
    // On pose la borne haute seulement si ce n'est pas « aujourd'hui »
    if (endDate < today) {
      params.set(`${dateField}.lte`, formatISODate(endDate));
    }
  }

  return `${TMDB_BASE}/discover/${mediaType}?${params.toString()}`;
}

function buildApiUrl(mediaType, page) {
  const query = document.getElementById("titleFilter").value.trim();
  if (query) {
    const params = new URLSearchParams({
      api_key: TMDB_API_KEY,
      language: "fr-FR",
      query: query,
      page: String(page),
      include_adult: "false"
    });
    return `${TMDB_BASE}/search/${mediaType}?${params.toString()}`;
  }
  return buildDiscoverUrl(mediaType, page);
}

async function search(page = 1) {
  const mediaType = getMediaType();
  const url = buildApiUrl(mediaType, page);
  const resultsEl = document.getElementById("results");
  const append = page > 1;

  if (!append) {
    resultsEl.innerHTML = '<p class="loading">Recherche…</p>';
    hasMorePages = true;
  }
  isLoadingMore = true;
  document.getElementById("scrollLoading").hidden = !append;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Erreur TMDB " + res.status);
    const data = await res.json();
    currentPage = data.page || page;
    hasMorePages = currentPage < Math.min(data.total_pages || 1, 500);
    if (!append) {
      updateSearchCount(data.total_results || 0);
    }
    renderResults(data.results || [], mediaType, append);
  } catch (err) {
    if (append) {
      hasMorePages = false;
    } else {
      resultsEl.innerHTML = `<p class="error">Erreur : ${err.message}</p>`;
    }
  } finally {
    isLoadingMore = false;
    document.getElementById("scrollLoading").hidden = true;
  }
}

function renderResults(items, mediaType, append) {
  const resultsEl = document.getElementById("results");
  if (!append) {
    if (!items.length) {
      resultsEl.innerHTML = '<p class="empty">Aucun résultat pour ces critères.</p>';
      return;
    }
    resultsEl.innerHTML = "";
  }
  items.forEach((item) => resultsEl.appendChild(renderCard(item, mediaType)));
  refreshCardVisibility("results");
}

function normalizeText(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Filtre de titre et d'exclusion locale (pays / genres / note / dates).
function refreshCardVisibility(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const isLibrary = containerId === "libraryResults";
  const titleInputId = isLibrary ? "libraryTitleFilter" : "titleFilter";
  const query = document.getElementById(titleInputId).value.trim().toLowerCase();
  const excludedGenreIds = isLibrary ? [] : getExcludedGenreIds().map(Number);
  
  // Récupération des filtres de note et date
  const noteMin = isLibrary ? 0 : (Number(document.getElementById("noteMin").value) || 0);
  const minIdx = isLibrary ? 0 : getPeriodMinIdx();
  const maxIdx = isLibrary ? 0 : getPeriodMaxIdx();
  
  // Supprimer les en-têtes de section de recherche existants
  container.querySelectorAll(".search-section-header").forEach((h) => h.remove());

  const cards = Array.from(container.querySelectorAll(".card"));
  const retained = [];
  const others = [];

  const hasActiveFilters = !isLibrary && (
    activeQuickCountry ||
    excludedGenreIds.length > 0 ||
    noteMin > 0 ||
    (dateBreakpoints.length && (minIdx > 0 || maxIdx < dateBreakpoints.length - 1))
  );

  cards.forEach((card) => {
    const title = card.querySelector("h3")?.textContent.toLowerCase() || "";
    
    let matchesTitle = true;
    if (query) {
      const normalizedTitle = normalizeText(title);
      const queryWords = normalizeText(query).split(/\s+/).filter(Boolean);
      matchesTitle = queryWords.every((word) => normalizedTitle.includes(word));
    }
    
    let isExcludedCountry = false;
    if (activeQuickCountry) {
      isExcludedCountry = !cardMatchesQuickCountry(card, activeQuickCountry);
    }
    
    let hasExcludedGenre = false;
    if (!isLibrary && excludedGenreIds.length && card.dataset.genres) {
      const cardGenres = card.dataset.genres.split(",").map(Number);
      hasExcludedGenre = cardGenres.some((id) => excludedGenreIds.includes(id));
    }
    
    // Filtre local de note
    let matchesNote = true;
    if (!isLibrary && noteMin > 0) {
      const cardNote = Number(card.dataset.note) || 0;
      matchesNote = cardNote >= noteMin;
    }
    
    // Filtre local de date
    let matchesDate = true;
    if (!isLibrary && dateBreakpoints.length && card.dataset.date) {
      const cardDate = card.dataset.date;
      if (minIdx > 0) {
        const minDateStr = formatISODate(dateBreakpoints[minIdx]);
        if (cardDate < minDateStr) matchesDate = false;
      }
      // borne haute = fin réelle du semestre
      const endDate = getPeriodEndDate(maxIdx);
      const today = new Date();
      if (endDate < today) {
        const maxDateStr = formatISODate(endDate);
        if (cardDate > maxDateStr) matchesDate = false;
      }
    } else if (!isLibrary && dateBreakpoints.length && !card.dataset.date) {
      if (minIdx > 0) matchesDate = false;
    }

    const passesAllFilters = !isExcludedCountry && !hasExcludedGenre && matchesNote && matchesDate;

    if (matchesTitle) {
      if (passesAllFilters) {
        retained.push(card);
      } else {
        others.push(card);
      }
    } else {
      card.style.display = "none";
    }
  });

  // Tri dynamique basé sur le switch de tri et sa direction
  const currentSortBy = getSortBy();
  const currentSortDir = getSortDir();
  const sortCards = (cardA, cardB) => {
    if (currentSortBy === "note") {
      const ratingA = Number(cardA.dataset.note) || 0;
      const ratingB = Number(cardB.dataset.note) || 0;
      if (ratingB !== ratingA) {
        return currentSortDir === "asc" ? ratingA - ratingB : ratingB - ratingA;
      }
    }
    // Tri ou repli par date de sortie
    const dateA = cardA.dataset.date || "";
    const dateB = cardB.dataset.date || "";
    if (currentSortDir === "asc") {
      return dateA.localeCompare(dateB); // le plus ancien en premier
    } else {
      return dateB.localeCompare(dateA); // le plus récent en premier
    }
  };

  retained.sort(sortCards);
  others.sort(sortCards);

  if (!query || !hasActiveFilters) {
    // Mode normal : afficher les films retenus (qui passent les filtres), masquer les autres
    retained.forEach((card) => {
      card.style.display = "";
      container.appendChild(card);
    });
    others.forEach((card) => {
      card.style.display = "none";
    });
  } else {
    // Mode partitionné : afficher les deux listes avec des en-têtes et triées/regroupées
    retained.forEach((card) => {
      card.style.display = "";
    });
    others.forEach((card) => {
      card.style.display = "";
    });

    if (retained.length > 0) {
      const header = document.createElement("div");
      header.className = "search-section-header";
      header.textContent = `Films retenus (${retained.length})`;
      container.appendChild(header);
      retained.forEach((card) => container.appendChild(card));
    }

    if (others.length > 0) {
      const header = document.createElement("div");
      header.className = "search-section-header";
      header.textContent = `Autres films trouvés sans filtres (${others.length})`;
      container.appendChild(header);
      others.forEach((card) => container.appendChild(card));
    }
  }
}

function renderCard(item, mediaType, inLibrary = false) {
  const title = item.title || item.name;
  const originalTitle = item.original_title || item.original_name || title;
  const date = item.release_date || item.first_air_date;
  const year = date ? date.slice(0, 4) : "?";
  const dateLabel = date ? formatDate(date) : "Date inconnue";
  const poster = item.poster_path ? IMG_BASE + item.poster_path : null;
  const backdrop = item.backdrop_path ? BACKDROP_BASE + item.backdrop_path : null;
  const note = typeof item.vote_average === "number" ? item.vote_average.toFixed(1) : "–";
  const genreNames = (item.genre_ids || []).map((id) => genreNameMap[id]).filter(Boolean);

  const alreadyInLibrary = !inLibrary && isInLibrary(item.id, mediaType);

  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = String(item.id);
  card.dataset.mediaType = mediaType;
  card.dataset.lang = item.original_language || "";
  card.dataset.genres = (item.genre_ids || []).join(",");
  card.dataset.date = date || "";
  card.dataset.note = typeof item.vote_average === "number" ? String(item.vote_average) : "";
  card.dataset.countries = Array.isArray(item.origin_country) ? item.origin_country.join(",") : "";
  card.innerHTML = `
    <div class="card-content">
      <div class="poster-column">
        <div class="poster">${poster ? `<img src="${poster}" alt="${escapeHtml(title)}" loading="lazy">` : '<div class="no-poster">🎬</div>'}</div>
        <a href="#" target="_blank" rel="noopener" class="btn-trailer-link" hidden>
          ▶ Bande-annonce ↗
        </a>
      </div>
      <div class="card-body">
        <div class="card-header">
          <h3>${escapeHtml(originalTitle)}${title && title !== originalTitle ? ` <span class="translated-title">(${escapeHtml(title)})</span>` : ""}</h3>
          <span class="already-in-library-badge" ${alreadyInLibrary ? "" : "hidden"}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 9 17 20 6"></polyline></svg>
            Déjà retenu
          </span>
        </div>
        <p class="meta">${dateLabel} · ⭐ <span class="note-value">${note}</span><span class="country-meta"></span></p>
        <div class="genre-chips">${genreNames.map((n) => `<span class="genre-chip">${escapeHtml(n)}</span>`).join("")}</div>
        <p class="quality" hidden></p>
        <div class="card-main">
          <div class="card-main-text">
            <p class="overview">${escapeHtml(item.overview || "")}</p>
            <button type="button" class="btn-library-main ${inLibrary ? 'state-in-library' : 'state-not-in-library'}" title="${inLibrary ? 'Retirer de ma bibliothèque' : 'Ajouter à ma bibliothèque'}">
              ${inLibrary ? '✔️' : '+'}
            </button>
          </div>
          <div class="side-media">${backdrop ? `<img src="${backdrop}" alt="" loading="lazy">` : ""}</div>
        </div>
        <p class="actors" hidden></p>
      </div>
    </div>
    <div class="actor-band" hidden>
      <div class="actor-band-header">
        <span></span>
        <div class="actor-band-controls">
          <button type="button" class="actor-band-sort-toggle" title="Changer le tri">Tri : Note ⭐</button>
          <button type="button" class="actor-band-close" aria-label="Fermer le bandeau">&times;</button>
        </div>
      </div>
      <div class="actor-band-movies"></div>
    </div>
  `;

  const btnLib = card.querySelector(".btn-library-main");
  if (btnLib) {
    btnLib.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btnLib.classList.contains("state-in-library")) {
        // Remove from library
        removeFromLibrary(item.id, mediaType);
        btnLib.className = "btn-library-main state-not-in-library";
        btnLib.textContent = "+";
        btnLib.title = "Ajouter à ma bibliothèque";
      } else if (btnLib.classList.contains("state-not-in-library")) {
        // Add to library
        addToLibrary({
          id: item.id,
          media_type: mediaType,
          title,
          original_title: item.original_title,
          original_name: item.original_name,
          release_date: date,
          vote_average: item.vote_average,
          poster_path: item.poster_path,
          overview: item.overview || "",
          genre_ids: item.genre_ids,
          original_language: item.original_language,
        });
        
        // Show green success state
        btnLib.className = "btn-library-main state-just-added";
        btnLib.textContent = "✔️";
        
        // Fades to grey checkmark in 1 second
        setTimeout(() => {
          if (btnLib.classList.contains("state-just-added")) {
            btnLib.className = "btn-library-main state-in-library";
            btnLib.title = "Retirer de ma bibliothèque";
          }
        }, 1000);
      }
    });
  }

  const sortBtn = card.querySelector(".actor-band-sort-toggle");
  if (sortBtn) {
    sortBtn.addEventListener("click", () => {
      const band = card.querySelector(".actor-band");
      if (!band) return;
      const currentMode = band.dataset.sortMode || "rating";
      const newMode = currentMode === "rating" ? "date" : "rating";
      band.dataset.sortMode = newMode;
      band.dataset.currentIndex = "10";
      sortBtn.textContent = newMode === "rating" ? "Tri : Note ⭐" : "Tri : Récents 📅";
      const actorId = band.dataset.activeActorId;
      const actorName = band.dataset.activeActorName;
      if (actorId && actorName) {
        renderActorMovies(band, actorId, actorName, newMode);
      }
    });
  }

  const closeBtn = card.querySelector(".actor-band-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      const band = card.querySelector(".actor-band");
      if (band) band.hidden = true;
    });
  }

  enrichCard(card, item.id, mediaType, item.overview);
  return card;
}

function formatDate(isoDate) {
  const d = new Date(isoDate);
  if (isNaN(d)) return isoDate;
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
}

async function getDetails(id, mediaType) {
  const key = mediaType + ":" + id;
  if (detailsCache.has(key)) return detailsCache.get(key);
  const promise = fetch(
    `${TMDB_BASE}/${mediaType}/${id}?api_key=${TMDB_API_KEY}&language=fr-FR&append_to_response=credits,videos,external_ids,images`
  ).then((res) => {
    if (!res.ok) throw new Error("Erreur TMDB " + res.status);
    return res.json();
  });
  detailsCache.set(key, promise);
  return promise;
}

async function getActorCredits(actorId) {
  if (actorCreditsCache.has(actorId)) {
    return actorCreditsCache.get(actorId);
  }
  const url = `${TMDB_BASE}/person/${actorId}/movie_credits?api_key=${TMDB_API_KEY}&language=fr-FR`;
  const promise = fetch(url).then((res) => {
    if (!res.ok) throw new Error("Erreur TMDB " + res.status);
    return res.json();
  });
  actorCreditsCache.set(actorId, promise);
  return promise;
}

async function toggleActorBand(card, actorId, actorName) {
  const band = card.querySelector(".actor-band");
  if (!band) return;

  const isCurrentlyOpen = !band.hidden && band.dataset.activeActorId === actorId;

  // Fermer tous les bandeaux de la page
  document.querySelectorAll(".actor-band").forEach((otherBand) => {
    otherBand.hidden = true;
  });

  // Si le bandeau était déjà ouvert pour cet acteur, le clic l'a fermé (déjà fait ci-dessus)
  if (isCurrentlyOpen) {
    return;
  }

  // Activer et afficher le bandeau pour cet acteur
  band.dataset.activeActorId = actorId;
  band.dataset.activeActorName = actorName;
  band.dataset.currentIndex = "10";
  const sortMode = band.dataset.sortMode || "rating";
  band.dataset.sortMode = sortMode;

  const sortBtn = band.querySelector(".actor-band-sort-toggle");
  if (sortBtn) {
    sortBtn.textContent = sortMode === "rating" ? "Tri : Note ⭐" : "Tri : Récents 📅";
  }

  band.hidden = false;

  const headerText = band.querySelector(".actor-band-header span");
  headerText.innerHTML = `Films de <strong>${escapeHtml(actorName)}</strong>`;

  await renderActorMovies(band, actorId, actorName, sortMode);
}

async function renderActorMovies(band, actorId, actorName, sortMode) {
  const moviesList = band.querySelector(".actor-band-movies");
  const currentIndex = parseInt(band.dataset.currentIndex) || 10;
  
  if (currentIndex <= 10) {
    moviesList.innerHTML = '<p class="loading">Chargement des films…</p>';
  }

  try {
    const data = await getActorCredits(actorId);
    const cast = data.cast || [];

    // Filtrer par premier ou second rôle (order === 0 ou order === 1)
    const filtered = cast.filter((item) => typeof item.order === "number" && item.order <= 1);

    // Trier selon le mode choisi
    if (sortMode === "date") {
      filtered.sort((a, b) => {
        const dateA = a.release_date || "";
        const dateB = b.release_date || "";
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateB.localeCompare(dateA); // le plus récent en premier
      });
    } else {
      // rating mode (meilleure note en premier)
      filtered.sort((a, b) => {
        const noteA = typeof a.vote_average === "number" ? a.vote_average : -1;
        const noteB = typeof b.vote_average === "number" ? b.vote_average : -1;
        if (noteA !== noteB) {
          return noteB - noteA;
        }
        const dateA = a.release_date || "";
        const dateB = b.release_date || "";
        return dateB.localeCompare(dateA);
      });
    }

    const visibleMovies = filtered.slice(0, currentIndex);

    if (visibleMovies.length === 0) {
      moviesList.innerHTML = '<p class="empty">Aucun film trouvé en premier ou second rôle.</p>';
      return;
    }

    const hasMore = filtered.length > currentIndex;

    let moviesHtml = visibleMovies
      .map((item) => {
        const poster = item.poster_path ? IMG_BASE + item.poster_path : null;
        const title = item.title || item.original_title || "";
        const note = typeof item.vote_average === "number" && item.vote_average > 0 ? item.vote_average.toFixed(1) : "–";
        const year = item.release_date ? item.release_date.slice(0, 4) : "Date inconnue";

        let movieUrl = "";
        if (item.id) {
          movieUrl = `https://www.themoviedb.org/movie/${item.id}`;
        } else if (item.title || item.original_title) {
          movieUrl = `https://www.allocine.fr/recherche/?q=${encodeURIComponent(item.title || item.original_title)}`;
        } else {
          movieUrl = `https://www.imdb.com/find?q=${encodeURIComponent(item.original_title || "")}`;
        }

        return `
          <a href="${movieUrl}" target="_blank" rel="noopener" class="actor-movie-card" title="${escapeHtml(title)} (${escapeHtml(year)})">
            <div class="actor-movie-cover-wrap">
              <div class="actor-movie-rating">⭐ ${note}</div>
              ${
                poster
                  ? `<img src="${poster}" alt="${escapeHtml(title)} (${escapeHtml(year)})" class="actor-movie-poster" loading="lazy">`
                  : `<div class="actor-movie-no-poster">🎬</div>`
              }
            </div>
            <div class="actor-movie-title">
              ${escapeHtml(title)} <span class="actor-movie-year">(${escapeHtml(year)})</span>
            </div>
          </a>
        `;
      })
      .join("");

    if (hasMore) {
      moviesHtml += `
        <button type="button" class="actor-movie-more-btn" title="Afficher les films suivants">
          <span class="more-arrow">▶</span>
        </button>
      `;
    }

    moviesList.innerHTML = moviesHtml;

    if (hasMore) {
      const moreBtn = moviesList.querySelector(".actor-movie-more-btn");
      if (moreBtn) {
        moreBtn.addEventListener("click", () => {
          const nextIndex = currentIndex + 10;
          band.dataset.currentIndex = String(nextIndex);
          renderActorMovies(band, actorId, actorName, sortMode);
        });
      }
    }
  } catch (err) {
    moviesList.innerHTML = `<p class="error">Erreur : ${err.message}</p>`;
  }
}

async function getDetailsEnglish(id, mediaType) {
  const key = mediaType + ":" + id + ":en";
  if (detailsCache.has(key)) return detailsCache.get(key);
  const promise = fetch(
    `${TMDB_BASE}/${mediaType}/${id}?api_key=${TMDB_API_KEY}&language=en-US`
  ).then((res) => {
    if (!res.ok) throw new Error("Erreur TMDB " + res.status);
    return res.json();
  });
  detailsCache.set(key, promise);
  return promise;
}

async function translateToFrench(text) {
  if (!text) return "";
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fr&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) return text;
    const data = await res.json();
    if (data && data[0]) {
      return data[0].map((item) => item[0]).join("");
    }
    return text;
  } catch (e) {
    return text;
  }
}

async function fetchOmdb(imdbId) {
  const key = "omdb:" + imdbId;
  if (qualityCache.has(key)) return qualityCache.get(key);
  const promise = fetch(`${OMDB_BASE}?i=${imdbId}&apikey=${OMDB_API_KEY}`)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  qualityCache.set(key, promise);
  return promise;
}

// Dernier recours quand ni TMDB ni OMDb n'ont assez de votes pour être fiables :
// on cherche un signal indirect de qualité (récompense ou sélection en festival)
// via Wikidata, retrouvé de façon fiable grâce à l'ID IMDb (pas de matching par titre).
async function fetchWikidataAwards(imdbId) {
  const key = "wd:" + imdbId;
  if (qualityCache.has(key)) return qualityCache.get(key);
  const promise = (async () => {
    try {
      const query = `SELECT ?awardLabel WHERE {
        ?film wdt:P345 "${imdbId}".
        { ?film wdt:P166 ?award. } UNION { ?film wdt:P1411 ?award. }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
      } LIMIT 3`;
      const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`;
      const res = await fetch(url, { headers: { Accept: "application/sparql-results+json" } });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.results?.bindings || []).map((b) => b.awardLabel.value);
    } catch (e) {
      return [];
    }
  })();
  qualityCache.set(key, promise);
  return promise;
}

// Complète la note TMDB quand elle repose sur trop peu de votes pour être fiable.
// Priorité : OMDb (IMDb/RT/Metacritic agrégés) si suffisamment voté sur IMDb,
// sinon signal indirect Wikidata (récompense/sélection), sinon on l'assume : pas
// de donnée fiable disponible plutôt qu'un chiffre fabriqué.
async function enrichQuality(card, data) {
  const qualityEl = card.querySelector(".quality");
  if (!qualityEl) return;

  const voteCount = data.vote_count || 0;
  const voteAverage = data.vote_average || 0;



  if (voteCount >= LOW_VOTE_THRESHOLD) return; // déjà assez fiable via TMDB

  const imdbId = data.external_ids && data.external_ids.imdb_id;
  if (!imdbId) {
    qualityEl.textContent = "ℹ️ Pas assez de données pour évaluer la qualité";
    qualityEl.className = "quality quality-unknown";
    qualityEl.hidden = false;
    return;
  }

  const omdb = await fetchOmdb(imdbId);
  if (omdb && omdb.Response === "True" && omdb.imdbVotes && omdb.imdbVotes !== "N/A") {
    const votes = parseInt(omdb.imdbVotes.replace(/,/g, ""), 10) || 0;
    if (votes >= OMDB_RELIABLE_VOTES) {
      const parts = [`IMDb ${omdb.imdbRating}/10 (${omdb.imdbVotes} votes)`];
      const rt = (omdb.Ratings || []).find((r) => r.Source === "Rotten Tomatoes");
      if (rt) parts.push(`RT ${rt.Value}`);
      if (omdb.Metascore && omdb.Metascore !== "N/A") parts.push(`Metacritic ${omdb.Metascore}/100`);
      qualityEl.textContent = "🎯 " + parts.join(" · ");
      qualityEl.className = "quality quality-reliable";
      qualityEl.hidden = false;
      return;
    }
  }

  const awards = await fetchWikidataAwards(imdbId);
  if (awards.length) {
    qualityEl.textContent = "🏆 " + awards.join(", ");
    qualityEl.className = "quality quality-indirect";
    qualityEl.hidden = false;
    return;
  }

  qualityEl.textContent = "ℹ️ Pas assez de données pour évaluer la qualité";
  qualityEl.className = "quality quality-unknown";
  qualityEl.hidden = false;
}

async function enrichCard(card, id, mediaType, existingOverview) {
  try {
    const data = await getDetails(id, mediaType);

    // Met à jour la date, la note et les pays avec les détails plus complets
    if (data.release_date || data.first_air_date) {
      card.dataset.date = data.release_date || data.first_air_date;
    }
    if (typeof data.vote_average === "number") {
      card.dataset.note = String(data.vote_average);
      // La note affichée doit toujours correspondre à celle utilisée pour le
      // tri (dataset.note) : sinon le classement paraît faux à l'oeil, même
      // s'il est en réalité correct — l'endpoint détail (utilisé ici) peut
      // légèrement différer de l'endpoint recherche/discover (figé au rendu
      // initial de la carte).
      const noteEl = card.querySelector(".note-value");
      if (noteEl) noteEl.textContent = data.vote_average.toFixed(1);
    }
    if (data.production_countries && data.production_countries.length) {
      card.dataset.countries = data.production_countries.map((c) => c.iso_3166_1).join(",");
    } else if (data.origin_country && data.origin_country.length) {
      card.dataset.countries = data.origin_country.join(",");
    }
    refreshCardVisibility(card.closest("#results") ? "results" : "libraryResults");

    // Affiche le pays de production avec son drapeau (SVG de flagcdn.com)
    let countryText = "";
    if (data.production_countries && data.production_countries.length) {
      countryText = data.production_countries.map((c) => {
        const flagHtml = getFlagImg(c.iso_3166_1);
        return flagHtml ? `${flagHtml}${escapeHtml(c.name)}` : escapeHtml(c.name);
      }).join(", ");
    } else if (data.origin_country && data.origin_country.length) {
      const countryNames = {
        "US": "États-Unis",
        "FR": "France",
        "GB": "Royaume-Uni",
        "JP": "Japon",
        "KR": "Corée du Sud",
        "IN": "Inde",
        "ES": "Espagne",
        "IT": "Italie",
        "DE": "Allemagne",
        "CA": "Canada",
        "AU": "Australie",
      };
      countryText = data.origin_country.map((code) => {
        const flagHtml = getFlagImg(code);
        const name = countryNames[code] || code;
        return flagHtml ? `${flagHtml}${escapeHtml(name)}` : escapeHtml(name);
      }).join(", ");
    }
    if (countryText) {
      const countryEl = card.querySelector(".country-meta");
      if (countryEl) {
        countryEl.innerHTML = " · " + countryText;
      }
    }

    // Mise à jour du titre original / traduit si absent (rétrocompatibilité bibliothèque)
    const origTitle = data.original_title || data.original_name;
    const transTitle = data.title || data.name;
    if (origTitle) {
      const h3 = card.querySelector(".card-header h3");
      if (h3) {
        let newTitleHTML = escapeHtml(origTitle);
        if (transTitle && transTitle !== origTitle) {
          newTitleHTML += ` <span class="translated-title">(${escapeHtml(transTitle)})</span>`;
        }
        h3.innerHTML = newTitleHTML;
      }
    }

    let overview = existingOverview || data.overview;
    let isTranslated = false;
    if (!overview) {
      try {
        const dataEn = await getDetailsEnglish(id, mediaType);
        if (dataEn && dataEn.overview) {
          overview = await translateToFrench(dataEn.overview);
          isTranslated = true;
        }
      } catch (e) {
        // pas grave
      }
    }
    if (overview) {
      const overviewEl = card.querySelector(".overview");
      if (overviewEl) {
        overviewEl.textContent = overview;
        if (isTranslated) {
          overviewEl.title = "Traduit automatiquement de l'anglais";
          overviewEl.style.fontStyle = "italic";
        }
      }
    }

    const chipsEl = card.querySelector(".genre-chips");
    if (data.genres && data.genres.length) {
      card.dataset.genres = data.genres.map((g) => g.id).join(",");
      if (chipsEl && !chipsEl.children.length) {
        chipsEl.innerHTML = data.genres
          .map((g) => `<span class="genre-chip">${escapeHtml(g.name)}</span>`)
          .join("");
      }
      refreshCardVisibility(card.closest("#results") ? "results" : "libraryResults");
    }

    if (!card.dataset.lang && data.original_language) {
      card.dataset.lang = data.original_language;
      refreshCardVisibility(card.closest("#results") ? "results" : "libraryResults");
    }

    const cast = (data.credits && data.credits.cast) || [];
    if (cast.length) {
      const actorsEl = card.querySelector(".actors");
      if (actorsEl) {
        actorsEl.innerHTML = "Avec : " + cast.slice(0, 4).map((c) => {
          if (c.id) {
            return `<a href="#" class="actor-link" data-actor-id="${c.id}" data-actor-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</a>`;
          } else {
            const fallbackUrl = c.name ? `https://www.allocine.fr/recherche/?q=${encodeURIComponent(c.name)}` : "#";
            return `<a href="${fallbackUrl}" target="_blank" rel="noopener" class="actor-link">${escapeHtml(c.name)}</a>`;
          }
        }).join(", ");

        actorsEl.querySelectorAll(".actor-link[data-actor-id]").forEach((link) => {
          link.addEventListener("click", (e) => {
            e.preventDefault();
            toggleActorBand(card, link.dataset.actorId, link.dataset.actorName);
          });
        });
        actorsEl.hidden = false;
      }
    }

    // Configure the trailer link under the cover
    const trailerLink = card.querySelector(".btn-trailer-link");
    if (trailerLink) {
      const videos = (data.videos && data.videos.results) || [];
      const youtubeVideos = videos.filter((v) => v.site === "YouTube");
      const candidates = [
        ...youtubeVideos.filter((v) => v.type === "Trailer"),
        ...youtubeVideos.filter((v) => v.type === "Teaser"),
        ...youtubeVideos.filter((v) => v.type !== "Trailer" && v.type !== "Teaser"),
      ];
      
      let trailerUrl = "";
      if (candidates.length) {
        trailerUrl = `https://www.youtube.com/watch?v=${candidates[0].key}`;
      } else {
        const imdbId = data.imdb_id || (data.external_ids && data.external_ids.imdb_id);
        if (imdbId) {
          trailerUrl = `https://www.imdb.com/title/${imdbId}/`;
        }
      }
      
      if (trailerUrl) {
        trailerLink.href = trailerUrl;
        trailerLink.hidden = false;
      } else {
        trailerLink.hidden = true;
      }
    }

    const sideMedia = card.querySelector(".side-media");
    if (sideMedia) {
      sideMedia.innerHTML = "";
      
      const backdrops = [];
      if (data.images && data.images.backdrops && data.images.backdrops.length > 0) {
        data.images.backdrops.slice(0, 3).forEach(img => {
          if (img.file_path) backdrops.push(img.file_path);
        });
      }
      
      if (backdrops.length < 3 && data.backdrop_path && !backdrops.includes(data.backdrop_path)) {
        backdrops.unshift(data.backdrop_path);
      }
      
      if (backdrops.length > 0) {
        const uniqueBackdrops = [...new Set(backdrops)].slice(0, 3);
        sideMedia.innerHTML = uniqueBackdrops
          .map(path => `<img src="${BACKDROP_BASE}${path}" alt="" loading="lazy">`)
          .join("");
      }
    }

    await enrichQuality(card, data);
  } catch (e) {
    // pas grave si l'enrichissement (acteurs/bande-annonce) échoue
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function getFlagImg(countryCode) {
  if (typeof countryCode !== "string" || countryCode.length !== 2) return "";
  const code = countryCode.toLowerCase();
  const c1 = code.charCodeAt(0);
  const c2 = code.charCodeAt(1);
  // S'assurer que ce sont bien des lettres a-z pour des URLs valides
  if (c1 < 97 || c1 > 122 || c2 < 97 || c2 > 122) return "";
  return `<img src="https://flagcdn.com/${code}.svg" class="country-flag" alt="" style="width: 1.1rem; height: auto; vertical-align: middle; margin-right: 0.25rem; border-radius: 2px; box-shadow: 0 1px 2px rgba(0,0,0,0.3); display: inline-block;">`;
}

// ---------- UI générale ----------
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2500);
}

function setFileStatus(msg) {
  document.getElementById("fileStatus").textContent = msg;
  updateFileBanner();
}

// Bandeau de premier lancement : proposer de créer (ou connecter) un fichier
// cine-liste.json tant qu'aucun fichier n'est lié. Un clic est nécessaire :
// les sélecteurs de fichier du navigateur exigent un geste de l'utilisateur.
function updateFileBanner() {
  const banner = document.getElementById("fileBanner");
  let dismissed = false;
  try {
    dismissed = localStorage.getItem("cine_file_banner_dismissed") === "1";
  } catch (e) {}
  banner.hidden = !("showOpenFilePicker" in window) || Boolean(libraryHandle) || dismissed;
}

document.getElementById("bannerNewFile").addEventListener("click", () => document.getElementById("newFile").click());
document.getElementById("bannerConnectFile").addEventListener("click", () => document.getElementById("connectFile").click());
document.getElementById("bannerDismiss").addEventListener("click", () => {
  try {
    localStorage.setItem("cine_file_banner_dismissed", "1");
  } catch (e) {}
  updateFileBanner();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.tab + "Tab").classList.add("active");
    if (tab.dataset.tab === "library") {
      loadLibrary(true);
    }
  });
});

document.getElementById("filters").addEventListener("submit", (e) => {
  e.preventDefault();
  search(1);
});
function loadFilters() {
  try {
    return JSON.parse(localStorage.getItem("cineFilters")) || null;
  } catch (e) {
    return null;
  }
}

function getSortBy() {
  const el = document.getElementById("sortSegmented");
  return el ? (el.dataset.sortBy || "date") : "date";
}

function getSortDir() {
  const el = document.getElementById("sortSegmented");
  return el ? (el.dataset.sortDir || "desc") : "desc";
}

function setSortDir(dir) {
  const el = document.getElementById("sortSegmented");
  if (!el) return;
  el.dataset.sortDir = dir;
  updateSortLabels();
}

function updateSortLabels() {
  const el = document.getElementById("sortSegmented");
  if (!el) return;
  const dir = getSortDir();
  const arrow = dir === "asc" ? " ↑" : " ↓";
  
  el.querySelectorAll(".sort-tab").forEach((btn) => {
    const val = btn.dataset.value;
    if (val === "note") {
      btn.innerHTML = `⭐ par Note${btn.classList.contains("active") ? arrow : ""}`;
    } else {
      btn.innerHTML = `📅 par Date${btn.classList.contains("active") ? arrow : ""}`;
    }
  });
  updateSortIndicator();
}

function updateSortIndicator() {
  const container = document.getElementById("sortSegmented");
  if (!container) return;
  const activeBtn = container.querySelector(".sort-tab.active");
  const indicator = container.querySelector(".sort-indicator");
  if (!activeBtn || !indicator) return;
  
  const containerRect = container.getBoundingClientRect();
  const btnRect = activeBtn.getBoundingClientRect();
  
  const left = btnRect.left - containerRect.left;
  const width = btnRect.width;
  
  indicator.style.left = `${left}px`;
  indicator.style.width = `${width}px`;
  
  const val = activeBtn.dataset.value;
  if (val === "note") {
    indicator.style.background = "var(--accent)";
    indicator.style.boxShadow = "0 0 10px var(--accent)";
  } else {
    indicator.style.background = "#00d2ff";
    indicator.style.boxShadow = "0 0 10px #00d2ff";
  }
}

window.addEventListener("resize", updateSortIndicator);

function setSortBy(value) {
  const el = document.getElementById("sortSegmented");
  if (!el) return;
  el.dataset.sortBy = value;
  el.querySelectorAll(".sort-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === value);
  });
  updateSortLabels();
}

function saveFilters() {
  // Le tri (sortBy/sortDir) n'est volontairement pas persisté ici : voir init().
  const filters = {
    mediaType: getMediaType(),
    excludedGenreIds: getExcludedGenreIds(),
    noteMin: document.getElementById("noteMin").value,
    dateMinIdx: periodMinIdx,
    dateMaxIdx: periodMaxIdx,
    activeQuickCountry: activeQuickCountry,
  };
  localStorage.setItem("cineFilters", JSON.stringify(filters));
}

document.querySelectorAll("[data-media-type] .segmented-btn").forEach((btn) =>
  btn.addEventListener("click", async () => {
    if (btn.classList.contains("active")) return;
    setMediaType(btn.dataset.value);
    await populateGenres();
    saveFilters();
    search(1);
  })
);

document.querySelectorAll("#sortSegmented .sort-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const parent = document.getElementById("sortSegmented");
    const val = btn.dataset.value;
    const currentVal = parent.dataset.sortBy;
    
    if (currentVal === val) {
      const currentDir = getSortDir();
      const newDir = currentDir === "desc" ? "asc" : "desc";
      setSortDir(newDir);
    } else {
      setSortBy(val);
      setSortDir("desc");
    }
    saveFilters();
    search(1);
    refreshCardVisibility("libraryResults");
  });
});

document.querySelectorAll(".quick-country-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const code = btn.dataset.code;
    if (activeQuickCountry === code) {
      activeQuickCountry = null;
    } else {
      activeQuickCountry = code;
    }
    updateQuickCountriesUI();
    saveFilters();
    search(1);
    refreshCardVisibility("libraryResults");
  });
});

function updateQuickCountriesUI() {
  document.querySelectorAll(".quick-country-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.code === activeQuickCountry);
  });
}

function cardMatchesQuickCountry(card, activeCountryCode) {
  if (card.dataset.countries) {
    const countries = card.dataset.countries.split(",").filter(Boolean);
    if (countries.length > 0) {
      return countries.includes(activeCountryCode);
    }
  }
  // Repli sur le code langue originale uniquement si les détails de pays ne sont pas encore chargés
  const lang = card.dataset.lang;
  const langMap = {
    "FR": ["fr"],
    "GB": ["en"],
    "ES": ["es"],
    "IT": ["it"],
    "DE": ["de"],
    "US": ["en"],
    "CN": ["zh", "cn"],
    "JP": ["ja"],
    "KR": ["ko"],
    "CA": ["en", "fr"],
    "DK": ["da"],
    "SE": ["sv"],
    "IN": ["hi", "ta", "te", "pa", "bn", "ml", "mr", "kn", "gu", "or", "as"],
    "AU": ["en"],
    "BR": ["pt"]
  };
  const allowedLangs = langMap[activeCountryCode] || [];
  return allowedLangs.includes(lang);
}
const genreToggle = document.getElementById("genreToggle");
const genreMenu = document.getElementById("genreMenu");
function positionDropdown(toggle, menu) {
  const rect = toggle.getBoundingClientRect();
  menu.style.top = rect.bottom + 6 + "px";
  menu.style.left = rect.left + "px";
}

genreToggle.addEventListener("click", () => {
  const opening = genreMenu.hidden;
  if (opening) positionDropdown(genreToggle, genreMenu);
  genreMenu.hidden = !opening;
  genreToggle.setAttribute("aria-expanded", String(opening));
});
genreMenu.addEventListener("click", (e) => {
  const option = e.target.closest(".genre-option");
  if (!option) return;
  
  const currentState = option.dataset.state || "admitted";
  option.dataset.state = currentState === "admitted" ? "excluded" : "admitted";
  
  updateGenreToggleLabel();
  saveFilters();
  search(1);
});

document.addEventListener("click", (e) => {
  if (!genreMenu.hidden && !e.target.closest(".genre-filter")) {
    genreMenu.hidden = true;
    genreToggle.setAttribute("aria-expanded", "false");
  }
});
document.getElementById("noteMin").addEventListener("change", () => {
  saveFilters();
  search(1);
});
// Les listeners de période sont gérés directement dans renderPeriodCells()

let titleSearchTimeout = null;
document.getElementById("titleFilter").addEventListener("input", () => {
  clearTimeout(titleSearchTimeout);
  titleSearchTimeout = setTimeout(() => {
    search(1);
  }, 400);
});
document.getElementById("libraryTitleFilter").addEventListener("input", () =>
  refreshCardVisibility("libraryResults")
);
new IntersectionObserver(
  (entries) => {
    if (entries[0].isIntersecting && hasMorePages && !isLoadingMore) {
      search(currentPage + 1);
    }
  },
  { rootMargin: "400px" }
).observe(document.getElementById("scrollSentinel"));

document.getElementById("connectFile").addEventListener("click", async () => {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "Bibliothèque Ciné", accept: { "application/json": [".json"] } }],
    });
    libraryHandle = handle;
    await idbSet("libraryHandle", handle);
    await loadLibraryFromHandle();
    setFileStatus("Connecté : " + handle.name);
    renderLibrary();
    updateLibCount();
  } catch (err) {
    if (err.name !== "AbortError") toast("Erreur : " + err.message);
  }
});

document.getElementById("newFile").addEventListener("click", async () => {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: "cine-liste.json",
      types: [{ description: "Bibliothèque Ciné", accept: { "application/json": [".json"] } }],
    });
    libraryHandle = handle;
    await idbSet("libraryHandle", handle);
    await saveLibraryToHandle();
    setFileStatus("Connecté (nouveau) : " + handle.name);
    renderLibrary();
    updateLibCount();
  } catch (err) {
    if (err.name !== "AbortError") toast("Erreur : " + err.message);
  }
});

// "Sauvegarder ma sélection" : verse les films du navigateur dans cine-liste.json
// SANS écraser ce que le fichier contient déjà (fusion par media_type + id).
// Le fichier est choisi une fois (existant ou nouveau), puis reste connecté.
// Sans File System Access API (Firefox, Safari) : repli par téléchargement.
document.getElementById("exportFile").addEventListener("click", async () => {
  if (!("showSaveFilePicker" in window)) {
    const blob = new Blob([JSON.stringify(library, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cine-liste.json";
    a.click();
    URL.revokeObjectURL(url);
    return;
  }

  try {
    if (!libraryHandle) {
      libraryHandle = await window.showSaveFilePicker({
        suggestedName: "cine-liste.json",
        types: [{ description: "Bibliothèque Ciné", accept: { "application/json": [".json"] } }],
      });
      await idbSet("libraryHandle", libraryHandle);
    }
    const perm = await libraryHandle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      toast("Permission d'écriture refusée");
      return;
    }

    let existing = [];
    const text = await (await libraryHandle.getFile()).text();
    if (text.trim()) {
      try {
        existing = JSON.parse(text);
        if (!Array.isArray(existing)) throw new Error();
      } catch (e) {
        toast("Le fichier existant est illisible : il n'a pas été modifié");
        return;
      }
    }

    const keyOf = (item) => item.media_type + ":" + item.id;
    const merged = new Map(existing.map((item) => [keyOf(item), item]));
    let added = 0;
    library.forEach((item) => {
      if (!merged.has(keyOf(item))) {
        merged.set(keyOf(item), item);
        added++;
      }
    });
    library = [...merged.values()];
    await saveLibraryToHandle();
    setFileStatus("Connecté : " + libraryHandle.name);
    renderLibrary();
    updateLibCount();
    refreshLibraryBadges();
    toast(`${added} film(s) ajouté(s) à ${libraryHandle.name}`);
  } catch (err) {
    if (err.name !== "AbortError") toast("Erreur : " + err.message);
  }
});

document.getElementById("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) throw new Error("format inattendu");
    library = imported;
    await persistLibrary();
    renderLibrary();
    updateLibCount();
    toast("Bibliothèque importée");
  } catch (err) {
    toast("Fichier invalide");
  }
  e.target.value = "";
});

// ---------- Gestion Drag & Drop pour l'ordre des pays ----------
function restoreCountryOrder() {
  const container = document.getElementById("quickCountriesBar");
  if (!container) return;
  const savedOrder = localStorage.getItem("quickCountriesOrder");
  if (!savedOrder) return;
  try {
    const codes = JSON.parse(savedOrder);
    if (Array.isArray(codes)) {
      const btns = Array.from(container.querySelectorAll(".quick-country-btn"));
      const btnMap = new Map(btns.map((btn) => [btn.dataset.code, btn]));
      codes.forEach((code) => {
        const btn = btnMap.get(code);
        if (btn) {
          container.appendChild(btn);
          btnMap.delete(code);
        }
      });
      // Rajoute les éventuels boutons non enregistrés (au cas où)
      btnMap.forEach((btn) => {
        container.appendChild(btn);
      });
    }
  } catch (e) {
    console.error("Erreur lors de la restauration de l'ordre des pays :", e);
  }
}

function saveCountryOrder() {
  const container = document.getElementById("quickCountriesBar");
  if (!container) return;
  const codes = [...container.querySelectorAll(".quick-country-btn")].map((btn) => btn.dataset.code);
  localStorage.setItem("quickCountriesOrder", JSON.stringify(codes));
}

let draggedItem = null;

function initDragAndDrop() {
  const container = document.getElementById("quickCountriesBar");
  if (!container) return;
  const items = container.querySelectorAll(".quick-country-btn");
  
  items.forEach((item) => {
    item.setAttribute("draggable", "true");
    
    item.addEventListener("dragstart", (e) => {
      draggedItem = item;
      item.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.dataset.code);
    });
    
    item.addEventListener("dragend", () => {
      draggedItem = null;
      item.classList.remove("dragging");
      saveCountryOrder();
    });
    
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      
      const rect = item.getBoundingClientRect();
      const next = (e.clientX - rect.left) > (rect.width / 2);
      
      if (item !== draggedItem) {
        container.insertBefore(draggedItem, next ? item.nextSibling : item);
      }
    });
  });
}

// ---------- init ----------
(async function init() {
  await loadEnv();
  if (!TMDB_API_KEY) {
    // Premier lancement sans clé : la fenêtre des paramètres s'ouvre, et la
    // page se recharge d'elle-même une fois la clé enregistrée.
    initSettings();
    return;
  }
  const saved = loadFilters();
  if (saved && saved.mediaType) {
    setMediaType(saved.mediaType);
  }
  restoreCountryOrder();
  initDragAndDrop();
  // Le tri n'est jamais persisté d'une session à l'autre : chaque rechargement
  // repart sur "par Date" (contrairement aux autres filtres, restaurés ci-dessous).
  setSortBy("date");
  setSortDir("desc");
  await populateGenres();
  initDateRange();
  if (saved) {
    if (saved.excludedGenreIds) {
      setSelectedGenreIds(saved.excludedGenreIds);
    } else {
      setSelectedGenreIds([]);
    }
    if (saved.noteMin !== undefined) {
      document.getElementById("noteMin").value = saved.noteMin;
    } else {
      document.getElementById("noteMin").value = "7";
    }

    if (saved.dateMinIdx !== undefined) periodMinIdx = Number(saved.dateMinIdx);
    if (saved.dateMaxIdx !== undefined) periodMaxIdx = Number(saved.dateMaxIdx);
    // S'assurer que les bornes sont valides
    const maxBp = dateBreakpoints.length - 1;
    if (periodMinIdx < 0 || periodMinIdx > maxBp) periodMinIdx = 0;
    if (periodMaxIdx < periodMinIdx || periodMaxIdx > maxBp) periodMaxIdx = maxBp;
    renderPeriodCells();

    if (saved.activeQuickCountry !== undefined) {
      activeQuickCountry = saved.activeQuickCountry;
      updateQuickCountriesUI();
    }
  } else {
    // Premier lancement (first launch) : note minimum à 7 par défaut
    document.getElementById("noteMin").value = "7";

    // Premier lancement : sélection par défaut = dernier semestre complet
    const lastSemIdx = dateBreakpoints.length - 2;
    periodMinIdx = lastSemIdx >= 0 ? lastSemIdx : 0;
    periodMaxIdx = periodMinIdx;
    renderPeriodCells();
  }
  
  await initLibrary();
  initSettings();
  search(1);
  updateSortIndicator();
  setTimeout(updateSortIndicator, 100);
})();

function initSettings() {
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsModal = document.getElementById("settingsModal");
  const closeSettingsBtn = document.getElementById("closeSettingsBtn");
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  const tmdbKeyInput = document.getElementById("tmdbKeyInput");
  const omdbKeyInput = document.getElementById("omdbKeyInput");
  const apiKeyNotice = document.getElementById("apiKeyNotice");

  if (!settingsBtn || !settingsModal) return;

  function openSettings() {
    tmdbKeyInput.value = TMDB_API_KEY;
    omdbKeyInput.value = OMDB_API_KEY;
    showKeysToggle.checked = false;
    tmdbKeyInput.type = omdbKeyInput.type = "password";
    apiKeyNotice.hidden = Boolean(TMDB_API_KEY);
    settingsModal.hidden = false;
  }

  // Sans clé TMDB l'application ne peut rien afficher : la fenêtre s'ouvre
  // d'elle-même et ne peut pas être fermée tant qu'une clé n'est pas saisie.
  function closeSettings() {
    if (!TMDB_API_KEY) return;
    settingsModal.hidden = true;
  }

  // Les clés sont masquées par défaut ; la case permet de vérifier une saisie.
  const showKeysToggle = document.getElementById("showKeysToggle");
  showKeysToggle.addEventListener("change", () => {
    const type = showKeysToggle.checked ? "text" : "password";
    tmdbKeyInput.type = type;
    omdbKeyInput.type = type;
  });

  settingsBtn.addEventListener("click", openSettings);
  closeSettingsBtn.addEventListener("click", closeSettings);

  // Fermer en cliquant à l'extérieur de la modale
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) closeSettings();
  });

  if (!TMDB_API_KEY) openSettings();

  // Enregistrer
  saveSettingsBtn.addEventListener("click", () => {
    const newTmdb = tmdbKeyInput.value.trim();
    if (!newTmdb) {
      toast("La clé TMDB est obligatoire");
      return;
    }
    const keysChanged = newTmdb !== TMDB_API_KEY || omdbKeyInput.value.trim() !== OMDB_API_KEY;
    saveApiKeys(newTmdb, omdbKeyInput.value);

    // Les cartes déjà affichées ont été chargées avec l'ancienne clé.
    if (keysChanged) {
      location.reload();
      return;
    }
    settingsModal.hidden = true;
    toast("Paramètres enregistrés !");
  });
}
