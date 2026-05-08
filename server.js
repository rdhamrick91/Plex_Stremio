import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { nanoid } from 'nanoid';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 7000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'configs.json');
const APP_NAME = process.env.ADDON_NAME || 'Plex Login Stremio Bridge V4';
const CLIENT_ID = process.env.PLEX_CLIENT_ID || `stremio-plex-bridge-${crypto.randomUUID?.() || nanoid(24)}`;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { await fs.access(CONFIG_FILE); }
  catch { await fs.writeFile(CONFIG_FILE, JSON.stringify({}, null, 2)); }
}
async function readConfigs() { await ensureStore(); return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')); }
async function writeConfigs(configs) { await ensureStore(); await fs.writeFile(CONFIG_FILE, JSON.stringify(configs, null, 2)); }
function encryptMaybe(value) {
  const key = process.env.SECRET_KEY;
  if (!key) return { plain: value };
  const hash = crypto.createHash('sha256').update(key).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', hash, iv);
  const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: Buffer.concat([iv, tag, enc]).toString('base64') };
}
function decryptMaybe(obj) {
  if (obj?.plain) return obj.plain;
  const key = process.env.SECRET_KEY;
  if (!key || !obj?.enc) throw new Error('Missing SECRET_KEY for encrypted config');
  const raw = Buffer.from(obj.enc, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
function base(req) { return PUBLIC_URL || `${req.protocol}://${req.get('host')}`; }
function cleanUrl(u) { return String(u || '').trim().replace(/\/$/, ''); }
function arr(v) { return !v ? [] : Array.isArray(v) ? v : [v]; }

function plexHeaders(extra = {}) {
  return {
    Accept: 'application/json, application/xml, text/xml, */*',
    'X-Plex-Product': 'Stremio Plex Bridge',
    'X-Plex-Version': '4.0.0',
    'X-Plex-Client-Identifier': CLIENT_ID,
    'X-Plex-Platform': 'Web',
    'X-Plex-Device': 'Browser',
    'X-Plex-Device-Name': 'Stremio Plex Bridge',
    ...extra
  };
}
async function parsePlexResponse(text) {
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch {}
  try { return await parseStringPromise(text, { explicitArray: false, mergeAttrs: true }); }
  catch { return text; }
}
async function httpGet(url, token, params = {}) {
  const res = await axios.get(url, {
    params: token ? { ...params, 'X-Plex-Token': token } : params,
    headers: plexHeaders(),
    timeout: 20000,
    responseType: 'text',
    validateStatus: s => s >= 200 && s < 300
  });
  return parsePlexResponse(res.data);
}
async function plexGet(config, endpoint, params = {}) {
  const token = decryptMaybe(config.token);
  const url = `${config.plexUrl}${endpoint}`;
  return httpGet(url, token, params);
}


// ---------------- V4 universal ID matching ----------------
// Stremio/Flimra often asks stream routes using global IDs such as:
//   movie:  tt1234567
//   series: tt1234567:1:1
// Catalog items from this addon still use plex:<ratingKey>. V4 supports both.
const INDEX_TTL_MS = Number(process.env.INDEX_TTL_MS || 6 * 60 * 60 * 1000);
const INDEX_MAX_ITEMS_PER_LIBRARY = Number(process.env.INDEX_MAX_ITEMS_PER_LIBRARY || 5000);
function indexFile(id) { return path.join(DATA_DIR, `index-${id}.json`); }
function safeArray(v) { return arr(v); }
function stripJson(v) { return String(v || '').replace(/\.json$/i, ''); }
function parseStremioId(raw) {
  const decoded = decodeURIComponent(stripJson(raw));
  if (decoded.startsWith('plex:')) return { kind: 'plex', ratingKey: decoded.slice(5), raw: decoded };
  // Stremio TV episode format: imdbid:season:episode
  const ep = decoded.match(/^(tt\d+|tmdb:\d+|tvdb:\d+|kitsu:\d+):(\d+):(\d+)$/i);
  if (ep) return { kind: 'externalEpisode', externalId: normalizeExternalId(ep[1]), season: Number(ep[2]), episode: Number(ep[3]), raw: decoded };
  return { kind: 'external', externalId: normalizeExternalId(decoded), raw: decoded };
}
function normalizeExternalId(id) {
  if (!id) return '';
  let s = String(id).trim();
  if (/^tt\d+$/i.test(s)) return s.toLowerCase();
  s = s.replace(/^imdb:\/\//i, '').replace(/^com\.plexapp\.agents\.imdb:\/\//i, '');
  if (/^tt\d+$/i.test(s)) return s.toLowerCase();
  s = s.replace(/^themoviedb:\/\//i, 'tmdb:').replace(/^tmdb:\/\//i, 'tmdb:');
  s = s.replace(/^thetvdb:\/\//i, 'tvdb:').replace(/^tvdb:\/\//i, 'tvdb:');
  return s.toLowerCase();
}
function extractGuidIds(item) {
  const out = new Set();
  const add = (v) => {
    const n = normalizeExternalId(v);
    if (n) out.add(n);
  };
  add(item?.guid);
  for (const g of safeArray(item?.Guid)) add(g.id || g.guid || g);
  // Some Plex responses expose guids as strings in nested fields depending on agent/version.
  for (const key of ['ratingKey','guid']) {
    if (typeof item?.[key] === 'string') {
      const m = item[key].match(/(tt\d+|tmdb:\d+|tvdb:\d+|themoviedb:\/\/\d+|thetvdb:\/\/\d+)/ig);
      if (m) m.forEach(add);
    }
  }
  return [...out];
}
function itemToIndexEntry(lib, item) {
  const ids = extractGuidIds(item);
  return {
    ratingKey: String(item.ratingKey || item.key || ''),
    key: item.key,
    title: item.title,
    year: item.year,
    type: lib.type,
    libKey: lib.key,
    ids,
    thumb: item.thumb,
    art: item.art,
    summary: item.summary,
    originallyAvailableAt: item.originallyAvailableAt
  };
}
async function fetchAllLibraryItems(config, lib) {
  const out = [];
  const pageSize = 200;
  for (let start = 0; start < INDEX_MAX_ITEMS_PER_LIBRARY; start += pageSize) {
    const data = await plexGet(config, `/library/sections/${lib.key}/all`, {
      'X-Plex-Container-Start': start,
      'X-Plex-Container-Size': pageSize,
      includeGuids: 1,
      includeExternalMedia: 1
    });
    const items = safeArray(data?.MediaContainer?.Video || data?.MediaContainer?.Directory);
    out.push(...items);
    const total = Number(data?.MediaContainer?.totalSize || data?.MediaContainer?.size || items.length);
    if (!items.length || out.length >= total) break;
  }
  return out;
}
async function buildIndex(configId, config, force = false) {
  const fp = indexFile(configId);
  if (!force) {
    try {
      const existing = JSON.parse(await fs.readFile(fp, 'utf8'));
      if (Date.now() - Number(existing.updatedAtMs || 0) < INDEX_TTL_MS) return existing;
    } catch {}
  }
  const index = { version: 4, updatedAt: new Date().toISOString(), updatedAtMs: Date.now(), movies: {}, shows: {}, byRatingKey: {} };
  for (const lib of config.libraries) {
    const items = await fetchAllLibraryItems(config, lib).catch(() => []);
    for (const item of items) {
      const entry = itemToIndexEntry(lib, item);
      if (!entry.ratingKey) continue;
      index.byRatingKey[entry.ratingKey] = entry;
      for (const id of entry.ids) {
        if (lib.type === 'movie') index.movies[id] = entry;
        if (lib.type === 'show') index.shows[id] = entry;
      }
    }
  }
  await fs.writeFile(fp, JSON.stringify(index, null, 2)).catch(() => {});
  return index;
}
async function findPlexEntry(configId, config, parsed, stremioType) {
  if (parsed.kind === 'plex') return { ratingKey: parsed.ratingKey, source: 'plex-id' };
  const index = await buildIndex(configId, config);
  if (parsed.kind === 'externalEpisode') {
    const show = index.shows[parsed.externalId];
    if (!show) return null;
    return { ...show, season: parsed.season, episode: parsed.episode, source: 'external-show-guid' };
  }
  if (stremioType === 'series') return index.shows[parsed.externalId] || null;
  return index.movies[parsed.externalId] || null;
}
async function firstPlayableEpisode(config, showRatingKey, season, episode) {
  const leaves = await plexGet(config, `/library/metadata/${showRatingKey}/allLeaves`, { includeGuids: 1 });
  const eps = safeArray(leaves?.MediaContainer?.Video);
  let item = eps.find(e => Number(e.parentIndex) === Number(season) && Number(e.index) === Number(episode));
  if (!item && Number(season) === 0) item = eps.find(e => Number(e.index) === Number(episode));
  if (!item) item = eps[0];
  return item;
}
async function playableFromRoute(configId, config, type, rawId) {
  const parsed = parseStremioId(rawId);
  const match = await findPlexEntry(configId, config, parsed, type);
  if (!match) return null;
  if (type === 'series') {
    if (match.season !== undefined && match.episode !== undefined) return firstPlayableEpisode(config, match.ratingKey, match.season, match.episode);
    return firstPlayableEpisode(config, match.ratingKey, 1, 1);
  }
  const data = await plexGet(config, `/library/metadata/${match.ratingKey || match.ratingKey}`);
  return safeArray(data?.MediaContainer?.Video)[0];
}
function streamFromPlexItem(config, item) {
  const token = decryptMaybe(config.token);
  const media = safeArray(item?.Media)[0];
  const part = safeArray(media?.Part)[0];
  if (!part?.key) return null;
  const directUrl = `${config.plexUrl}${part.key}?X-Plex-Token=${encodeURIComponent(token)}`;
  const bits = [];
  if (item.grandparentTitle) bits.push(item.grandparentTitle);
  if (item.parentIndex && item.index) bits.push(`S${String(item.parentIndex).padStart(2,'0')}E${String(item.index).padStart(2,'0')}`);
  bits.push(item.title || 'Plex');
  const quality = media?.videoResolution ? ` · ${media.videoResolution}p` : '';
  return { title: `Plex Direct Play\n${bits.join(' - ')}${quality}`, url: directUrl, behaviorHints: { notWebReady: false } };
}

async function createPlexPin(req) {
  const forwardUrl = `${base(req)}/configure?plexLogin=done`;
  const res = await axios.post('https://plex.tv/api/v2/pins', new URLSearchParams({ strong: 'true' }), {
    headers: plexHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    timeout: 15000
  });
  const pin = res.data;
  const authUrl =
    `https://app.plex.tv/auth#?clientID=${encodeURIComponent(CLIENT_ID)}` +
    `&code=${encodeURIComponent(pin.code)}` +
    `&forwardUrl=${encodeURIComponent(forwardUrl)}` +
    `&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent('Stremio Plex Bridge')}`;
  return { id: pin.id, code: pin.code, clientIdentifier: CLIENT_ID, authUrl };
}
async function checkPlexPin(pinId) {
  const res = await axios.get(`https://plex.tv/api/v2/pins/${encodeURIComponent(pinId)}`, {
    headers: plexHeaders(),
    timeout: 15000,
    validateStatus: s => s >= 200 && s < 300
  });
  return { id: res.data.id, code: res.data.code, authToken: res.data.authToken || null };
}

async function accountResources(accountToken) {
  return httpGet('https://plex.tv/api/resources', accountToken, { includeHttps: 1, includeRelay: 1 });
}
function normalizeResources(parsed) {
  const devices = arr(parsed?.MediaContainer?.Device);
  return devices
    .filter(d => String(d.provides || '').includes('server'))
    .map(d => ({
      name: d.name || d.clientIdentifier || 'Plex Server',
      clientIdentifier: d.clientIdentifier,
      owned: String(d.owned) === '1',
      home: String(d.home) === '1',
      sourceTitle: d.sourceTitle || d.name,
      accessToken: d.accessToken,
      connections: arr(d.Connection).map(c => ({
        uri: cleanUrl(c.uri),
        protocol: c.protocol,
        address: c.address,
        port: c.port,
        local: String(c.local) === '1',
        relay: String(c.relay) === '1'
      })).filter(c => c.uri)
    }))
    .filter(d => d.accessToken && d.connections.length);
}
async function probeServer(uri, token) {
  const plexUrl = cleanUrl(uri);
  const config = { plexUrl, token: { plain: token } };
  const root = await plexGet(config, '/').catch(() => null);
  const sections = await plexGet(config, '/library/sections');
  const dirs = arr(sections?.MediaContainer?.Directory).filter(d => ['movie', 'show'].includes(d.type));
  return {
    ok: true,
    plexUrl,
    token,
    server: root?.MediaContainer?.friendlyName || root?.MediaContainer?.machineIdentifier || 'Plex Server',
    libraries: dirs.map(d => ({ key: String(d.key), title: d.title, type: d.type }))
  };
}
async function discoverWorkingServers(accountToken) {
  const parsed = await accountResources(accountToken);
  const devices = normalizeResources(parsed);
  const results = [];
  for (const d of devices) {
    const attempts = [];
    const sorted = [...d.connections].sort((a, b) => {
      const score = c => (c.uri.startsWith('https://') ? 0 : 10) + (c.local ? 25 : 0) + (c.relay ? 8 : 0);
      return score(a) - score(b);
    });
    for (const c of sorted) {
      try {
        const probe = await probeServer(c.uri, d.accessToken);
        if (probe.libraries.length) {
          results.push({
            id: d.clientIdentifier,
            name: d.name,
            sourceTitle: d.sourceTitle,
            owned: d.owned,
            home: d.home,
            plexUrl: probe.plexUrl,
            token: d.accessToken,
            libraries: probe.libraries,
            connection: c
          });
          break;
        }
        attempts.push(`${c.uri}: no movie/show libraries visible`);
      } catch (e) {
        attempts.push(`${c.uri}: ${e.response?.status || ''} ${e.message}`.trim());
      }
    }
    if (!results.find(r => r.id === d.clientIdentifier)) {
      results.push({ id: d.clientIdentifier, name: d.name, sourceTitle: d.sourceTitle, owned: d.owned, home: d.home, error: attempts.join(' | ') || 'No working connection found' });
    }
  }
  return results;
}
function poster(config, item) {
  const token = decryptMaybe(config.token);
  const rel = item.thumb || item.art || '';
  if (!rel) return undefined;
  return `${config.plexUrl}${rel}?X-Plex-Token=${encodeURIComponent(token)}`;
}
function stremioTypeFromPlex(type) { return type === 'show' ? 'series' : 'movie'; }
function manifestFor(req, id, config) {
  const catalogs = config.libraries.map(lib => ({ type: stremioTypeFromPlex(lib.type), id: `plex-${lib.key}`, name: `${lib.title}` }));
  return {
    id: `community.plex.login.bridge.${id}`,
    version: '4.0.0',
    name: config.addonName || APP_NAME,
    description: 'Self-hosted Plex bridge for Stremio with Plex login, server discovery, shared server support, catalogs, metadata, and streams.',
    logo: `${base(req)}/logo.png`,
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    catalogs,
    idPrefixes: ['tt', 'tmdb:', 'tvdb:', 'plex:'],
    behaviorHints: { configurable: true, configurationRequired: false }
  };
}
async function getConfig(id) {
  const configs = await readConfigs();
  const config = configs[id];
  if (!config) throw Object.assign(new Error('Config not found'), { status: 404 });
  return config;
}

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/configure', async (req, res) => res.sendFile(path.join(process.cwd(), 'public', 'configure.html')));

app.post('/api/plex/pin', async (req, res) => {
  try { res.json({ ok: true, ...(await createPlexPin(req)) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.response?.data || e.message }); }
});
app.get('/api/plex/pin/:id', async (req, res) => {
  try { res.json({ ok: true, ...(await checkPlexPin(req.params.id)) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.response?.data || e.message }); }
});
app.post('/api/discover-plex', async (req, res) => {
  try {
    const accountToken = String(req.body.accountToken || '').trim();
    if (!accountToken) throw new Error('Missing Plex login token. Click Login with Plex first.');
    const servers = await discoverWorkingServers(accountToken);
    res.json({ ok: true, servers });
  } catch (e) { res.status(400).json({ ok: false, error: e.response?.data || e.message }); }
});
app.post('/api/test-plex', async (req, res) => {
  try {
    const plexUrl = cleanUrl(req.body.plexUrl);
    const config = { plexUrl, token: { plain: String(req.body.plexToken || '').trim() } };
    const root = await plexGet(config, '/');
    const sections = await plexGet(config, '/library/sections');
    const dirs = arr(sections?.MediaContainer?.Directory).filter(d => ['movie', 'show'].includes(d.type));
    res.json({ ok: true, server: root?.MediaContainer?.friendlyName || 'Plex Server', libraries: dirs.map(d => ({ key: String(d.key), title: d.title, type: d.type })) });
  } catch (e) { res.status(400).json({ ok: false, error: `${e.response?.status ? `HTTP ${e.response.status}: ` : ''}${e.message}` }); }
});
app.post('/api/create-config', async (req, res) => {
  try {
    const plexUrl = cleanUrl(req.body.plexUrl);
    const plexToken = String(req.body.plexToken || '').trim();
    const addonName = String(req.body.addonName || APP_NAME).trim();
    let selectedLibraries = req.body.libraries || [];
    if (typeof selectedLibraries === 'string') selectedLibraries = [selectedLibraries];
    const temp = { plexUrl, token: { plain: plexToken } };
    const sections = await plexGet(temp, '/library/sections');
    const available = arr(sections?.MediaContainer?.Directory).filter(d => ['movie', 'show'].includes(d.type));
    const libraries = available
      .filter(d => selectedLibraries.length === 0 || selectedLibraries.includes(String(d.key)))
      .map(d => ({ key: String(d.key), title: d.title, type: d.type }));
    if (!plexUrl || !plexToken || libraries.length === 0) throw new Error('Missing Plex URL, token, or libraries.');
    const id = nanoid(18);
    const configs = await readConfigs();
    configs[id] = { createdAt: new Date().toISOString(), plexUrl, addonName, token: encryptMaybe(plexToken), libraries };
    await writeConfigs(configs);
    const manifestUrl = `${base(req)}/${id}/manifest.json`;
    res.json({ ok: true, id, manifestUrl, stremioUrl: `stremio://${manifestUrl.replace(/^https?:\/\//, '')}` });
  } catch (e) { res.status(400).json({ ok: false, error: `${e.response?.status ? `HTTP ${e.response.status}: ` : ''}${e.message}` }); }
});

app.post('/:id/rebuild-index', async (req, res) => {
  try { const config = await getConfig(req.params.id); const idx = await buildIndex(req.params.id, config, true); res.json({ ok: true, movies: Object.keys(idx.movies).length, shows: Object.keys(idx.shows).length, updatedAt: idx.updatedAt }); }
  catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
});

app.get('/:id/manifest.json', async (req, res) => {
  try { res.json(manifestFor(req, req.params.id, await getConfig(req.params.id))); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/:id/catalog/:type/:catalogId.json', async (req, res) => {
  try {
    const config = await getConfig(req.params.id);
    const key = req.params.catalogId.replace('plex-', '');
    const lib = config.libraries.find(l => l.key === key);
    if (!lib) return res.json({ metas: [] });
    const data = await plexGet(config, `/library/sections/${key}/all`, { 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 100 });
    const items = arr(data?.MediaContainer?.Video || data?.MediaContainer?.Directory);
    const metas = items.map(item => ({
      id: `plex:${item.ratingKey}`,
      type: stremioTypeFromPlex(lib.type),
      name: item.title,
      poster: poster(config, item),
      background: poster(config, { thumb: item.art || item.thumb }),
      description: item.summary,
      releaseInfo: item.year || item.originallyAvailableAt
    }));
    res.json({ metas });
  } catch (e) { res.status(e.status || 500).json({ metas: [], error: e.message }); }
});
app.get('/:id/meta/:type/:plexId.json', async (req, res) => {
  try {
    const config = await getConfig(req.params.id);
    const parsed = parseStremioId(req.params.plexId);
    const match = await findPlexEntry(req.params.id, config, parsed, req.params.type);
    const ratingKey = parsed.kind === 'plex' ? parsed.ratingKey : match?.ratingKey;
    if (!ratingKey) return res.json({ meta: null });
    const data = await plexGet(config, `/library/metadata/${ratingKey}`, { includeGuids: 1 });
    const item = safeArray(data?.MediaContainer?.Video || data?.MediaContainer?.Directory)[0];
    if (!item) return res.json({ meta: null });
    const meta = {
      id: req.params.plexId,
      type: req.params.type,
      name: item.title,
      poster: poster(config, item),
      background: poster(config, { thumb: item.art || item.thumb }),
      description: item.summary,
      releaseInfo: item.year || item.originallyAvailableAt,
      runtime: item.duration ? Math.round(Number(item.duration) / 60000) + ' min' : undefined
    };
    res.json({ meta });
  } catch (e) { res.json({ meta: null, error: e.message }); }
});
app.get('/:id/stream/:type/:plexId.json', async (req, res) => {
  try {
    const config = await getConfig(req.params.id);
    const item = await playableFromRoute(req.params.id, config, req.params.type, req.params.plexId);
    const stream = streamFromPlexItem(config, item);
    // Return HTTP 200 with empty streams instead of 404/500. Flimra surfaces route failures loudly.
    if (!stream) return res.json({ streams: [] });
    res.json({ streams: [stream] });
  } catch (e) { res.json({ streams: [], error: e.message }); }
});


app.listen(PORT, () => console.log(`${APP_NAME} running on :${PORT}`));
