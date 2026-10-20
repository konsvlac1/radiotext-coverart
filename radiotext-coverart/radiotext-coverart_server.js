// RadioText Cover Art — server-side companion (v2.1)

const fs = require('fs');
const path = require('path');
const router = require('../../server/endpoints');

const VERSION = '2.1';
const CONFIG_PATH = path.join(__dirname, '../../plugins_configs/radiotext-coverart.json');

const CACHE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
// A client's "Retry if no artwork" may skip a cached miss only once that
// miss is this old, so many listeners retrying together cost one lookup.
const RETRY_MIN_AGE_MS = 25 * 1000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map();
const inflight = new Map();

// ---------------------------------------------------------------
// Server defaults (plugins_configs/radiotext-coverart.json)
// ---------------------------------------------------------------
// "providers" switches a lookup source off for everyone. "defaults" are
// the page settings every visitor starts with; visitors can override them
// per browser from the ♫ panel. The schema is shared with the front-end.
const SCHEMA = {
    enabled:         { type: 'bool', def: true },
    songSource:      { type: 'enum', def: 'both', values: ['both', 'rt', 'ps'] },
    placement:       { type: 'enum', def: 'af', values: ['af', 'rt', 'ps', 'float'] },
    side:            { type: 'enum', def: 'right', values: ['left', 'right'] },
    size:            { type: 'int', def: 100, min: 60, max: 400 },
    gap:             { type: 'int', def: 8, min: 0, max: 40 },
    stableDelay:     { type: 'int', def: 2500, min: 500, max: 10000 },
    strictness:      { type: 'enum', def: 'normal', values: ['loose', 'normal', 'strict'] },
    retry:           { type: 'bool', def: true },
    backdrop:        { type: 'enum', def: 'none', values: ['none', 'blur'] },
    rtBackground:    { type: 'enum', def: 'blur', values: ['off', 'blur', 'sharp'] },
    blur:            { type: 'int', def: 12, min: 0, max: 40 },
    itunes:          { type: 'bool', def: true },
    deezer:          { type: 'bool', def: true },
    musicbrainz:     { type: 'bool', def: true },
    retainLast:      { type: 'bool', def: false },
    captionHover:    { type: 'bool', def: true },
    persistentCache: { type: 'bool', def: true },
    debug:           { type: 'bool', def: false }
};

const PROVIDER_ORDER = ['itunes', 'deezer', 'musicbrainz'];

function sanitizeValue(spec, v) {
    if (spec.type === 'bool') return typeof v === 'boolean' ? v : undefined;
    if (spec.type === 'enum') return spec.values.indexOf(v) >= 0 ? v : undefined;
    if (spec.type === 'int') {
        const n = Math.round(Number(v));
        if (!Number.isFinite(n)) return undefined;
        return Math.min(spec.max, Math.max(spec.min, n));
    }
    return undefined;
}

function sanitizeDefaults(input) {
    const out = {};
    for (const key of Object.keys(SCHEMA)) {
        const v = input ? sanitizeValue(SCHEMA[key], input[key]) : undefined;
        out[key] = v === undefined ? SCHEMA[key].def : v;
    }
    return out;
}

function sanitizeConfig(input) {
    const src = input && typeof input === 'object' ? input : {};
    const providers = {};
    for (const name of PROVIDER_ORDER) {
        providers[name] = !(src.providers && src.providers[name] === false);
    }
    const defaultImage = typeof src.defaultImage === 'string' && /^\/[\w\-./]+$/.test(src.defaultImage)
        ? src.defaultImage
        : null;
    return { providers, defaultImage, defaults: sanitizeDefaults(src.defaults) };
}

let serverConfig = sanitizeConfig(null);

function loadConfig() {
    try {
        serverConfig = sanitizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } catch (err) {
        serverConfig = sanitizeConfig(null);
        saveConfig();
    }
}

function saveConfig() {
    try {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(serverConfig, null, 2));
    } catch (err) {
        console.warn('[RadioText Cover Art] could not write', CONFIG_PATH, err.message);
    }
}

loadConfig();

