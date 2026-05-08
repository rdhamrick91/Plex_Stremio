# Plex → Stremio Bridge V4

Self-hosted Plex addon for Stremio-compatible clients like Stremio and Flimra.

## V4 changes

- Plex PIN login: no manual password entry.
- Discovers owned and shared Plex servers.
- Lets you choose server and libraries.
- Generates a private manifest URL.
- Adds universal stream ID matching for Flimra/Stremio global search:
  - `plex:<ratingKey>` from the addon's own catalog
  - IMDb movie IDs like `tt1234567`
  - TV episode IDs like `tt1234567:1:1`
  - Basic `tmdb:` and `tvdb:` GUID matching when Plex metadata exposes those GUIDs
- Builds a cached Plex GUID index so matching works across the whole library without per-show patches.

## Deploy

```bash
npm install
npm start
```

Open:

```text
/configure
```

Then:

1. Click **Login with Plex**.
2. Approve the Plex login.
3. Discover servers.
4. Pick your shared/owned server.
5. Pick libraries.
6. Generate manifest URL.
7. Paste the manifest URL into Stremio/Flimra.

## Replit

Use Node.js. The app listens on `process.env.PORT` automatically.

## Optional environment variables

```text
PUBLIC_URL=https://your-domain.example.com
SECRET_KEY=long-random-string
DATA_DIR=./data
INDEX_TTL_MS=21600000
INDEX_MAX_ITEMS_PER_LIBRARY=5000
```

`SECRET_KEY` encrypts saved Plex tokens in `data/configs.json`. Do not commit `data/configs.json` publicly after real usage.

## Notes

V4 solves the big 404 issue where Flimra asks the addon for streams using IMDb episode IDs instead of Plex rating keys. It still depends on Plex metadata exposing IMDb/TMDB/TVDB GUIDs. Badly matched Plex items, anime/specials, and restricted shared servers may still need extra handling.
