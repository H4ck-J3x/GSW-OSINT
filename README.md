# GeoSleuth Web

Dépose un screenshot ou une photo, et regarde sa géolocalisation se construire en direct sur une carte : pays candidats avec les indices pour et contre, zones qui se resserrent, repères qui ont permis d'identifier le lieu, point final ou périmètre probable.

Le raisonnement est fait par [Claude Code](https://claude.com/claude-code) en mode headless avec la skill [geo-sleuth](https://github.com/Oldcircle/geo-sleuth) (OCR, recherche d'image inversée, OSM, satellite, Street View…). Cette app est l'interface : elle lance les analyses et affiche leur progression.

## Fonctionnalités

- Lecture des métadonnées en premier : si la photo contient du GPS, le lieu s'affiche en quelques secondes.
- Passe rapide pour un premier pays en environ 15 s, puis analyse approfondie relancée tant qu'aucun point à moins d'1 km n'est trouvé.
- Pays possibles avec indices ✓/✗, pistes alternatives, étapes du zoom, repères avec l'extrait de photo correspondant.
- Sélection d'une zone de l'image (panneau, enseigne, montagne…) pour lancer une analyse ciblée sur cet élément.
- Terminal et onglet métadonnées intégrés.
- Enregistrement et réimport du résultat (`.geosleuth.json`).

## Prérequis

- [Node.js](https://nodejs.org) 18 ou plus (aucun paquet npm)
- [Claude Code](https://claude.com/claude-code) installé et connecté (`claude` dans le PATH)
- La skill **geo-sleuth** installée dans `~/.claude/skills/geo-sleuth` (voir [son dépôt](https://github.com/Oldcircle/geo-sleuth))
- [uv](https://docs.astral.sh/uv/) (scripts Python de la skill et lecture des métadonnées)
- Linux recommandé : le nettoyage complet des processus lit `/proc`. Ailleurs l'app fonctionne, mais seul le processus `claude` est arrêté, pas les scripts qu'il a lancés.

## Lancer

```bash
node server.js
# puis ouvrir http://localhost:8787
```

`PORT` change le port, `CLAUDE_BIN` le chemin de la commande `claude`.

Tests (avec un faux `claude`, sans consommer de quota) :

```bash
node test.js
```

## Sécurité et vie privée

- Les analyses lancent `claude` avec `--dangerously-skip-permissions` : un mode headless ne peut pas répondre aux demandes d'autorisation. Le serveur écoute uniquement sur `127.0.0.1`. **Ne l'expose pas sur un réseau.**
- Les images sont envoyées à Claude (Anthropic) et, via la skill, à des services de recherche d'image inversée (Baidu, Yandex) et à des API cartographiques. N'y mets pas d'images que tu ne veux pas partager.
- Chaque analyse travaille dans un dossier temporaire `geosleuth-*`, supprimé à la fin (ou au rechargement de la page, ou au redémarrage du serveur) avec l'historique de session Claude correspondant.
- Une analyse consomme le quota de ton compte Claude, d'autant plus que l'analyse approfondie peut être relancée jusqu'à deux fois.

## Fichiers

| Fichier | Rôle |
|---|---|
| `server.js` | Serveur HTTP, lancement et nettoyage des analyses, protocole `@@GEO` |
| `index.html` | Toute l'interface (Leaflet chargé depuis unpkg) |
| `meta.py` | Lecture de toutes les métadonnées de l'image |
| `test.js` | Tests de bout en bout avec un faux `claude` |