// ---------------------------------------------------------------
// Cache
// ---------------------------------------------------------------
function cacheGet(key, allowNegative = true) {
    const entry = cache.get(key);
    if (!entry) return null;
    const age = Date.now() - entry.ts;
    const ttl = entry.data.found ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    if (age > ttl) {
        cache.delete(key);
        return null;
    }
    if (!entry.data.found && !allowNegative && age >= RETRY_MIN_AGE_MS) return null;
    return entry.data;
}

function cacheSet(key, data) {
    if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
    }
    cache.set(key, { data, ts: Date.now() });
}

// Every listener on the station asks for the same song at the same moment;
// they share one lookup.
function cachedLookup(key, allowNegative, compute) {
    const hit = cacheGet(key, allowNegative);
    if (hit) return Promise.resolve(hit);
    if (inflight.has(key)) return inflight.get(key);
    const run = compute()
        .catch(() => ({ found: false }))
        .then(result => {
            cacheSet(key, result);
            return result;
        })
        .finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
}

const USER_AGENT = `fm-dx-webserver-radiotext-coverart-plugin/${VERSION} ( https://github.com/DitraXp/radiotext-coverart )`;

async function fetchWithTimeout(url, timeoutMs = 5000, method = 'GET') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method,
            signal: controller.signal,
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
        });
        if (method === 'HEAD') return response.ok;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

// MusicBrainz allows one request per second per client; queue our calls so
// a burst of listeners can't get the server's IP throttled.
const MB_INTERVAL_MS = 1100;
const MB_MAX_QUEUE = 20;
let mbChain = Promise.resolve();
let mbQueued = 0;
let mbLast = 0;

function mbFetch(url) {
    if (mbQueued >= MB_MAX_QUEUE) return Promise.reject(new Error('MusicBrainz queue full'));
    mbQueued++;
    const run = mbChain.then(async () => {
        const wait = mbLast + MB_INTERVAL_MS - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        mbLast = Date.now();
        return fetchWithTimeout(url, 8000);
    });
    mbChain = run.catch(() => {}).then(() => { mbQueued--; });
    return run;
}

