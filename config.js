// Clés API : saisies par l'utilisateur dans ⚙️ Paramètres et stockées dans son
// navigateur (localStorage). Aucune clé ne figure jamais dans le dépôt.
let TMDB_API_KEY = "";
let OMDB_API_KEY = "";

const LS_TMDB_KEY = "cine_tmdb_key";
const LS_OMDB_KEY = "cine_omdb_key";

function readStoredKey(name) {
  try {
    return (localStorage.getItem(name) || "").trim();
  } catch (e) {
    return "";
  }
}

async function loadEnv() {
  TMDB_API_KEY = readStoredKey(LS_TMDB_KEY);
  OMDB_API_KEY = readStoredKey(LS_OMDB_KEY);
}

// Enregistre (ou efface, si vide) les clés saisies dans les paramètres.
function saveApiKeys(tmdbKey, omdbKey) {
  [[LS_TMDB_KEY, tmdbKey], [LS_OMDB_KEY, omdbKey]].forEach(([name, value]) => {
    const v = (value || "").trim();
    if (v) localStorage.setItem(name, v);
    else localStorage.removeItem(name);
  });
}
