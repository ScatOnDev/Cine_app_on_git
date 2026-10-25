# 🎬 Mon Ciné

**Trouvez de bons films et séries, gardez ceux qui vous intéressent.**

Mon Ciné est un site web qui sert à **découvrir** des films et des séries à partir d'une période, d'une note minimale, de pays et de genres, puis à **mettre de côté** ceux que vous voulez voir dans une bibliothèque personnelle. Il n'y a rien à installer : tout se passe dans votre navigateur.

👉 **Site : https://scatondev.github.io/Cine_app_on_git/**

---

## Ce que fait l'application

### Découvrir
- **Films ou séries** : bascule en haut de page.
- **Note minimale** : n'afficher que ce qui est noté au-dessus d'un seuil (7 par défaut).
- **Période** : une frise de semestres, de 2000 à aujourd'hui. Cliquez sur un ou plusieurs semestres pour choisir les sorties à explorer.
- **Pays d'origine** : une barre de drapeaux (France, Royaume-Uni, Japon, Corée du Sud…). Les drapeaux se réordonnent par glisser-déposer.
- **Genres à exclure** : décochez ce que vous ne voulez jamais voir (horreur, animation…).
- **Tri** par note ou par date, défilement infini, et un champ pour filtrer par titre.

### Évaluer d'un coup d'œil
Chaque fiche affiche l'affiche, le titre original et traduit, la date de sortie, la note, le synopsis (traduit en français s'il manque), la distribution et un lien vers la **bande-annonce**.

Quand un film a peu de votes sur TMDB, l'application cherche un second avis : la note **IMDb** (si vous avez fourni une clé OMDb), puis les **récompenses et sélections en festival** (Wikidata). Si rien n'est assez fiable, elle l'indique plutôt que d'afficher une note trompeuse.

Un clic sur un **acteur** affiche ses autres films, triables par note ou par date.

### Garder
- Le bouton **+** d'une fiche l'ajoute à votre **bibliothèque** (onglet *Ma bibliothèque*), avec sa date d'ajout.
- Dans les résultats de recherche, un badge vert **« Déjà retenu »** signale les films que vous avez déjà mis de côté.

---

## Premiers pas (2 minutes)

### 1. Obtenir une clé TMDB (gratuite, obligatoire)
Les données viennent de [The Movie Database](https://www.themoviedb.org/). Il faut votre propre clé :
1. Créez un compte gratuit sur https://www.themoviedb.org/signup
2. Allez dans **Paramètres → API** (https://www.themoviedb.org/settings/api) et demandez une clé (usage personnel).
3. Copiez la valeur **« Clé d'API »** (une longue suite de 32 caractères).

### 2. (Facultatif) Obtenir une clé OMDb
Elle sert à ajouter la note IMDb des films peu votés. Demandez-la sur https://www.omdbapi.com/apikey.aspx (offre gratuite : 1 000 requêtes par jour, confirmation par e-mail). Sans elle, l'application fonctionne, avec un peu moins de précision sur les films confidentiels.

### 3. Ouvrir le site et saisir les clés
1. Ouvrez https://scatondev.github.io/Cine_app_on_git/
2. Au premier lancement, la fenêtre **⚙️ Paramètres** s'ouvre toute seule : collez votre clé TMDB (et la clé OMDb si vous en avez une), puis **Enregistrer**.
3. La page se recharge et les films s'affichent.

Vos clés sont **enregistrées uniquement dans votre navigateur** et masquées à l'écran (cochez *Afficher les clés* pour vérifier une saisie). Vous pouvez les changer à tout moment avec le bouton ⚙️. Elles ne sont envoyées qu'à TMDB et OMDb, jamais à un autre serveur.

### 4. Créer votre fichier de bibliothèque
Sous **Chrome** ou **Edge**, un bandeau propose de créer un fichier `cine-liste.json` :
- **🆕 Créer un fichier vide** : choisissez un dossier de votre ordinateur. C'est la bonne option pour un premier usage.
- **📁 Connecter un fichier existant** : si vous avez déjà un `cine-liste.json`.
- **Plus tard** : vous pourrez le faire depuis l'onglet *Ma bibliothèque*.

Une fois le fichier lié, chaque film ajouté y est enregistré automatiquement.

---

## Vos données et leur sauvegarde

Il n'y a **pas de compte ni de serveur** : tout reste chez vous.

| Quoi | Où c'est stocké |
|---|---|
| Clés API, filtres, ordre des drapeaux | Dans le navigateur (`localStorage`) |
| Bibliothèque | Dans le navigateur, et dans votre fichier `cine-liste.json` s'il est connecté |

Boutons de l'onglet *Ma bibliothèque* :
- **💾 Sauvegarder ma sélection** : verse vos films dans `cine-liste.json` **sans rien écraser**. Seuls les films qui n'y sont pas encore sont ajoutés.
- **⬆ Importer** : remplace la bibliothèque par le contenu d'un fichier JSON.
- **📁 Connecter** / **🆕 Nouveau fichier** : lier un fichier existant ou en créer un.

⚠️ **Les données du navigateur sont propres à chaque appareil et chaque navigateur.** Pour retrouver votre bibliothèque ailleurs (ou si vous videz les données du navigateur), gardez votre fichier `cine-liste.json` et reconnectez-le ou importez-le.

**Navigateurs** : Chrome et Edge pour la liaison directe avec un fichier. Sous Firefox et Safari, tout fonctionne, mais « Sauvegarder ma sélection » télécharge le fichier au lieu de le mettre à jour.

---

## Bon à savoir

- **Quotas** : TMDB n'a pas de plafond gênant en usage normal. OMDb est limité à 1 000 requêtes par jour sur l'offre gratuite ; un défilement très long sur des films confidentiels peut l'épuiser. L'application continue alors de fonctionner sans la note IMDb.
- **Rien ne s'affiche ?** Vérifiez la clé TMDB dans ⚙️ (une clé invalide donne une erreur 401).
- **Vie privée** : les affiches viennent de TMDB, les drapeaux de flagcdn, les bandes-annonces sont des liens YouTube. Aucune statistique ni cookie de suivi.

---

## Pour les développeurs

Application statique (HTML, CSS, JavaScript sans framework ni étape de compilation).

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page |
| `app.js` | Logique : recherche TMDB, enrichissement des notes, bibliothèque |
| `config.js` | Lecture et enregistrement des clés (`localStorage`) |
| `style.css` | Styles |

**Tester en local** : `python -m http.server 8000`, puis http://localhost:8000/ (il faut un serveur : l'ouverture directe du fichier en `file://` est bloquée par le navigateur pour certaines fonctions). Un `cine-liste.json` placé à côté de `index.html` est lu au démarrage ; il est ignoré par git.

**Publier votre propre copie** : forkez ou clonez le dépôt, puis *Settings → Pages → Deploy from a branch → `main` / `(root)`*. Aucune clé n'est à configurer : chaque visiteur saisit la sienne.