// ---------------------------------------------------------------
// Matching
// ---------------------------------------------------------------
function normalize(s) {
    return (s || '')
        .toString()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/['’]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

// Greek music is listed in Greeklish on iTunes and Deezer ("Eleni Foureira"),
// while RDS sends Greek letters, or capitals that spell Greek by letter
// shape ("ELENH FOYREIRA" for ΕΛΕΝΗ ΦΟΥΡΕΙΡΑ). Names are compared as a rough
// phonetic skeleton with a little tolerance, so all of these meet.
const GREEK_TO_LATIN = {
    'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'th',
    'ι': 'i', 'κ': 'k', 'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p',
    'ρ': 'r', 'σ': 's', 'ς': 's', 'τ': 't', 'υ': 'y', 'φ': 'f', 'χ': 'ch', 'ψ': 'ps', 'ω': 'o'
};

function transliterate(s) {
    return normalize(s).replace(/\p{Script=Greek}/gu, ch => GREEK_TO_LATIN[ch] || '');
}

function skeleton(s) {
    return transliterate(s)
        .replace(/ch|kh|x/g, 'h')
        .replace(/ou|oy/g, 'u')
        .replace(/ei|oi|yi|y/g, 'i')
        .replace(/ai/g, 'e')
        .replace(/ph/g, 'f')
        .replace(/w/g, 'o')
        .replace(/(\p{L})\1+/gu, '$1');
}

// 1 = identical, 0 = nothing alike (Levenshtein distance over the longer length).
function similarity(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
}

function wordsMatch(a, b) {
    return a === b || (a.length >= 5 && b.length >= 5 && similarity(a, b) >= 0.8);
}

// In capitals, Th is Θ, H is Η, Y is Υ (OY, AY, EY are ου, αυ, ευ) and X is
// Χ; when real Greek letters are mixed in, Latin P and B stand for Ρ and Β.
function looksShapeGreek(s) {
    const t = s.replace(/\b(?:ft|feat|featuring|vs)\b\.?/gi, '').replace(/Th/g, 'TH');
    return /[A-Z]/.test(t) && !/[a-z]/.test(t);
}

function greeklishOf(s) {
    if (looksShapeGreek(s)) {
        let t = s;
        if (/\p{Script=Greek}/u.test(t)) t = t.replace(/P/g, 'R').replace(/B/g, 'V');
        t = t.replace(/Th/g, 'Θ')
            .replace(/OY/g, 'OU').replace(/AY/g, 'AV').replace(/EY/g, 'EV')
            .replace(/[YH]/g, 'I')
            .replace(/X/g, 'CH');
        return transliterate(t);
    }
    if (/\p{Script=Greek}/u.test(s)) return transliterate(s);
    return null;
}

// RadioText/PS that is clearly not a song: phone numbers, e-mail and web
// addresses, frequencies ("97.8"); for PS also a word repeated three times,
// which is what a scrolling station name assembles into.
const PHONE_PREFIX = /^\s*(?:\p{L}{1,4}\.?:?\s*)?\+?\d[\d\s\-.\/()]{5,}\d\s*[-:|]?\s*/u;

function stripPhonePrefix(s) {
    return s.replace(PHONE_PREFIX, '').trim();
}

function isJunkText(s, isPs) {
    if (/@|https?:|www\.|\.(?:gr|com|net|org|eu)\b/i.test(s)) return true;
    if ((s.match(/\d/g) || []).length >= 7) return true;
    if (/(?:^|\s)\d{2,3}[.,]\d{1,2}(?=\s|$)/.test(s)) return true;
    if (isPs) {
        const counts = {};
        for (const w of normalize(s).split(' ').filter(Boolean)) {
            counts[w] = (counts[w] || 0) + 1;
            if (counts[w] >= 3) return true;
        }
    }
    return false;
}

function isJunkPair(artist, title) {
    if (isJunkText(`${artist} ${title}`, false)) return true;
    if (/^(?:spot|news|ads?|eidiseis|diafimis\w*|reklam\w*)$/.test(normalize(artist))) return true;
    const a = skeleton(artist);
    return !!a && a === skeleton(title);
}

function cleanTitle(s) {
    const text = (s || '').toString();
    const cleaned = text
        .replace(/\s*[\(\[].*$/, '')
        .replace(/\s+[-–—]\s.*$/, '')
        .replace(/\s+(?:feat\.?|ft\.?|featuring)\s.*$/i, '')
        .trim();
    return cleaned || text;
}

function fieldScore(candidate, wanted) {
    if (!candidate || !wanted) return 0;
    if (candidate === wanted) return 3;
    if (candidate.includes(wanted) || wanted.includes(candidate)) {
        const shorter = Math.min(candidate.length, wanted.length);
        const longer = Math.max(candidate.length, wanted.length);
        return shorter / longer >= 0.5 ? 2 : 1;
    }
    const sim = similarity(candidate, wanted);
    if (sim >= 0.8) return 2;
    if (sim >= 0.65) return 1;
    return 0;
}

function artistMatches(candidateArtist, wantedArtist) {
    const c = skeleton(candidateArtist);
    const w = skeleton(wantedArtist);
    if (!c || !w) return false;
    if (c.includes(w) || w.includes(c)) return true;
    const cw = c.split(' ').filter(x => x.length >= 3);
    return w.split(' ').filter(x => x.length >= 3).some(x => cw.some(y => wordsMatch(x, y)));
}

function scoreCandidate(track, wantArtist, wantTitle) {
    const artistScore = fieldScore(skeleton(track.artistName), skeleton(wantArtist));
    const titleScore = fieldScore(skeleton(cleanTitle(track.trackName)), skeleton(cleanTitle(wantTitle)));
    const artistOk = artistMatches(track.artistName, wantArtist);
    return { artistScore, titleScore, artistOk, total: artistScore + titleScore };
}

// loose: partial title, normal: title mostly matches, strict: exact title and
// artist (after cleanup of "(Remix)", "feat." and so on).
function passes(score, strictness) {
    if (!score.artistOk) return false;
    if (strictness === 'strict') return score.titleScore >= 3 && score.artistScore >= 2;
    if (strictness === 'loose') return score.titleScore >= 1;
    return score.titleScore >= 2;
}

function rankMatches(results, wantArtist, wantTitle, strictness) {
    return results
        .map(track => ({ track, score: scoreCandidate(track, wantArtist, wantTitle) }))
        .filter(m => passes(m.score, strictness))
        .sort((a, b) => b.score.total - a.score.total)
        .map(m => m.track);
}

// MusicBrainz results carry no artwork until the Cover Art Archive is asked,
// so check the best few candidates and take the first that has a cover.
async function firstWithArtwork(tracks) {
    let checked = 0;
    for (const track of tracks) {
        if (track.artwork) return track;
        if (!track.resolveArtwork || checked >= 5) continue;
        checked++;
        try {
            if (await track.resolveArtwork()) return track;
        } catch (err) {
        }
    }
    return null;
}

function fromItunes(t) {
    const art100 = t.artworkUrl100 || '';
    return {
        artistName: t.artistName || '',
        trackName: t.trackName || '',
        collectionName: t.collectionName || '',
        year: t.releaseDate ? String(t.releaseDate).slice(0, 4) : '',
        artwork: art100.replace('100x100bb', '300x300bb'),
        artworkBig: art100.replace('100x100bb', '600x600bb'),
        storeUrl: t.trackViewUrl || '',
        source: 'Apple Music'
    };
}

function fromDeezer(t) {
    const album = t.album || {};
    return {
        artistName: (t.artist && t.artist.name) || '',
        trackName: t.title || '',
        collectionName: album.title || '',
        year: '',
        artwork: album.cover_medium || '',
        artworkBig: album.cover_big || album.cover_medium || '',
        storeUrl: t.link || '',
        source: 'Deezer'
    };
}

function fromMusicBrainz(r) {
    const credit = (r['artist-credit'] || []).map(c => (c.name || '') + (c.joinphrase || '')).join('').trim();
    const releases = (r.releases || []).filter(rel => rel['release-group'] && rel['release-group'].id);
    // Official albums and singles first, compilations last.
    releases.sort((a, b) => releaseRank(a) - releaseRank(b));
    const track = {
        artistName: credit,
        trackName: r.title || '',
        collectionName: '',
        year: '',
        artwork: '',
        artworkBig: '',
        storeUrl: r.id ? `https://musicbrainz.org/recording/${r.id}` : '',
        source: 'MusicBrainz',
        releaseRank: releases.length ? releaseRank(releases[0]) : 99
    };
    track.resolveArtwork = async () => {
        const seen = new Set();
        for (const rel of releases) {
            const rgid = rel['release-group'].id;
            if (seen.has(rgid)) continue;
            seen.add(rgid);
            if (seen.size > 2) break;
            const base = `https://coverartarchive.org/release-group/${rgid}`;
            if (await fetchWithTimeout(`${base}/front-250`, 6000, 'HEAD')) {
                track.artwork = `${base}/front-250`;
                track.artworkBig = `${base}/front-500`;
                track.collectionName = rel.title || '';
                track.year = (rel.date || r['first-release-date'] || '').slice(0, 4);
                return true;
            }
        }
        return false;
    };
    return track;
}

function releaseRank(rel) {
    const rg = rel['release-group'] || {};
    let rank = 0;
    if (rel.status && rel.status !== 'Official') rank += 4;
    if ((rg['secondary-types'] || []).length) rank += 2;
    if (rg['primary-type'] !== 'Album' && rg['primary-type'] !== 'Single') rank += 1;
    return rank;
}

// Recordings on an official album or single first; live bootlegs and
// compilations rarely have a cover in the Cover Art Archive.
function mbResults(data) {
    return ((data && data.recordings) || []).map(fromMusicBrainz)
        .filter(t => t.releaseRank < 99)
        .sort((a, b) => a.releaseRank - b.releaseRank);
}

function mbEscape(s) {
    return s.replace(/([+\-&|!(){}\[\]^"~*?:\\\/])/g, '\\$1');
}

// opts.greek: a Greeklish reading of Greek RT; the Greek iTunes store has
// Greek artists the default (US) store lacks.
const providers = {
    itunes: {
        async byArtist(artist, title, opts = {}) {
            const url = `https://itunes.apple.com/search?term=${encodeURIComponent(artist)}&attribute=artistTerm&entity=song&limit=50${opts.greek ? '&country=GR' : ''}`;
            const data = await fetchWithTimeout(url);
            return ((data && data.results) || []).map(fromItunes);
        },
        async general(text, limit = 5, opts = {}) {
            const url = `https://itunes.apple.com/search?term=${encodeURIComponent(text)}&entity=song&limit=${limit}${opts.greek ? '&country=GR' : ''}`;
            const data = await fetchWithTimeout(url);
            return ((data && data.results) || []).map(fromItunes);
        }
    },
    deezer: {
        async byArtist(artist) {
            const url = `https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${artist}"`)}&limit=25`;
            const data = await fetchWithTimeout(url);
            return ((data && data.data) || []).map(fromDeezer);
        },
        async general(text, limit = 5) {
            const url = `https://api.deezer.com/search?q=${encodeURIComponent(text)}&limit=${limit}`;
            const data = await fetchWithTimeout(url);
            return ((data && data.data) || []).map(fromDeezer);
        }
    },
    musicbrainz: {
        async byArtist(artist, title) {
            if (!title) return [];
            const query = `recording:"${mbEscape(cleanTitle(title))}" AND artist:"${mbEscape(artist)}"`;
            const data = await mbFetch(`https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=25`);
            return mbResults(data);
        },
        async general(text, limit = 5) {
            // Every word has to be in the title or the artist.
            const query = normalize(text).split(' ').filter(Boolean)
                .map(w => `(recording:${mbEscape(w)} OR artist:${mbEscape(w)})`).join(' AND ');
            if (!query) return [];
            const data = await mbFetch(`https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=${Math.max(limit, 15)}`);
            return mbResults(data);
        },
        // Artist search and general search are the same query here, so
        // only run it once per interpretation.
        single: true
    }
};

function leadArtist(artist) {
    const first = artist.split(/\s*(?:\/|;|,|&|\+|\bfeat\.?|\bft\.?|\bfeaturing\b|\bvs\.?)\s*/i)[0].trim();
    return first || artist;
}

async function tryInterpretation(provider, rawArtist, title, strictness, opts = {}) {
    const artist = leadArtist(rawArtist);

    if (artist) {
        try {
            const artistResults = await provider.byArtist(artist, title, opts);
            const found = await firstWithArtwork(rankMatches(artistResults, artist, title, strictness));
            if (found) return found;
        } catch (err) {
        }
        if (provider.single) return null;
    }

    try {
        const generalResults = await provider.general(`${artist} ${title}`.trim(), 5, opts);
        const found = await firstWithArtwork(rankMatches(generalResults, artist, title, strictness));
        if (found) return found;
    } catch (err) {
    }

    return null;
}

// Per source: the RT as sent, then its Greeklish reading (when it looks
// Greek), then title and artist swapped.
async function songLookup(providerNames, artist, title, strictness, fixedOrder) {
    const lead = leadArtist(artist);
    const gArtist = greeklishOf(lead);
    const gTitle = greeklishOf(title);
    const greek = (gArtist && gArtist !== normalize(lead)) || (gTitle && gTitle !== normalize(title))
        ? { artist: gArtist || lead, title: gTitle || title }
        : null;

    for (const name of providerNames) {
        const provider = providers[name];
        let best = await tryInterpretation(provider, artist, title, strictness);
        if (best) return { best, artist, title };
        if (greek) {
            best = await tryInterpretation(provider, greek.artist, greek.title, strictness, { greek: true });
            if (best) return { best, artist: greek.artist, title: greek.title };
        }
        if (!fixedOrder) {
            best = await tryInterpretation(provider, title, artist, strictness);
            if (best) return { best, artist: title, title: artist };
        }
    }
    return { best: null, artist, title };
}

async function freeTextOnProvider(provider, q, wordLists, strictness, opts = {}) {
    let results;
    try {
        results = await provider.general(q, 15, opts);
    } catch (err) {
        return null;
    }

    // Every PS word must turn up in the candidate (loose: all but one of
    // four or more words), and fewer extra words wins.
    const ranked = [];
    for (const track of results) {
        const candWords = skeleton(`${track.artistName} ${track.trackName}`).split(' ').filter(Boolean);
        let bestCost = null;
        for (const words of wordLists) {
            const allowedMissing = strictness === 'loose' && words.length >= 4 ? 1 : 0;
            const missing = words.filter(w => !candWords.some(c => wordsMatch(w, c))).length;
            if (missing > allowedMissing) continue;
            const extra = candWords.filter(c => !words.some(w => wordsMatch(w, c))).length;
            // MusicBrainz is full of covers and karaoke versions, so only take
            // an exact word match from it.
            if (provider.single && (extra > 0 || missing > 0)) continue;
            const cost = extra + missing * 10;
            if (bestCost === null || cost < bestCost) bestCost = cost;
        }
        if (bestCost !== null) ranked.push({ track, cost: bestCost });
    }
    ranked.sort((a, b) => a.cost - b.cost);
    return firstWithArtwork(ranked.map(r => r.track));
}

async function freeTextLookup(q, providerNames, strictness) {
    const greek = greeklishOf(q);
    const useGreek = greek && greek !== normalize(q);
    const wordLists = [skeleton(q)].concat(useGreek ? [skeleton(greek)] : [])
        .map(v => v.split(' ').filter(Boolean));
    if (wordLists[0].length < 2) return null;
    for (const name of providerNames) {
        let found = await freeTextOnProvider(providers[name], q, wordLists, strictness);
        if (!found && useGreek) found = await freeTextOnProvider(providers[name], greek, wordLists, strictness, { greek: true });
        if (found) return found;
    }
    return null;
}

function buildResult(best, fallbackArtist, fallbackTitle) {
    if (!best || !best.artwork) return { found: false };
    return {
        found: true,
        artwork: best.artwork,
        artworkBig: best.artworkBig || best.artwork,
        trackName: best.trackName || fallbackTitle,
        artistName: best.artistName || fallbackArtist,
        collectionName: best.collectionName || '',
        year: best.year || '',
        storeUrl: best.storeUrl || '',
        source: best.source || ''
    };
}

function requestedProviders(req) {
    const asked = (req.query.providers || '').toString().split(',').filter(Boolean);
    const list = asked.length ? asked : PROVIDER_ORDER;
    return PROVIDER_ORDER.filter(name => list.includes(name) && serverConfig.providers[name]);
}

router.get('/radiotext-coverart/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        version: VERSION,
        providers: serverConfig.providers,
        defaultImage: serverConfig.defaultImage,
        defaults: serverConfig.defaults,
        isAdmin: !!(req.session && req.session.isAdminAuthenticated)
    });
});

router.post('/radiotext-coverart/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.session || !req.session.isAdminAuthenticated) {
        return res.status(403).json({ ok: false, error: 'Admin login required' });
    }
    const body = req.body || {};
    serverConfig = sanitizeConfig({
        providers: body.providers || serverConfig.providers,
        defaultImage: serverConfig.defaultImage,
        defaults: Object.assign({}, serverConfig.defaults, body.defaults || {})
    });
    saveConfig();
    res.json({ ok: true, providers: serverConfig.providers, defaults: serverConfig.defaults });
});

