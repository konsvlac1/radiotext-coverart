/* global $ */
// RadioText Cover Art — front-end (v2.2)

(function () {

    const VERSION = '2.2';

    // ---------------------------------------------------------------
    // Fixed settings (not offered in the ♫ panel)
    // ---------------------------------------------------------------
    const CONFIG = {
        // Empty space (px) kept below the AF list, inside the AF card, so
        // the last visible frequency isn't cut off by the card's rounded
        // bottom corners ("Below AF list" placement only).
        afBottomGap: 16,

        // Seconds to wait before asking again when no artwork was found
        // ("Retry if no artwork"). One retry per entry.
        retryDelays: [30, 90]
    };

    // Settings offered in the ♫ panel. Server defaults come from
    // plugins_configs/radiotext-coverart.json (via /radiotext-coverart/config);
    // whatever a visitor changes is stored in their browser on top of those.
    // Keep in step with SCHEMA in radiotext-coverart_server.js.
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
    const PROVIDERS = ['itunes', 'deezer', 'musicbrainz'];

    // ---------------------------------------------------------------
    const DEFAULT_IMAGE_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
        "<rect width='100' height='100' rx='14' fill='#2b2b2e'/>" +
        "<circle cx='50' cy='50' r='34' fill='none' stroke='#55555a' stroke-width='2'/>" +
        "<circle cx='50' cy='50' r='26' fill='none' stroke='#45454a' stroke-width='1.5'/>" +
        "<circle cx='50' cy='50' r='9' fill='#55555a'/>" +
        "<circle cx='50' cy='50' r='3' fill='#2b2b2e'/>" +
        "</svg>";
    const DEFAULT_IMAGE_URL = 'data:image/svg+xml,' + encodeURIComponent(DEFAULT_IMAGE_SVG);
    const WAITING_TOOLTIP = 'Waiting for song info…';

    const SETTINGS_KEY = 'rtCoverart.settings.v2';
    const PROFILES_KEY = 'rtCoverart.stations.v2';
    const HISTORY_KEY = 'rtCoverart.history';
    const CACHE_KEY = 'rtCoverart.cache.v2';
    const HISTORY_MAX = 10;
    const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const CACHE_MAX = 250;
    // A song that wasn't found isn't asked about again for this long
    // (the "Retry if no artwork" retries still run).
    const MISS_TTL_MS = 10 * 60 * 1000;

    const channels = {
        rt0: { lastText: null, timer: null },
        rt1: { lastText: null, timer: null }
    };

    let requestCounter = 0;
    let latestRequestId = 0;
    let currentSongKey = null;
    let currentSongChannel = null;
    let lastFreq = null;
    let lastPi = null;
    const localCache = {};
    const missUntil = {};
    const retryTimers = [];

    let serverDefaults = {};
    let serverProviders = { itunes: true, deezer: true, musicbrainz: true };
    let serverDefaultImage = null;
    let isAdmin = false;
    let personal = {};
    let settings = {};
    let profiles = {};
    let history = [];
    let persistent = {};
    let currentResult = null;

    function log() {
        if (!settings.debug) return;
        const args = Array.prototype.slice.call(arguments);
        args.unshift('[RT Cover Art]');
        console.log.apply(console, args);
    }

    // ---------------------------------------------------------------
    // Settings
    // ---------------------------------------------------------------
    function sanitizeValue(spec, v) {
        if (spec.type === 'bool') return typeof v === 'boolean' ? v : undefined;
        if (spec.type === 'enum') return spec.values.indexOf(v) >= 0 ? v : undefined;
        if (spec.type === 'int') {
            const n = Math.round(Number(v));
            if (!isFinite(n)) return undefined;
            return Math.min(spec.max, Math.max(spec.min, n));
        }
        return undefined;
    }

    function computeSettings() {
        const out = {};
        Object.keys(SCHEMA).forEach(function (key) {
            const spec = SCHEMA[key];
            let v = sanitizeValue(spec, personal[key]);
            if (v === undefined) v = sanitizeValue(spec, serverDefaults[key]);
            if (v === undefined) v = spec.def;
            out[key] = v;
        });
        PROVIDERS.forEach(function (name) {
            if (!serverProviders[name]) out[name] = false;
        });
        settings = out;
    }

    function serverValue(key) {
        const v = sanitizeValue(SCHEMA[key], serverDefaults[key]);
        return v === undefined ? SCHEMA[key].def : v;
    }

    function setSetting(key, value) {
        const v = sanitizeValue(SCHEMA[key], value);
        if (v === undefined) return;
        if (v === serverValue(key)) delete personal[key];
        else personal[key] = v;
        savePersonal();
        computeSettings();
    }

    function readJson(key, fallback) {
        try {
            const v = JSON.parse(localStorage.getItem(key) || 'null');
            return v === null ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    function writeJson(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {  }
    }

    function loadStorage() {
        const p = readJson(SETTINGS_KEY, null);
        if (p && typeof p === 'object') {
            personal = p;
        } else {
            // Carry over the two settings 1.3.x stored.
            const old = readJson('rtCoverart.settings', null);
            personal = {};
            if (old && typeof old.enabled === 'boolean') personal.enabled = old.enabled;
            if (old && ['both', 'rt', 'ps'].indexOf(old.source) >= 0) personal.songSource = old.source;
        }
        const pr = readJson(PROFILES_KEY, {});
        profiles = pr && typeof pr === 'object' ? pr : {};
        const h = readJson(HISTORY_KEY, []);
        history = Array.isArray(h) ? h.slice(0, HISTORY_MAX) : [];
        const c = readJson(CACHE_KEY, {});
        persistent = c && typeof c === 'object' ? c : {};
    }

    function savePersonal() { writeJson(SETTINGS_KEY, personal); }
    function saveProfiles() { writeJson(PROFILES_KEY, profiles); }
    function saveHistory() { writeJson(HISTORY_KEY, history); }

    // Per-station settings are keyed by PI code when one is known, else by
    // frequency.
    function stationKey() {
        if (lastPi && lastPi !== '?' && !/\?/.test(lastPi)) return 'pi:' + String(lastPi).toUpperCase();
        if (lastFreq !== null && lastFreq !== undefined && lastFreq !== '') return 'f:' + lastFreq;
        return null;
    }

    function stationProfile() {
        const key = stationKey();
        const p = key && profiles[key];
        return {
            rtOrder: p && ['artist-title', 'title-artist'].indexOf(p.rtOrder) >= 0 ? p.rtOrder : 'auto',
            psMode: p && ['off', 'on'].indexOf(p.psMode) >= 0 ? p.psMode : 'default'
        };
    }

    function setStationProfile(field, value) {
        const key = stationKey();
        if (!key) return;
        const p = Object.assign({}, profiles[key] || {});
        p[field] = value;
        if ((p.rtOrder || 'auto') === 'auto' && (p.psMode || 'default') === 'default') delete profiles[key];
        else profiles[key] = p;
        saveProfiles();
    }

    function usePs() {
        const mode = stationProfile().psMode;
        if (mode === 'off') return false;
        if (mode === 'on') return true;
        return settings.songSource !== 'rt';
    }

    function useRt() {
        return settings.songSource !== 'ps';
    }

    // ---------------------------------------------------------------
    // Artwork cache kept in the browser (found results only)
    // ---------------------------------------------------------------
    function persistentGet(key) {
        if (!settings.persistentCache) return null;
        const e = persistent[key];
        if (!e) return null;
        if (Date.now() - e.ts > CACHE_TTL_MS) {
            delete persistent[key];
            return null;
        }
        return e.r;
    }

    function persistentSet(key, result) {
        if (!settings.persistentCache || !result || !result.found) return;
        persistent[key] = { r: result, ts: Date.now() };
        const keys = Object.keys(persistent);
        if (keys.length > CACHE_MAX) {
            keys.sort(function (a, b) { return persistent[a].ts - persistent[b].ts; });
            keys.slice(0, keys.length - CACHE_MAX).forEach(function (k) { delete persistent[k]; });
        }
        writeJson(CACHE_KEY, persistent);
    }

    function clearPersistentCache() {
        persistent = {};
        try { localStorage.removeItem(CACHE_KEY); } catch (e) {  }
    }

    // ---------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------
    function injectStyles() {
        $('<style id="rt-coverart-styles">')
            .prop('type', 'text/css')
            .html(`
                .rt-coverart-box {
                    border-radius: 15px;
                    display: flex;
                    overflow: hidden;
                    flex-shrink: 0;
                    transition: 0.3s ease background-color;
                    isolation: isolate;
                }
                .rt-coverart-box img {
                    display: block;
                    object-fit: cover;
                    border-radius: 8px;
                    flex-shrink: 0;
                    cursor: pointer;
                }
                .rt-coverart-backdrop {
                    position: absolute;
                    inset: -20px;
                    z-index: -1;
                    background-size: cover;
                    background-position: center;
                    opacity: 0.55;
                    pointer-events: none;
                }
                .rt-ca-no-hover .rt-coverart-caption { display: none !important; }

                /* Cover behind a whole panel (RadioText background, or the
                   panel holding the cover with "Cover backdrop") */
                .rt-ca-bg-host { position: relative; isolation: isolate; }
                .rt-ca-panel-bg {
                    position: absolute;
                    inset: 0;
                    z-index: -1;
                    overflow: hidden;
                    border-radius: inherit;
                    pointer-events: none;
                }
                .rt-ca-panel-bg > div {
                    position: absolute;
                    inset: -30px;
                    background-size: cover;
                    background-position: center;
                    opacity: 0.45;
                    transition: opacity 0.4s ease;
                }
                .rt-ca-panel-bg.rt-ca-sharp > div { inset: 0; opacity: 0.3; }
                .rt-ca-panel-bg.rt-ca-empty > div { opacity: 0; }

                .rt-coverart-caption {
                    position: absolute;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    text-align: center;
                    background-color: rgba(0, 0, 0, 0.72);
                    color: #fff;
                    border-radius: 8px;
                    padding: 6px;
                    font-size: 11px;
                    line-height: 1.3;
                    overflow: hidden;
                    opacity: 0;
                    pointer-events: none;
                    transition: 0.2s ease opacity;
                }
                .rt-coverart-box:hover .rt-coverart-caption { opacity: 1; }

                .rt-coverart-menu-btn {
                    background: rgba(0, 0, 0, 0.5);
                    color: #fff;
                    border: 0;
                    border-radius: 50%;
                    width: 24px;
                    height: 24px;
                    min-width: 24px;
                    padding: 0;
                    font-size: 13px;
                    line-height: 24px;
                    cursor: pointer;
                    z-index: 2;
                    flex-shrink: 0;
                    position: absolute;
                    top: 4px;
                    right: 4px;
                    opacity: 0;
                    transition: 0.2s ease opacity;
                }
                .rt-coverart-box:hover .rt-coverart-menu-btn { opacity: 1; }
                .rt-coverart-menu-btn:hover { background: rgba(0, 0, 0, 0.8); }
                @media (hover: none) {
                    .rt-coverart-menu-btn { opacity: 0.8; }
                }

                /* Below AF list (desktop) + panel after RadioText (phone) */
                #rt-coverart-container-phone { display: none; }
                @media only screen and (max-width: 768px) {
                    #rt-coverart-container-phone {
                        display: flex;
                        width: 90%;
                        margin: 0 auto 20px auto;
                        min-height: 70px;
                        background-color: var(--color-1-transparent);
                        backdrop-filter: blur(5px);
                        padding: 8px;
                        box-sizing: border-box;
                        position: relative;
                        flex-direction: row;
                        align-items: center;
                        justify-content: flex-start;
                        order: 10;
                    }
                    #rt-coverart-container-phone img { width: 62px; height: 62px; min-width: 62px; }
                    #rt-coverart-container-phone .rt-coverart-menu-btn {
                        position: static;
                        margin-left: auto;
                        opacity: 1;
                    }
                    #rt-coverart-container-phone .rt-coverart-caption {
                        position: static;
                        flex: 1;
                        display: -webkit-box;
                        -webkit-box-orient: vertical;
                        -webkit-line-clamp: 3;
                        background: none;
                        color: inherit;
                        padding: 0;
                        opacity: 0.85;
                        margin-left: 12px;
                        text-align: left;
                        font-size: 13px;
                        line-height: 1.35;
                    }
                    .rt-ca-no-hover #rt-coverart-container-phone .rt-coverart-caption { display: -webkit-box !important; }
                    .rt-ca-mode-af #rt-container {
                        background-color: var(--color-1-transparent) !important;
                        backdrop-filter: blur(5px) !important;
                    }
                }
                #rt-coverart-container-desktop { display: none; }
                @media only screen and (min-width: 769px) {
                    #rt-coverart-container-desktop {
                        display: flex;
                        margin: 20px auto 0 auto;
                        position: relative;
                        background-color: var(--color-1-transparent);
                        backdrop-filter: blur(5px);
                        padding: 8px;
                        box-sizing: border-box;
                    }
                    #rt-coverart-container-desktop:hover { background-color: var(--color-2-transparent); }
                    #rt-coverart-container-desktop img { width: 100%; height: 100%; }
                    #rt-coverart-container-desktop .rt-coverart-caption { inset: 8px; }
                    #rt-coverart-container-desktop .rt-coverart-menu-btn { top: 12px; right: 12px; }
                }

                /* Phones: RadioText moved up under the station name (placePhoneRt) */
                @media only screen and (max-width: 768px) {
                    .rt-ca-rt-top #rt-container {
                        margin: 12px auto 0 auto !important;
                        padding: 6px 12px;
                        box-sizing: border-box;
                        min-height: 0;
                        background-color: var(--color-1-transparent);
                        backdrop-filter: blur(5px);
                    }
                    .rt-ca-rt-top #rt-container.rt-ca-rt-empty { display: none !important; }
                    .rt-ca-rt-top #rt-container h2 { display: none; }
                    .rt-ca-rt-top #data-rt0, .rt-ca-rt-top #data-rt1 {
                        font-size: 14px;
                        line-height: 1.35;
                        white-space: normal;
                        overflow-wrap: anywhere;
                        overflow: visible;
                        text-align: center;
                        padding: 2px 0;
                    }
                }

                /* Inside the RadioText or PS panel */
                .rt-ca-host { position: relative; box-sizing: border-box; }
                #rt-coverart-inline {
                    position: absolute;
                    top: 50%;
                    transform: translateY(-50%);
                    z-index: 1;
                    border-radius: 10px;
                }
                #rt-coverart-inline img { width: 100%; height: 100%; }
                #rt-coverart-inline .rt-coverart-caption { inset: 0; }

                /* Floating in a corner of the window */
                #rt-coverart-float {
                    position: fixed;
                    bottom: 16px;
                    z-index: 900;
                    padding: 6px;
                    box-sizing: border-box;
                    background-color: var(--color-1-transparent);
                    backdrop-filter: blur(5px);
                    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
                }
                #rt-coverart-float img { width: 100%; height: 100%; }
                #rt-coverart-float .rt-coverart-caption { inset: 6px; }

                /* Info card */
                #rt-coverart-modal, #rt-coverart-panel {
                    display: none;
                    position: fixed;
                    inset: 0;
                    background-color: rgba(0, 0, 0, 0.85);
                    z-index: 10000;
                    align-items: center;
                    justify-content: center;
                    padding: 16px;
                    box-sizing: border-box;
                }
                #rt-coverart-modal { cursor: pointer; }
                .rt-coverart-modal-visible { display: flex !important; }
                #rt-coverart-modal img {
                    max-width: 100%;
                    max-height: 55vh;
                    border-radius: 12px;
                    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
                    cursor: default;
                }
                .rt-ca-card {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 12px;
                    max-width: min(90vw, 460px);
                    color: #fff;
                    text-align: center;
                    cursor: default;
                }
                .rt-ca-title { font-size: 20px; font-weight: 600; line-height: 1.25; }
                .rt-ca-artist { font-size: 16px; opacity: 0.9; }
                .rt-ca-album { font-size: 13px; opacity: 0.65; }
                .rt-ca-links { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 4px; }
                .rt-ca-links a, .rt-ca-btn {
                    background: rgba(255, 255, 255, 0.14);
                    color: #fff;
                    text-decoration: none;
                    border: 0;
                    border-radius: 999px;
                    padding: 7px 14px;
                    font-size: 13px;
                    cursor: pointer;
                }
                /* The page styles every button { width: 100%; height: 100% } */
                #rt-coverart-panel button, #rt-coverart-modal button {
                    width: auto; height: auto; min-width: 0; margin: 0; flex: none; line-height: normal; font-family: inherit;
                }
                .rt-ca-links a:hover, .rt-ca-btn:hover { background: rgba(255, 255, 255, 0.28); }
                .rt-ca-btn:disabled { opacity: 0.5; cursor: default; }

                /* Settings panel: fixed header and footer, the middle scrolls */
                .rt-ca-panel-card {
                    background: #1f1f23;
                    color: #fff;
                    border-radius: 16px;
                    width: min(94vw, 860px);
                    max-height: calc(100vh - 32px);
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    box-sizing: border-box;
                    text-align: left;
                    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
                }
                .rt-ca-panel-head { flex: none; display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px 6px 16px; }
                .rt-ca-panel-head > div { flex: 1; min-width: 0; }
                .rt-ca-panel-head h3 { margin: 0; font-size: 16px; color: #fff; }
                .rt-ca-panel-body {
                    flex: 1 1 auto;
                    min-height: 0;
                    overflow-y: auto;
                    overscroll-behavior: contain;
                    -webkit-overflow-scrolling: touch;
                    padding: 0 16px 8px 16px;
                }
                .rt-ca-panel-foot {
                    flex: none;
                    padding: 10px 16px 12px 16px;
                    border-top: 1px solid rgba(255, 255, 255, 0.1);
                }
                .rt-ca-cols { display: grid; grid-template-columns: 1fr 1fr; column-gap: 32px; }
                @media (max-width: 720px) {
                    .rt-ca-cols { grid-template-columns: 1fr; }
                }
                .rt-ca-sub { font-size: 12px; opacity: 0.6; margin: 2px 0 0 0; }
                #rt-coverart-panel .rt-ca-x { background: none; border: 0; border-radius: 0; color: #fff; font-size: 24px; line-height: 1; cursor: pointer; padding: 0 4px; opacity: 0.7; }
                #rt-coverart-panel .rt-ca-x:hover { opacity: 1; background: none; }
                .rt-ca-section {
                    display: flex; align-items: center; justify-content: space-between;
                    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
                    color: #fff; opacity: 0.55; margin: 12px 0 2px 0;
                }
                .rt-ca-row {
                    display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 6px 0;
                    font-size: 14px; font-weight: normal; text-transform: none; letter-spacing: normal; color: #fff; cursor: default;
                }
                .rt-ca-row > span { flex: 1; min-width: 0; }
                .rt-ca-row.rt-ca-changed > span::after { content: ' •'; color: #7fb3ff; }
                .rt-ca-row select, .rt-ca-row input[type=number] {
                    background: #2f2f35; color: #fff; border: 0; border-radius: 8px;
                    padding: 6px 8px; font-size: 14px; max-width: 58%; height: auto; margin: 0;
                }
                .rt-ca-row input[type=number] { width: 84px; }
                .rt-ca-row input[type=checkbox] { width: 18px; height: 18px; margin: 0; }
                .rt-ca-row.rt-ca-disabled { opacity: 0.45; }
                .rt-ca-hist-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 2px 12px; }
                .rt-ca-hist-item { display: flex; align-items: center; gap: 10px; padding: 6px; border-radius: 10px; cursor: pointer; min-width: 0; }
                .rt-ca-hist-item:hover { background: rgba(255, 255, 255, 0.08); }
                .rt-ca-hist-item img { width: 44px; height: 44px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
                .rt-ca-hist-text { min-width: 0; flex: 1; text-align: left; }
                .rt-ca-hist-text div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .rt-ca-hist-sub { font-size: 12px; opacity: 0.6; }
                .rt-ca-empty { opacity: 0.55; font-size: 13px; padding: 6px 0; }
                .rt-ca-status { font-size: 12px; opacity: 0.75; text-align: center; margin-top: 6px; min-height: 1em; color: #fff; }
                .rt-ca-section .rt-ca-btn { font-size: 11px; padding: 3px 10px; text-transform: none; letter-spacing: normal; }
            `)
            .appendTo('head');
    }

    // ---------------------------------------------------------------
    // Placement
    // ---------------------------------------------------------------
    function defaultImageUrl() {
        return serverDefaultImage || DEFAULT_IMAGE_URL;
    }

    function boxHtml(id) {
        const src = currentResult ? currentResult.artwork : defaultImageUrl();
        const caption = currentResult ? currentResult.artist + ' — ' + currentResult.title : WAITING_TOOLTIP;
        const $box = $('<div class="rt-coverart-box"></div>').attr('id', id)
            .append('<div class="rt-coverart-backdrop"></div>')
            .append($('<img alt="Cover art">').attr('src', src))
            .append($('<div class="rt-coverart-caption"></div>').text(caption))
            .append('<button type="button" class="rt-coverart-menu-btn" title="Cover art settings &amp; history">&#9835;</button>');
        return $box;
    }

    function hostPanel() {
        if (settings.placement === 'rt') return $('#rt-container');
        if (settings.placement === 'ps') return $('#ps-container');
        return $();
    }

    function removePlacement() {
        $('.rt-coverart-box').remove();
        $('.rt-ca-host').removeClass('rt-ca-host').css({ 'padding-left': '', 'padding-right': '' });
        resetDesktopStyles();
        $('body').removeClass('rt-ca-mode-af rt-ca-mode-rt rt-ca-mode-ps rt-ca-mode-float rt-ca-no-hover');
        placePhoneRt();
        fitPs();
    }

    // FM-DX puts RadioText on phones below the transmitter panel, where the
    // fixed player bar covers it. While narrow, move it up under the station
    // name; a hidden marker keeps its original spot for wider screens.
    let $rtMarker = $();
    function placePhoneRt() {
        const $rt = $('#rt-container');
        const $psRow = $('#ps-container').closest('.flex-container');
        if (!$rt.length || !$psRow.length) return;
        const phone = settings.enabled && window.innerWidth <= 768;
        if (phone && !$rtMarker.length) {
            $rtMarker = $('<span hidden></span>').insertBefore($rt);
            $psRow.after($rt);
            $('body').addClass('rt-ca-rt-top');
        } else if (!phone && $rtMarker.length) {
            $rtMarker.replaceWith($rt);
            $rtMarker = $();
            $('body').removeClass('rt-ca-rt-top');
            $rt.css('width', '');
        }
        if (phone) $rt.css('width', $('#ps-container').outerWidth() + 'px');
    }

    // Fit the station name beside the cover in the PS panel. Sized for the
    // full 8 characters, so the font doesn't jump while a scrolling PS changes.
    let fitCanvas = null;
    function fitPs() {
        const $ps = $('#data-ps');
        const $host = $('#ps-container');
        if (!$ps.length) return;
        $ps.css({ 'font-size': '', 'white-space': '' });
        if (!settings.enabled || settings.placement !== 'ps' || !$host.hasClass('rt-ca-host')) return;
        const cs = getComputedStyle($ps[0]);
        const hs = getComputedStyle($host[0]);
        fitCanvas = fitCanvas || document.createElement('canvas');
        const ctx = fitCanvas.getContext('2d');
        ctx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        const need = ctx.measureText('MMMMMMMM').width + 8 * (parseFloat(cs.letterSpacing) || 0);
        const avail = $host[0].clientWidth - parseFloat(hs.paddingLeft) - parseFloat(hs.paddingRight) - 8;
        const css = { 'white-space': 'nowrap' };
        if (need > avail && avail > 0) css['font-size'] = Math.floor(parseFloat(cs.fontSize) * avail / need) + 'px';
        $ps.css(css);
    }

    // Returns false while the page's panels aren't in the DOM yet.
    function createPlacement() {
        removePlacement();
        if (!settings.enabled) {
            applyLook();
            return true;
        }

        const mode = settings.placement;
        $('body').addClass('rt-ca-mode-' + mode).toggleClass('rt-ca-no-hover', !settings.captionHover);

        if (mode === 'af') {
            const $rtContainer = $('#rt-container');
            const $afList = $('#af-list');
            const $afWrapper = $afList.length ? $afList.closest('.panel-100') : $();
            const $afColumn = $afWrapper.length ? $afWrapper.parent() : $();
            if (!$rtContainer.length || !$afWrapper.length || !$afColumn.length) return false;
            $rtContainer.after(boxHtml('rt-coverart-container-phone'));
            $afColumn.css('flex-direction', 'column');
            $afWrapper.css('overflow', 'hidden');
            $afWrapper.after(boxHtml('rt-coverart-container-desktop'));
        } else if (mode === 'rt' || mode === 'ps') {
            const $host = hostPanel();
            if (!$host.length) return false;
            $host.addClass('rt-ca-host').append(boxHtml('rt-coverart-inline'));
        } else {
            $('body').append(boxHtml('rt-coverart-float'));
        }

        applyLook();
        layout();
        return true;
    }

    function panelBackground($host, sharp, cssUrl) {
        let $bg = $host.children('.rt-ca-panel-bg');
        if (!$bg.length) {
            $bg = $('<div class="rt-ca-panel-bg"><div></div></div>');
            $host.addClass('rt-ca-bg-host').prepend($bg);
        }
        $bg.toggleClass('rt-ca-sharp', sharp).toggleClass('rt-ca-empty', cssUrl === 'none');
        $bg.children().css({
            'background-image': cssUrl,
            'filter': sharp ? 'none' : 'blur(' + settings.blur + 'px)'
        });
    }

    // Cover behind the cover box ("Cover backdrop") and behind the whole
    // RadioText panel ("RadioText background").
    function applyLook() {
        const url = currentResult ? currentResult.artwork : '';
        const cssUrl = url ? 'url("' + url.replace(/"/g, '%22') + '")' : 'none';
        const on = settings.enabled;

        const boxBackdrop = on && settings.backdrop === 'blur' && (settings.placement === 'af' || settings.placement === 'float');
        $('.rt-coverart-box > .rt-coverart-backdrop').toggle(boxBackdrop).css({
            'background-image': boxBackdrop ? cssUrl : 'none',
            'filter': 'blur(' + settings.blur + 'px)'
        });

        const hosts = [];
        if (on && settings.rtBackground !== 'off') {
            hosts.push({ el: $('#rt-container')[0], sharp: settings.rtBackground === 'sharp' });
        }
        if (on && settings.backdrop === 'blur' && (settings.placement === 'ps' || (settings.placement === 'rt' && settings.rtBackground === 'off'))) {
            hosts.push({ el: hostPanel()[0], sharp: false });
        }
        $('.rt-ca-bg-host').each(function () {
            const el = this;
            if (!hosts.some(function (h) { return h.el === el; })) {
                $(el).removeClass('rt-ca-bg-host').children('.rt-ca-panel-bg').remove();
            }
        });
        hosts.forEach(function (h) {
            if (h.el) panelBackground($(h.el), h.sharp, cssUrl);
        });
    }

    function layout() {
        const mode = settings.placement;
        placePhoneRt();
        if (mode === 'af') {
            matchDesktopHeights();
        } else if (mode === 'rt' || mode === 'ps') {
            layoutInline();
        } else if (mode === 'float') {
            const size = Math.min(settings.size, Math.round(window.innerWidth * 0.45));
            const css = { width: size + 'px', height: size + 'px', left: '', right: '', bottom: settings.gap + 16 + 'px' };
            css[settings.side] = settings.gap + 'px';
            $('#rt-coverart-float').css(css);
        }
    }

    function layoutInline() {
        const $host = hostPanel();
        const $box = $('#rt-coverart-inline');
        if (!$host.length || !$box.length) return;
        const gap = settings.gap;
        const hostHeight = $host.innerHeight() || 0;
        const size = Math.max(40, Math.min(settings.size, hostHeight - 2 * gap));
        const css = { width: size + 'px', height: size + 'px', left: '', right: '' };
        css[settings.side] = gap + 'px';
        $box.css(css);
        const pad = (size + 2 * gap) + 'px';
        $host.css({
            'padding-left': settings.side === 'left' ? pad : '',
            'padding-right': settings.side === 'right' ? pad : ''
        });
        fitPs();
    }

    function resetDesktopStyles() {
        const $afWrapper = $('#af-list').closest('.panel-100');
        const $afColumn = $afWrapper.length ? $afWrapper.parent() : $();
        $('#rt-coverart-container-desktop').css({ width: '', height: '' });
        $afWrapper.css({ height: '', overflow: '' });
        $('#af-list').css({ 'max-height': '', 'margin-bottom': '' });
        $afColumn.css('flex-direction', '');
    }

    function matchDesktopHeights() {
        if (settings.placement !== 'af') return;
        if (window.innerWidth <= 768) {
            resetDesktopStyles();
            return;
        }

        const $desktopBox = $('#rt-coverart-container-desktop');
        const $afWrapper = $('#af-list').closest('.panel-100');
        const $afColumn = $afWrapper.length ? $afWrapper.parent() : $();
        const $txInfo = $('#data-station-container').length ? $('#data-station-container').parent() : $();

        if (!$desktopBox.length || !$afWrapper.length || !$afColumn.length || !$txInfo.length) return;

        $afWrapper.css('overflow', 'hidden');
        $afColumn.css('flex-direction', 'column');

        const txHeight = $txInfo.outerHeight();
        if (!txHeight) return;

        const coverSize = Math.max(txHeight, settings.size);
        $desktopBox.css({ width: coverSize + 'px', height: coverSize + 'px', 'margin-top': settings.gap + 12 + 'px' });

        const afColumnTop = $afColumn.offset().top;
        const txInfoTop = $txInfo.offset().top;
        const afWrapperMarginTop = parseFloat($afWrapper.css('margin-top')) || 0;
        const coverMarginTop = parseFloat($desktopBox.css('margin-top')) || 0;

        const afHeight = (txInfoTop - afColumnTop) - afWrapperMarginTop - coverMarginTop;
        if (afHeight > 0) {
            $afWrapper.css('height', afHeight + 'px');

            const $afHeader = $afWrapper.children('h2').first();
            const headerHeight = $afHeader.length ? $afHeader.outerHeight(true) : 0;
            const listHeight = afHeight - headerHeight - CONFIG.afBottomGap;
            if (listHeight > 0) {
                $('#af-list').css({ 'max-height': listHeight + 'px', 'margin-bottom': CONFIG.afBottomGap + 'px' });
            }
        }
    }

    let lastLayoutCheck = 0;

    function maybeLayout() {
        const now = Date.now();
        if (now - lastLayoutCheck < 1000) return;
        lastLayoutCheck = now;
        layout();
    }

    // ---------------------------------------------------------------
    // History, info card, settings panel
    // ---------------------------------------------------------------
    function addHistory(result) {
        const entry = {
            artist: result.artistName || '',
            title: result.trackName || '',
            album: result.collectionName || '',
            year: result.year || '',
            artwork: result.artwork,
            artworkBig: result.artworkBig || result.artwork,
            storeUrl: result.storeUrl || '',
            source: result.source || '',
            freq: (lastFreq !== null && lastFreq !== undefined) ? lastFreq : '',
            ts: Date.now()
        };
        if (history.length && history[0].artist === entry.artist && history[0].title === entry.title) {
            history[0] = entry;
        } else {
            history.unshift(entry);
            if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
        }
        saveHistory();
        if ($('#rt-coverart-panel').hasClass('rt-coverart-modal-visible')) renderHistory();
    }

    function formatTime(ts) {
        const d = new Date(ts);
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }

    function createModal() {
        if ($('#rt-coverart-modal').length) return;
        $('body').append(
            '<div id="rt-coverart-modal"><div class="rt-ca-card">' +
                '<img id="rt-coverart-modal-img" src="" alt="Cover art">' +
                '<div class="rt-ca-title"></div>' +
                '<div class="rt-ca-artist"></div>' +
                '<div class="rt-ca-album"></div>' +
                '<div class="rt-ca-links"></div>' +
            '</div></div>' +
            '<div id="rt-coverart-panel"><div class="rt-ca-panel-card"></div></div>'
        );

        $('#rt-coverart-modal').on('click', function (e) {
            if (e.target === this) closeModal();
        });
        $('#rt-coverart-panel').on('click', function (e) {
            if (e.target === this) closePanel();
        });
        // The page tunes the radio on arrow keys, B and R (document.onkeydown).
        // While an overlay is open no key reaches it; typing and stepping
        // through lists and numbers are default actions and still work.
        ['keydown', 'keyup', 'keypress'].forEach(function (type) {
            window.addEventListener(type, function (e) {
                if (!$('#rt-coverart-modal, #rt-coverart-panel').hasClass('rt-coverart-modal-visible')) return;
                e.stopPropagation();
                if (type === 'keydown' && e.key === 'Escape') { closeModal(); closePanel(); }
            }, true);
        });
        $('#rt-coverart-modal, #rt-coverart-panel').on('wheel', function (e) {
            e.stopPropagation();
        });
        $(document).on('click', '.rt-coverart-box img', function () {
            if (currentResult) openModal(currentResult);
        });
        $(document).on('click', '.rt-coverart-menu-btn', function (e) {
            e.stopPropagation();
            openPanel();
        });
    }

    function linkEl(label, url) {
        return $('<a target="_blank" rel="noopener noreferrer"></a>').attr('href', url).text(label);
    }

    function openModal(info) {
        const big = info.artworkBig || info.artwork || '';
        $('#rt-coverart-modal-img').attr('src', big);
        $('#rt-coverart-modal .rt-ca-title').text(info.title || '');
        $('#rt-coverart-modal .rt-ca-artist').text(info.artist || '');
        const albumLine = [info.album, info.year].filter(Boolean).join(' · ');
        $('#rt-coverart-modal .rt-ca-album').text(albumLine);

        const q = encodeURIComponent(((info.artist || '') + ' ' + (info.title || '')).trim());
        const $links = $('#rt-coverart-modal .rt-ca-links').empty();
        $links.append(linkEl('YouTube', 'https://www.youtube.com/results?search_query=' + q));
        $links.append(linkEl('Spotify', 'https://open.spotify.com/search/' + q));
        if (info.storeUrl) $links.append(linkEl(info.source || 'Open', info.storeUrl));

        $('#rt-coverart-modal').addClass('rt-coverart-modal-visible');
    }

    function closeModal() {
        $('#rt-coverart-modal').removeClass('rt-coverart-modal-visible');
    }

    function openPanel() {
        renderPanel();
        $('#rt-coverart-panel').addClass('rt-coverart-modal-visible');
    }

    function closePanel() {
        $('#rt-coverart-panel').removeClass('rt-coverart-modal-visible');
    }

    // What has to happen after a setting changes.
    function afterChange(key) {
        if (key === 'enabled') {
            if (settings.enabled) {
                restartDetection();
                createPlacement();
            } else {
                clearToDefault(true);
                removePlacement();
                applyLook();
            }
        } else if (['placement', 'side', 'backdrop', 'captionHover'].indexOf(key) >= 0) {
            createPlacement();
        } else if (['size', 'gap'].indexOf(key) >= 0) {
            layout();
        } else if (key === 'blur' || key === 'rtBackground') {
            applyLook();
        } else if (['songSource', 'strictness'].concat(PROVIDERS).indexOf(key) >= 0) {
            restartDetection();
        } else if (key === 'persistentCache' && !settings.persistentCache) {
            clearPersistentCache();
        }
    }

    function rowFor(key, label, $input) {
        const changed = Object.prototype.hasOwnProperty.call(personal, key);
        $input.attr('data-key', key);
        return $('<label class="rt-ca-row"></label>')
            .append($('<span></span>').text(label))
            .append($input)
            .toggleClass('rt-ca-changed', changed)
            .attr('title', changed ? 'Changed by you (server default: ' + serverValue(key) + ')' : 'Server default');
    }

    function checkRow(key, label) {
        const $input = $('<input type="checkbox">').prop('checked', settings[key]).on('change', function () {
            setSetting(key, this.checked);
            afterChange(key);
            renderPanel();
        });
        const $row = rowFor(key, label, $input);
        if (PROVIDERS.indexOf(key) >= 0 && !serverProviders[key]) {
            $input.prop('disabled', true);
            $row.addClass('rt-ca-disabled').attr('title', 'Turned off on this server');
        }
        return $row;
    }

    function selectRow(key, label, options) {
        const $select = $('<select></select>');
        options.forEach(function (o) { $select.append($('<option></option>').val(o[0]).text(o[1])); });
        $select.val(settings[key]).on('change', function () {
            setSetting(key, this.value);
            afterChange(key);
            renderPanel();
        });
        return rowFor(key, label, $select);
    }

    function numberRow(key, label) {
        const spec = SCHEMA[key];
        const $input = $('<input type="number">')
            .attr({ min: spec.min, max: spec.max, step: key === 'stableDelay' ? 100 : 1 })
            .val(settings[key])
            .on('change', function () {
                setSetting(key, this.value);
                this.value = settings[key];
                afterChange(key);
                renderPanel();
            });
        return rowFor(key, label, $input);
    }

    function stationSelect(field, label, options) {
        const profile = stationProfile();
        const $select = $('<select></select>').attr('data-key', 'station-' + field);
        options.forEach(function (o) { $select.append($('<option></option>').val(o[0]).text(o[1])); });
        $select.val(profile[field]).on('change', function () {
            setStationProfile(field, this.value);
            restartDetection();
        });
        const $row = $('<label class="rt-ca-row"></label>').append($('<span></span>').text(label)).append($select);
        if (!stationKey()) $select.prop('disabled', true);
        return $row;
    }

    function stationLabel() {
        const parts = [];
        if (lastFreq) parts.push(lastFreq + ' MHz');
        if (lastPi && !/\?/.test(lastPi)) parts.push('PI ' + String(lastPi).toUpperCase());
        return parts.length ? parts.join(' · ') : 'no station';
    }

    function section(title) {
        return $('<div class="rt-ca-section"></div>').append($('<span></span>').text(title));
    }

    function renderPanel() {
        const $card = $('#rt-coverart-panel .rt-ca-panel-card');
        const scroll = $card.find('.rt-ca-panel-body').scrollTop() || 0;
        // Redrawing replaces the controls; keep the cursor in the one in use.
        const active = document.activeElement;
        const focusKey = active && $card[0] && $card[0].contains(active) ? $(active).attr('data-key') : null;
        $card.empty();

        $card.append(
            $('<div class="rt-ca-panel-head"></div>')
                .append($('<div></div>')
                    .append($('<h3></h3>').text('RadioText Cover Art v' + VERSION))
                    .append($('<div class="rt-ca-sub"></div>').text(isAdmin
                        ? 'Logged in as admin. Changes apply to this browser; “Save as server defaults” makes them the defaults for every listener. Changed ones are marked •'
                        : 'Changes apply to this browser only. To change them for every listener, log in as admin on this page and use “Save as server defaults”. Changed ones are marked •')))
                .append($('<button type="button" class="rt-ca-x" aria-label="Close">&times;</button>').on('click', closePanel))
        );

        const $left = $('<div></div>');
        const $right = $('<div></div>');

        $left.append(section('Cover'));
        $left.append(checkRow('enabled', 'Enable cover art'));
        $left.append(selectRow('placement', 'Cover placement', [
            ['af', 'Below AF list'], ['rt', 'Inside RadioText panel'], ['ps', 'Inside PS panel'], ['float', 'Floating corner']
        ]));
        if (settings.placement !== 'af') {
            $left.append(selectRow('side', settings.placement === 'float' ? 'Corner' : 'Side', [
                ['left', settings.placement === 'float' ? 'Bottom left' : 'Left'],
                ['right', settings.placement === 'float' ? 'Bottom right' : 'Right']
            ]));
        }
        $left.append(numberRow('size', settings.placement === 'af' ? 'Minimum size (px)' : 'Size (px)'));
        $left.append(numberRow('gap', 'Gap (px)'));

        $left.append(section('Look'));
        $left.append(selectRow('rtBackground', 'RadioText background', [
            ['blur', 'Blurred cover'], ['sharp', 'Cover'], ['off', 'Off']
        ]));
        $left.append(selectRow('backdrop', 'Cover backdrop', [['none', 'None'], ['blur', 'Blurred cover']]));
        if (settings.backdrop === 'blur' || settings.rtBackground === 'blur') $left.append(numberRow('blur', 'Blur amount (px)'));
        $left.append(checkRow('captionHover', 'Caption on hover'));
        $left.append(checkRow('retainLast', 'Keep last cover during jingles / news'));

        $left.append(section('Advanced'));
        $left.append(checkRow('persistentCache', 'Keep found covers for 7 days'));
        $left.append(checkRow('debug', 'Debug logging (browser console)'));

        $right.append(section('Detection'));
        $right.append(selectRow('songSource', 'Song information source', [
            ['both', 'RT + PS fallback'], ['rt', 'RadioText only'], ['ps', 'PS only']
        ]));
        $right.append(numberRow('stableDelay', 'RT delay (ms)'));
        $right.append(selectRow('strictness', 'Title detection strictness', [
            ['loose', 'Loose'], ['normal', 'Normal'], ['strict', 'Strict']
        ]));
        $right.append(checkRow('retry', 'Retry if no artwork'));

        $right.append(section('Artwork sources (tried in this order)'));
        $right.append(checkRow('itunes', 'iTunes / Apple Music'));
        $right.append(checkRow('deezer', 'Deezer'));
        $right.append(checkRow('musicbrainz', 'MusicBrainz / Cover Art Archive'));

        $right.append(section('This station (' + stationLabel() + ')'));
        $right.append(stationSelect('rtOrder', 'RT order', [
            ['auto', 'Auto (try both)'], ['artist-title', 'Artist - Title'], ['title-artist', 'Title - Artist']
        ]));
        $right.append(stationSelect('psMode', 'PS mode', [
            ['default', 'As above'], ['on', 'Always parse PS'], ['off', 'Never parse PS']
        ]));

        const $histSection = section('Recent songs').append(
            $('<button type="button" class="rt-ca-btn">Clear</button>').on('click', function () {
                history = [];
                saveHistory();
                renderHistory();
            })
        );

        const $body = $('<div class="rt-ca-panel-body"></div>')
            .append($('<div class="rt-ca-cols"></div>').append($left).append($right))
            .append($histSection)
            .append('<div class="rt-ca-history"></div>');
        $card.append($body);

        const $status = $('<div class="rt-ca-status"></div>');
        const $buttons = $('<div class="rt-ca-links"></div>');
        $buttons.append($('<button type="button" class="rt-ca-btn">Reset to server defaults</button>')
            .prop('disabled', !Object.keys(personal).length)
            .on('click', function () {
                personal = {};
                savePersonal();
                computeSettings();
                createPlacement();
                restartDetection();
                renderPanel();
            }));
        if (settings.persistentCache) {
            $buttons.append($('<button type="button" class="rt-ca-btn">Clear cover cache</button>').on('click', function () {
                clearPersistentCache();
                $status.text('Cover cache cleared.');
            }));
        }
        if (isAdmin) {
            $buttons.append($('<button type="button" class="rt-ca-btn" title="Saves the settings shown here as everyone’s defaults (station settings stay personal)">Save as server defaults</button>')
                .on('click', saveServerDefaults));
        }
        $card.append($('<div class="rt-ca-panel-foot"></div>').append($buttons).append($status));

        renderHistory();
        $body.scrollTop(scroll);
        if (focusKey) {
            const $focus = $card.find('[data-key="' + focusKey + '"]');
            if ($focus.length) $focus[0].focus();
        }
    }

    function renderHistory() {
        const $wrap = $('#rt-coverart-panel .rt-ca-history').empty();
        if (!$wrap.length) return;
        if (!history.length) {
            $wrap.append('<div class="rt-ca-empty">No songs detected yet.</div>');
            return;
        }
        const $list = $('<div class="rt-ca-hist-list"></div>');
        history.forEach(function (h) {
            const sub = formatTime(h.ts) + (h.freq !== '' ? ' · ' + h.freq + ' MHz' : '');
            $list.append($('<div class="rt-ca-hist-item"></div>')
                .append($('<img alt="">').attr('src', h.artwork))
                .append($('<div class="rt-ca-hist-text"></div>')
                    .append($('<div></div>').text(h.title))
                    .append($('<div class="rt-ca-hist-sub"></div>').text(h.artist))
                    .append($('<div class="rt-ca-hist-sub"></div>').text(sub)))
                .on('click', function () { closePanel(); openModal(h); }));
        });
        $wrap.append($list);
    }

    function saveServerDefaults() {
        const defaults = {};
        Object.keys(SCHEMA).forEach(function (k) { defaults[k] = settings[k]; });
        PROVIDERS.forEach(function (name) {
            if (!serverProviders[name]) delete defaults[name];
        });
        const $status = $('#rt-coverart-panel .rt-ca-status').text('Saving…');
        $.ajax({
            url: '/radiotext-coverart/config',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ defaults: defaults })
        }).done(function (res) {
            serverDefaults = res.defaults || serverDefaults;
            personal = {};
            savePersonal();
            computeSettings();
            renderPanel();
            $('#rt-coverart-panel .rt-ca-status').text('Saved as this server’s defaults.');
        }).fail(function (xhr) {
            $status.text(xhr.status === 403 ? 'Not logged in as admin.' : 'Saving failed.');
        });
    }

    // ---------------------------------------------------------------
    // Showing artwork
    // ---------------------------------------------------------------
    function showArt(url, tooltipText) {
        const text = tooltipText || WAITING_TOOLTIP;
        $('.rt-coverart-box img').attr('src', url);
        $('.rt-coverart-box .rt-coverart-caption').text(text);
        applyLook();
    }

    function clearRetries() {
        while (retryTimers.length) clearTimeout(retryTimers.pop());
    }

    // force: also on "Keep last cover" (station change, turning it off).
    function clearToDefault(force) {
        latestRequestId = ++requestCounter;
        clearRetries();
        if (!force && settings.retainLast && currentResult) {
            log('keeping last cover');
            currentSongKey = null;
            currentSongChannel = null;
            return;
        }
        currentSongKey = null;
        currentSongChannel = null;
        currentResult = null;
        showArt(defaultImageUrl(), WAITING_TOOLTIP);
    }

    function restartDetection() {
        clearTimeout(channels.rt0.timer);
        clearTimeout(channels.rt1.timer);
        channels.rt0.lastText = null;
        channels.rt1.lastText = null;
        rtHasSong = false;
        psSeq = [];
        currentSongKey = null;
        latestRequestId = ++requestCounter;
        clearRetries();
    }

    function resetForNewStation() {
        restartDetection();
        clearToDefault(true);
    }

    // ---------------------------------------------------------------
    // Reading the song from RT / PS
    // ---------------------------------------------------------------
    // "T 2641151352 ARTIST - TITLE": a phone number some stations put first.
    const PHONE_PREFIX = /^\s*(?:\p{L}{1,4}\.?:?\s*)?\+?\d[\d\s\-.\/()]{5,}\d\s*[-:|]?\s*/u;

    // Text that is clearly not a song: phone numbers, e-mail and web
    // addresses, frequencies ("97.8"); for PS also a word repeated three
    // times, which is what a scrolling station name assembles into.
    function isJunkText(s, isPs) {
        if (/@|https?:|www\.|\.(?:gr|com|net|org|eu)\b/i.test(s)) return true;
        if ((s.match(/\d/g) || []).length >= 7) return true;
        if (/(?:^|\s)\d{2,3}[.,]\d{1,2}(?=\s|$)/.test(s)) return true;
        if (isPs) {
            const counts = {};
            const words = s.toLowerCase().split(/\s+/).filter(Boolean);
            for (let i = 0; i < words.length; i++) {
                counts[words[i]] = (counts[words[i]] || 0) + 1;
                if (counts[words[i]] >= 3) return true;
            }
        }
        return false;
    }

    function stripKnownPrefix(text) {
        const match = text.match(/^([^:]{1,15}):\s*(.+)$/);
        if (!match) return text;
        const remainder = match[2];
        if (/\s[-–—]\s/.test(remainder)) {
            return remainder.trim();
        }
        return text;
    }

    function collapseRepeat(text) {
        const match = text.match(/^(.+?)(?:\s*[-–—,;|]?\s*\1)+$/i);
        return match ? match[1].trim() : text;
    }

    function parseArtistTitle(rawText) {
        if (!rawText) return null;

        let text = rawText.replace(/\s+/g, ' ').trim();
        text = text.split('|')[0].trim();
        text = text.replace(PHONE_PREFIX, '').trim();
        text = stripKnownPrefix(text);
        text = collapseRepeat(text);

        if (!text || text.length < 4) return null;

        // Loose also accepts a hyphen without spaces ("Artist-Title") when
        // there is exactly one.
        let separatorPattern = /\s[-–—]\s/;
        if (!separatorPattern.test(text) && settings.strictness === 'loose' && (text.match(/[-–—]/g) || []).length === 1) {
            separatorPattern = /[-–—]/;
        }
        if (!separatorPattern.test(text)) return null;

        const match = separatorPattern.exec(text);
        let left = text.slice(0, match.index).trim();
        let right = text.slice(match.index + match[0].length).trim();

        if (!left || !right) return null;
        if (left.length < 2 || right.length < 2) return null;
        if (left.length > 60 || right.length > 60) return null;
        if (isJunkText(left + ' ' + right, false)) return null;
        if (left.toLowerCase() === right.toLowerCase()) return null;
        if (/^(?:spot|news|ads?)$/i.test(left)) return null;

        if (stationProfile().rtOrder === 'title-artist') {
            const t = left; left = right; right = t;
        }
        return { artist: left, title: right };
    }

    function applyResult(requestId, channelName, key, result) {
        if (requestId !== latestRequestId) return;
        if (!result || !result.found) return;

        currentSongKey = key;
        currentSongChannel = channelName;
        clearRetries();
        const tooltip = (result.artistName && result.trackName)
            ? `${result.artistName} — ${result.trackName}`
            : '';
        currentResult = {
            artist: result.artistName || '',
            title: result.trackName || '',
            album: result.collectionName || '',
            year: result.year || '',
            artwork: result.artwork,
            artworkBig: result.artworkBig || result.artwork,
            storeUrl: result.storeUrl || '',
            source: result.source || ''
        };
        log('found', currentResult.artist, '—', currentResult.title, 'via', currentResult.source);
        showArt(result.artwork, tooltip);
        addHistory(result);
    }

    function lookupParams(base) {
        const params = Object.assign({}, base);
        params.providers = PROVIDERS.filter(function (n) { return settings[n]; }).join(',');
        params.strict = settings.strictness;
        if (!params.q && stationProfile().rtOrder !== 'auto') params.order = 'fixed';
        return params;
    }

    function runLookup(channelName, key, baseParams) {
        if (key === currentSongKey) return;

        const params = lookupParams(baseParams);
        if (!params.providers) {
            log('no artwork source enabled');
            return;
        }
        const fullKey = key + '|||' + params.providers + '|' + params.strict + '|' + (params.order || 'a');
        // Asked recently and nothing was found (its retries, if any, are
        // still scheduled).
        if (missUntil[fullKey] > Date.now()) return;

        const requestId = ++requestCounter;
        latestRequestId = requestId;
        clearRetries();

        const cached = localCache[fullKey] || persistentGet(fullKey);
        if (cached && cached.found) {
            log('cache hit', key);
            applyResult(requestId, channelName, key, cached);
            return;
        }

        function ask(attempt) {
            const p = attempt > 0 ? Object.assign({ retry: 1 }, params) : params;
            log(attempt > 0 ? 'retry ' + attempt : 'lookup', p);
            $.getJSON('/radiotext-coverart/get', p)
                .done(function (result) {
                    if (result && result.found) {
                        delete missUntil[fullKey];
                        localCache[fullKey] = result;
                        persistentSet(fullKey, result);
                        applyResult(requestId, channelName, key, result);
                        return;
                    }
                    log('not found', key);
                    missUntil[fullKey] = Date.now() + MISS_TTL_MS;
                    if (settings.retry && attempt < CONFIG.retryDelays.length && requestId === latestRequestId) {
                        retryTimers.push(setTimeout(function () {
                            if (requestId === latestRequestId) ask(attempt + 1);
                        }, CONFIG.retryDelays[attempt] * 1000));
                    }
                })
                .fail(function () {
                    console.warn('RadioText Cover Art: lookup failed for', p);
                });
        }
        ask(0);
    }

    function lookupArt(channelName, artist, title) {
        runLookup(channelName, `${artist.toLowerCase()}|||${title.toLowerCase()}`, { artist, title });
    }

    const PS_MAX_FRAMES = 24;
    const PS_STALE_MS = 15000;
    let psSeq = [];
    let rtHasSong = false;

    function psWordKey(text) {
        const words = text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
            .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        return Array.from(new Set(words)).sort().join(' ');
    }

    function mergePsChunks(chunks) {
        let out = chunks[0];
        for (let i = 1; i < chunks.length; i++) {
            const next = chunks[i];
            let merged = false;
            for (let k = Math.min(out.length, next.length) - 1; k >= 3; k--) {
                if (out.endsWith(next.slice(0, k))) {
                    out += next.slice(k);
                    merged = true;
                    break;
                }
            }
            if (!merged) out += ' ' + next;
        }
        return out.replace(/\s+/g, ' ').trim();
    }

    function handlePs(psRaw) {
        // "Always parse PS" for a station searches even when RT has a song.
        if (rtHasSong && stationProfile().psMode !== 'on') return;
        const ps = (psRaw || '').toString().replace(/[_?]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!ps) return;

        const now = Date.now();
        const last = psSeq[psSeq.length - 1];
        if (last && last.text === ps) return;
        if (last && now - last.ts > PS_STALE_MS) psSeq = [];

        psSeq.push({ text: ps, ts: now });
        if (psSeq.length > PS_MAX_FRAMES) psSeq = [psSeq[psSeq.length - 1]];

        // A cycle is complete when the newest frame was seen before with at
        // least one other frame in between; frames left over from the
        // previous text don't hold it up.
        const texts = psSeq.map(function (f) { return f.text; });
        const lastIdx = texts.length - 1;
        const k = texts.lastIndexOf(texts[lastIdx], lastIdx - 1);
        if (k < 0 || lastIdx - k < 2) return;

        const full = mergePsChunks(texts.slice(k, lastIdx));
        psSeq = [psSeq[lastIdx]];
        if (full.length < 6 || full.split(' ').length < 2) return;
        if (isJunkText(full, true)) {
            log('PS ignored:', full);
            return;
        }

        log('PS assembled:', full);
        runLookup('ps', 'ps|||' + psWordKey(full), { q: full });
    }

    function processChannel(channelName, rawText) {
        const ch = channels[channelName];
        const normalized = (rawText || '').replace(/\s+/g, ' ').trim();
        if (normalized === ch.lastText) return;
        ch.lastText = normalized;

        clearTimeout(ch.timer);
        ch.timer = setTimeout(function () {
            settleChannel(channelName, normalized);
        }, settings.stableDelay);
    }

    function settleChannel(channelName, normalized) {
        const pair = parseArtistTitle(normalized);
        const newKey = pair ? `${pair.artist.toLowerCase()}|||${pair.title.toLowerCase()}` : null;

        if (newKey && newKey === currentSongKey) {
            return;
        }

        if (channelName === currentSongChannel) {
            clearToDefault(false);
        }

        if (pair) {
            rtHasSong = true;
            log('RT', channelName, '→', pair.artist, '/', pair.title);
            lookupArt(channelName, pair.artist, pair.title);
        }
    }

    function handleParsedData(parsedData) {
        maybeLayout();

        if (typeof parsedData.pi !== 'undefined') lastPi = parsedData.pi;

        if (!settings.enabled) {
            if (typeof parsedData.freq !== 'undefined') lastFreq = parsedData.freq;
            return;
        }

        if (typeof parsedData.freq !== 'undefined') {
            if (lastFreq !== null && parsedData.freq !== lastFreq) {
                resetForNewStation();
            }
            lastFreq = parsedData.freq;
        }

        if (usePs() && typeof parsedData.ps !== 'undefined') handlePs(parsedData.ps);

        if (!useRt()) return;

        const liveIsRt0 = parsedData.rt_flag === 0;
        const order = liveIsRt0 ? ['rt1', 'rt0'] : ['rt0', 'rt1'];

        order.forEach(function (channelName) {
            if (typeof parsedData[channelName] !== 'undefined') {
                processChannel(channelName, parsedData[channelName]);
            }
        });
    }

    function attachSocketListener() {
        if (!window.socket) {
            setTimeout(attachSocketListener, 250);
            return;
        }

        window.socket.addEventListener('message', function (event) {
            if (event.data === 'KICK') return;

            let parsedData;
            try {
                parsedData = JSON.parse(event.data);
            } catch (e) {
                return;
            }

            if (typeof parsedData.rt0 === 'undefined' && typeof parsedData.rt1 === 'undefined' &&
                typeof parsedData.freq === 'undefined' && typeof parsedData.ps === 'undefined') return;
            if (typeof parsedData.rt0 !== 'undefined' || typeof parsedData.rt1 !== 'undefined') {
                $('#rt-container').toggleClass('rt-ca-rt-empty',
                    !String(parsedData.rt0 || '').trim() && !String(parsedData.rt1 || '').trim());
            }
            handleParsedData(parsedData);
        });
    }

    let resizeTimer = null;

    function start() {
        computeSettings();
        injectStyles();
        createModal();

        (function place() {
            if (!createPlacement()) setTimeout(place, 250);
            else setTimeout(layout, 1000);
        })();
        // The PS font (Roboto Mono) may arrive after the first fit.
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { layout(); });

        $(window).on('resize orientationchange', function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(layout, 200);
            setTimeout(layout, 700);
        });

        attachSocketListener();
    }

    function init() {
        loadStorage();
        $.ajax({ url: '/radiotext-coverart/config', dataType: 'json', cache: false, timeout: 5000 })
            .done(function (cfg) {
                if (cfg && typeof cfg === 'object') {
                    serverDefaults = cfg.defaults || {};
                    serverProviders = Object.assign(serverProviders, cfg.providers || {});
                    serverDefaultImage = cfg.defaultImage || null;
                    isAdmin = !!cfg.isAdmin;
                }
            })
            .always(start);
    }

    $(document).ready(init);

})();