router.get('/radiotext-coverart/get', async (req, res) => {
    const providerNames = requestedProviders(req);
    const strictness = SCHEMA.strictness.values.includes(req.query.strict) ? req.query.strict : 'normal';
    const fixedOrder = req.query.order === 'fixed';
    const allowNegative = req.query.retry !== '1';
    const variant = `${providerNames.join(',')}|${strictness}|${fixedOrder ? 'f' : 'a'}`;

    if (!providerNames.length) return res.json({ found: false });

    const q = (req.query.q || '').toString().trim().slice(0, 120);

    if (q) {
        if (isJunkText(q, true)) return res.json({ found: false });
        const qKey = `q|||${normalize(q).split(' ').sort().join(' ')}|||${variant}`;
        const qResult = await cachedLookup(qKey, allowNegative, async () =>
            buildResult(await freeTextLookup(q, providerNames, strictness), '', q));
        return res.json(qResult);
    }

    const artist = stripPhonePrefix((req.query.artist || '').toString()).slice(0, 100);
    const title = (req.query.title || '').toString().trim().slice(0, 100);

    if (!title || isJunkPair(artist, title)) {
        return res.json({ found: false });
    }

    const cacheKey = `${artist.toLowerCase()}|||${title.toLowerCase()}|||${variant}`;
    const result = await cachedLookup(cacheKey, allowNegative, async () => {
        const hit = await songLookup(providerNames, artist, title, strictness, fixedOrder);
        return buildResult(hit.best, hit.artist, hit.title);
    });
    res.json(result);
});

module.exports = {};
