/* ============================================================
   liveshelf.js — dynamic Top Shelf, like on Apple TV.

   When a streaming app is selected in the dock, its Top
   Shelf shows what is popular right now on that service:
   a large background of the movie / series, with its title and rating.

   Sources:
     Smart Hub        the app's own rows for Samsung's home (Plex's Continue Watching,
                      Spotify's mixes…), first when there are some — Vetro
     TMDB             current movies and series per service, in the screen's country
                      (Netflix, Prime Video, Disney+, CANAL+, TF1+, M6+…) — key
     YouTube Data API trending videos in the screen's country, for TizenTube — key
     Apple (RSS feed) Top albums in the screen's country for music apps — no key
     Fanart.tv        textless HD backgrounds — key (optional)
     Cinemeta         IMDb ratings (Stremio's public service) — no key
     Steam            top sellers (Steam Link, Moonlight, GeForce NOW…) — no key
     Xbox Game Pass   Game Pass games, with their large pictures — no key
     TheSportsDB      next Ligue 1 / Champions League matches — no key
     Dailymotion      trending videos in the screen's country — no key
   Websites (keys.local.js): trending titles of the week or popular anime, depending on the site.

   Responses are kept 6 h on the screen to limit calls.
   Without a key or a network: the app's fixed background stays.
   ============================================================ */
(function (global) {
    "use strict";

    var APL = global.APL;
    /* Apps2Samsung writes the API keys into res/wgt/js/keys.local.js: this launcher's own keys file in the
       full (hybrid) package. The launcher-only package (Tizen 6) carries a second copy at that path
       (tools/make-package.sh), read here when js/keys.local.js has no key. Only the three keys, never run. */
    (function altKeys() {
        var K = global.APL_KEYS = global.APL_KEYS || {};
        if (K.tmdb || K.youtube || K.fanart || !global.tizen || !global.XMLHttpRequest) return;
        try {
            var x = new global.XMLHttpRequest(), m, re = /\b(tmdb|youtube|fanart)\s*:\s*"([A-Za-z0-9_-]+)"/g;
            x.open("GET", "res/wgt/js/keys.local.js", false);
            x.send(null);
            var text = String(x.responseText || "");
            while ((m = re.exec(text))) { if (!K[m[1]]) K[m[1]] = m[2]; }
        } catch (e) {}
    })();
    var KEYS = global.APL_KEYS;
    var TTL = 6 * 3600 * 1000;
    var CACHE_VERSION = 6;              // 3: movies and series carry their title and their rating; 4: Smart Hub items their deep link; 5: "tv" / "movie", translated when shown; 6: all audiences only on LG
    var MIN_VOTES = 20;                 // below that, a rating doesn't mean anything yet

    /* The screen's country, for trending videos, charts, prices and what each service streams there.
       France for every screen before 1.0.14 (issue #21, from India). Samsung's own country for its store
       (db/comss/countrycode, read through Vetro) once known, and kept; until then the screen's time zone,
       then the language's country (fr-FR), else the United States. Without the bridge (The Frame 2022 on
       Tizen 6.5, #21) the country is never read, and the language says en-US on screens all over the world:
       a screen in India got American results, where JioHotstar and Sony LIV have none. */
    function savedRegion() {
        try { var r = global.localStorage.getItem("apl.region") || ""; return /^[A-Z]{2}$/.test(r) ? r : ""; } catch (e) { return ""; }
    }
    /* The screen sets its time zone from its country: the common ones, by country. */
    var ZONES = {
        IN: "Asia/Kolkata Asia/Calcutta", PK: "Asia/Karachi", BD: "Asia/Dhaka", LK: "Asia/Colombo", NP: "Asia/Kathmandu",
        AE: "Asia/Dubai", SA: "Asia/Riyadh", QA: "Asia/Qatar", KW: "Asia/Kuwait", IL: "Asia/Jerusalem Asia/Tel_Aviv",
        SG: "Asia/Singapore", MY: "Asia/Kuala_Lumpur", ID: "Asia/Jakarta", PH: "Asia/Manila", TH: "Asia/Bangkok",
        VN: "Asia/Ho_Chi_Minh Asia/Saigon", HK: "Asia/Hong_Kong", TW: "Asia/Taipei", JP: "Asia/Tokyo", KR: "Asia/Seoul",
        AU: "Australia/Sydney Australia/Melbourne Australia/Brisbane Australia/Perth Australia/Adelaide Australia/Hobart Australia/Darwin",
        NZ: "Pacific/Auckland", ZA: "Africa/Johannesburg", EG: "Africa/Cairo", NG: "Africa/Lagos", KE: "Africa/Nairobi", MA: "Africa/Casablanca",
        GB: "Europe/London", IE: "Europe/Dublin", FR: "Europe/Paris", DE: "Europe/Berlin", ES: "Europe/Madrid Atlantic/Canary",
        IT: "Europe/Rome", NL: "Europe/Amsterdam", BE: "Europe/Brussels", LU: "Europe/Luxembourg", CH: "Europe/Zurich",
        AT: "Europe/Vienna", PT: "Europe/Lisbon", PL: "Europe/Warsaw", CZ: "Europe/Prague", SE: "Europe/Stockholm",
        NO: "Europe/Oslo", DK: "Europe/Copenhagen", FI: "Europe/Helsinki", GR: "Europe/Athens", RO: "Europe/Bucharest",
        HU: "Europe/Budapest", TR: "Europe/Istanbul", UA: "Europe/Kiev Europe/Kyiv", RU: "Europe/Moscow",
        US: "America/New_York America/Chicago America/Denver America/Los_Angeles America/Phoenix America/Anchorage America/Detroit Pacific/Honolulu",
        CA: "America/Toronto America/Vancouver America/Edmonton America/Winnipeg America/Halifax America/Regina America/St_Johns",
        MX: "America/Mexico_City America/Monterrey America/Tijuana", BR: "America/Sao_Paulo", AR: "America/Argentina/Buenos_Aires America/Buenos_Aires",
        CL: "America/Santiago", CO: "America/Bogota", PE: "America/Lima"
    };
    function zoneRegion() {
        var zone = "";
        try { zone = global.tizen && global.tizen.time ? global.tizen.time.getLocalTimezone() : ""; } catch (e) {}
        try { if (!zone && global.Intl) zone = global.Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
        if (!zone) return "";
        for (var cc in ZONES) {
            if (ZONES.hasOwnProperty(cc) && (" " + ZONES[cc] + " ").indexOf(" " + zone + " ") !== -1) return cc;
        }
        return "";
    }
    var REGION = savedRegion() || zoneRegion() || langRegion() || "US";      // after ZONES, which zoneRegion reads
    function langRegion() {
        var m = /[-_]([A-Za-z]{2})$/.exec(String(global.navigator.language || ""));
        return m ? m[1].toUpperCase() : "";
    }
    function readRegion(tries) {
        if (!APL.sys || APL.sys.PREVIEW) return;
        function later() { if (tries > 0) setTimeout(function () { readRegion(tries - 1); }, 30000); }
        APL.sys.exec("vconftool get db/comss/countrycode 2>/dev/null").then(function (r) {
            var m = /value = ([A-Za-z]{2})\b/.exec(String((r && r.output) || ""));
            if (!m) { if (!r || r.ok === false) later(); return; }       // Vetro not up yet; an empty value: kept as is
            var cc = m[1].toUpperCase();
            if (cc === REGION && savedRegion()) return;
            try { global.localStorage.setItem("apl.region", cc); } catch (e) {}
            REGION = cc;
            cacheFor(cc);
        }).catch(later);
    }
    /* What is kept (6 h) was fetched for one country: another one empties it. Before 1.0.14 that was France
       on every screen, whose trending videos then stayed on a screen in India for hours (#21). */
    function cacheFor(cc) {
        var was = "";
        try { was = global.localStorage.getItem("apl.liveRegion") || ""; } catch (e) {}
        if (was === cc) return;
        clearCache();
        try { global.localStorage.setItem("apl.liveRegion", cc); } catch (e) {}
    }
    function clearCache() {
        try {
            var del = [], i;
            for (i = 0; i < global.localStorage.length; i++) {
                var k = global.localStorage.key(i);
                if (k && k.indexOf("apl.live.") === 0) del.push(k);
            }
            del.forEach(function (k) { global.localStorage.removeItem(k); });
        } catch (e) {}
    }
    cacheFor(REGION);
    if (!APL.ccOverlay) setTimeout(function () { readRegion(6); }, 20000);

    /* TMDB (JustWatch) "provider" ids of the services (the same in every country). */
    var TMDB_PROVIDERS = {
        netflix: 8, primevideo: "9|119", disneyplus: 337, appletv: 350,
        paramountplus: 531, crunchyroll: 283, rakutentv: 35, plutotv: 300, canalplus: 381,
        jiohotstar: 2336, sonyliv: 237
    };

    function cacheGet(k, anyAge, ttl) {
        try {
            var c = JSON.parse(global.localStorage.getItem("apl.live." + k) || "null");
            if (c && c.v === CACHE_VERSION && (anyAge || Date.now() - c.t < (ttl || TTL)) && c.items && c.items.length) return c.items;
        } catch (e) {}
        return null;
    }
    function cachePut(k, items) {
        try { global.localStorage.setItem("apl.live." + k, JSON.stringify({ v: CACHE_VERSION, t: Date.now(), items: items })); } catch (e) {}
    }

    /* ---------- the pictures themselves, kept on the screen ---------- */
    /* The lists of titles stay 6 h, their pictures did not: every launch fetched
       the same ten backdrops again, and a picture that is not there yet is a
       download before it can be drawn. They are kept as blobs in the screen's own
       storage and drawn from there, so a step - and a launch - finds them ready.
       Forty-eight at most, newest kept; the store lives beside the lists. */
    var ART_DB = "apl-art", ART_STORE = "pics", ART_MAX = 48;
    var ART_TTL = 6 * 3600 * 1000;              // the same six hours as the lists of titles
    var artUrls = {}, artDb = null, artHydrated = false;

    function artOpenDb(then) {
        if (!global.indexedDB) { then(null); return; }
        if (artDb) { then(artDb); return; }
        var req;
        try { req = global.indexedDB.open(ART_DB, 1); } catch (e) { then(null); return; }
        req.onupgradeneeded = function () {
            var db = req.result;
            if (!db.objectStoreNames.contains(ART_STORE)) db.createObjectStore(ART_STORE);
        };
        req.onsuccess = function () { artDb = req.result; then(artDb); };
        req.onerror = function () { then(null); };
    }
    function artDrop(url) {
        if (!artDb) return;
        try { artDb.transaction(ART_STORE, "readwrite").objectStore(ART_STORE)["delete"](url); } catch (e) {}
    }
    /* Once, at start-up: every kept picture becomes an object URL in memory, so a
       shelf can be shown from it without waiting for a single read. */
    function artHydrate() {
        artOpenDb(function (db) {
            if (!db || artHydrated) return;
            artHydrated = true;
            var tx, store, cur, found = [];
            try { tx = db.transaction(ART_STORE, "readonly"); store = tx.objectStore(ART_STORE); } catch (e) { return; }
            cur = store.openCursor();
            cur.onsuccess = function () {
                var c = cur.result;
                if (c) { found.push({ url: c.key, rec: c.value }); c.continue(); return; }
                found.sort(function (a, b) { return ((b.rec && b.rec.t) || 0) - ((a.rec && a.rec.t) || 0); });
                found.forEach(function (e, i) {
                    /* A picture kept from an older list is a picture of a show
                       the app may not even open on any more: it goes. */
                    if (i >= ART_MAX || Date.now() - ((e.rec && e.rec.t) || 0) > ART_TTL) { artDrop(e.url); return; }
                    if (e.rec && e.rec.blob) {
                        try { artUrls[e.url] = global.URL.createObjectURL(e.rec.blob); } catch (err) {}
                    }
                });
            };
        });
    }
    /* A picture that has just been fetched for the wall is kept for next time,
       as the host sent it: full resolution, one copy. A fetch that fails (the
       network is not up yet at a start, a timeout) is asked for again the next
       time the title comes round, rather than that host being written off. */
    function artKeep(url) {
        if (!url || !/^https?:/i.test(url) || artUrls["!" + url]) return;
        artUrls["!" + url] = true;
        artOpenDb(function (db) {
            if (!db) return;
            /* Not from the HTTP cache: the wall has just shown this picture as an
               <img>, and that copy is cached without the headers a read needs, so a
               plain fetch of the same address is refused by the browser itself - which
               is what made it look as if the host refused to be read. */
            global.fetch(url, { cache: "no-store" }).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
                if (!b) throw new Error("no picture");
                try { db.transaction(ART_STORE, "readwrite").objectStore(ART_STORE).put({ blob: b, t: Date.now() }, url); } catch (e) {}
                /* Drawn from the store from now on, without asking the host again. */
                if (!artUrls[url]) { try { artUrls[url] = global.URL.createObjectURL(b); } catch (e) {} }
            })["catch"](function () { delete artUrls["!" + url]; });
        });
    }
    /* The picture to draw: the one on the screen if it is there, its address otherwise. */
    function artLook(url) { return (url && artUrls[url]) || ""; }
    /* One picture per app, and its name kept: an app's first backdrop is written
       down here, so the wall can have it the moment that app takes the focus -
       before its shelf has even been asked for. */
    function artFirst(appId) {
        var rec;
        try { rec = JSON.parse(global.localStorage.getItem("apl.art.first." + appId) || "null"); } catch (e) { return ""; }
        /* Six hours, like the list the address came from: an app whose shelf has
           been refreshed since opens on whatever it shows now. The picture itself
           is dropped by artHydrate; this is what stops a stale address being used
           while the new one is on its way. */
        if (!rec || !rec.u || Date.now() - (rec.t || 0) > ART_TTL) return "";
        return rec.u;
    }
    function artRemember(appId, url, index) {
        if (!appId || !url || !/^https?:/i.test(url)) return;   // a data: picture is not an address to keep
        try { global.localStorage.setItem("apl.art.first." + appId, JSON.stringify({ u: url, t: Date.now(), i: index || 0 })); } catch (e) {}
    }
    /* Which title of the shelf that picture is: the wall opens on it rather than on
       the first one, so the picture does not change back a moment later. */
    function artFirstIndex(appId) {
        var rec;
        try { rec = JSON.parse(global.localStorage.getItem("apl.art.first." + appId) || "null"); } catch (e) { return 0; }
        if (!rec || Date.now() - (rec.t || 0) > ART_TTL) return 0;
        return rec.i || 0;
    }

    APL.artCache = { look: artLook, keep: artKeep, first: artFirst, firstIndex: artFirstIndex, remember: artRemember };
    setTimeout(artHydrate, 0);

    function getJson(url) {
        return global.fetch(url).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        });
    }
    /* A title's ids never change: one request each, however many ask. Its rating and its fanart.tv picture
       each asked TMDB for the same ids, so every series on the Top Shelf was looked up twice. */
    var idsAsked = {};
    function getIds(url) {
        if (!idsAsked[url]) idsAsked[url] = getJson(url).then(null, function (e) { delete idsAsked[url]; throw e; });
        return idsAsked[url];
    }

    var TMDB = "https://api.themoviedb.org/3";
    var IMG = "https://image.tmdb.org/t/p/";
    /* The full-screen pictures' size: TMDB's own on a page drawn in 4K (LG, js/webos.js sets APL_HIRES),
       where a 780 or 1280 px wide picture showed its title logo blurred; Samsung keeps its sizes. */
    function big(size) { return global.APL_HIRES ? "original" : size; }
    /* The same TMDB picture at a smaller one of its sizes, never a bigger one: w300 for a blur or a sample,
       w1280 for a card. Drawing a 4K "original" into a 192 x 108 blur made the page decode all of it on its
       own thread, 0.4 s at a time on an LG G5 while the focus moved. Other hosts are left as they are. */
    var SIZES = ["w45", "w92", "w154", "w185", "w300", "w342", "w500", "w780", "w1280", "original"];
    APL.artSize = function (url, size) {
        var m = /^(https?:\/\/image\.tmdb\.org\/t\/p\/)([a-z0-9]+)(\/.+)$/.exec(String(url || ""));
        if (!m || SIZES.indexOf(m[2]) <= SIZES.indexOf(size) || SIZES.indexOf(size) < 0) return url;
        return m[1] + size + m[3];
    };

    /* Fanart.tv (free key): textless HD background and title logo, when available. */
    var FANART = "https://webservice.fanart.tv/v3/";
    function fanart(r) {
        if (!KEYS.fanart) return Promise.resolve(null);
        var idP = r._kind === "movie" ? Promise.resolve({ path: "movies/" + r.id })
            : getIds(TMDB + "/tv/" + r.id + "/external_ids?api_key=" + KEYS.tmdb)
                .then(function (x) { return x.tvdb_id ? { path: "tv/" + x.tvdb_id } : null; });
        return idP.then(function (id) {
            if (!id) return null;
            return getJson(FANART + id.path + "?api_key=" + KEYS.fanart).then(function (f) {
                var bgs = (f.moviebackground || f.showbackground || []).filter(function (b) { return !b.lang || b.lang === "" || b.lang === "00"; });
                var bg = (bgs.length ? bgs : (f.moviebackground || f.showbackground || []))[0];
                return { bg: bg ? bg.url : null };
            });
        }).catch(function () { return null; });
    }

    function ratingOf(r) {
        return (r.vote_count || 0) >= MIN_VOTES && r.vote_average ? Math.round(r.vote_average * 10) / 10 : null;
    }
    /* The real IMDb rating, from Stremio's public service. A title that is too recent doesn't have one yet. */
    var CINEMETA = "https://v3-cinemeta.strem.io/meta/";
    function imdbRating(kindOf, imdbId) {
        return getJson(CINEMETA + (kindOf === "tv" ? "series" : "movie") + "/" + imdbId + ".json").then(function (j) {
            var n = parseFloat(j.meta && j.meta.imdbRating);
            return n > 0 ? n : null;
        }).catch(function () { return null; });
    }
    /* The rating of a TMDB result: IMDb if there is one, else TMDB. */
    function noteFor(r, imdbId) {
        var other = { rating: ratingOf(r), ratingFrom: "TMDB" };
        var id = imdbId ? Promise.resolve(imdbId) : getIds(TMDB + "/" + r._kind + "/" + r.id + "/external_ids?api_key=" + KEYS.tmdb).then(function (x) { return x.imdb_id; });
        return id.then(function (i) { return i ? imdbRating(r._kind, i) : null; }).then(function (n) {
            return n ? { rating: n, ratingFrom: "IMDb" } : other;
        }, function () { return other; });
    }
    /* "★ 7.8 IMDb" (with a decimal comma in French and Polish) */
    function noteOf(item) { return item.rating ? "★ " + item.rating.toFixed(1).replace(".", APL.lang === "fr" || APL.lang === "pl" ? "," : ".") + " " + (item.ratingFrom || "TMDB") : ""; }
    /* "★ 7.8 IMDb · 2025 · TV Show" */
    function metaOf(item) {
        var type = item.type === "tv" ? APL.t("TV Show") : item.type === "movie" ? APL.t("content|Movie") : item.type;
        return [noteOf(item), item.year, type].filter(Boolean).join(" · ");
    }

    /* Background of each result (Fanart.tv if it has one, else TMDB), its title and its rating. */
    function decorate(list) {
        return Promise.all(list.map(function (r) {
            return Promise.all([fanart(r), noteFor(r)]).then(function (both) {
                var fa = both[0] || {};
                return {
                    bg: fa.bg || IMG + big("w1280") + r.backdrop_path,
                    bgSmall: fa.bg ? fa.bg.replace("/fanart/", "/preview/") : IMG + "w300" + r.backdrop_path,   // enlarged = blurred, for the grid
                    card: IMG + "w780" + r.backdrop_path,
                    title: r.title || r.name || "",
                    rating: both[1].rating,
                    ratingFrom: both[1].ratingFrom,
                    year: String(r.release_date || r.first_air_date || "").substr(0, 4),
                    type: r._kind === "tv" ? "tv" : "movie"                // translated when shown (metaOf): kept 6 h, the language may change
                };
            });
        }));
    }

    function top(results, n) {
        return results.filter(function (r) { return r.backdrop_path; })
            .sort(function (a, b) { return (b.popularity || 0) - (a.popularity || 0); })
            .slice(0, n || 8);
    }
    function kind(k) { return function (r) { r._kind = r._kind || k; return r; }; }

    /* ---------- all audiences only (LG: APL.platform.allAges, js/webos.js) ----------
       What the Top Shelf recommends (popular on a service, trending, anime) is then only for all ages: every
       rating TMDB knows for it, in the screen's country and in the big ones (US, UK, Germany, France), is
       Tous publics, U, G, PG, FSK 0 or 6. Nothing rated -10, -12, PG-13, 12A, FSK 12 and above, nothing with no
       rating. The same rule as APL TV's screen saver (its js/meta.js, allAges). */
    var ALL_AGES = !!(APL.platform && APL.platform.allAges);
    var AGES = { G: 0, U: 0, TP: 0, AL: 0, KT: 0, T: 0, L: 0, APTA: 0, A: 0, "TV-Y": 0, "TV-G": 0, C: 0,
                 PG: 8, "TV-Y7": 7, C8: 8, "TV-PG": 10, "PG-13": 13, "TV-14": 14, "14A": 14, "12A": 12, R: 17, "TV-MA": 17,
                 "NC-17": 18, "18A": 18, R18: 18, X: 18, VM14: 14, VM18: 18 };
    var UNRATED = /^(NR|N\/A|NA|UNRATED|NOT RATED|-|EXEMPT|E)$/i;
    function minAge(cc, v) {
        var up = String(v || "").toUpperCase().trim(), n = parseInt(up.replace(/^M\//, "").replace(/\D/g, ""), 10);
        if (!up || UNRATED.test(up)) return -1;
        if (AGES[up] !== undefined) return cc === "CA" && up === "R" ? 18 : AGES[up];
        return isNaN(n) ? -1 : n;
    }
    var RELEASE_ORDER = [3, 2, 4, 5, 1, 6];          // the cinema release's rating first, then the others
    function ageOk(r) {
        if (r.adult) return Promise.resolve(false);
        var path = r._kind === "tv" ? "/tv/" + r.id + "/content_ratings" : "/movie/" + r.id + "/release_dates";
        return getJson(TMDB + path + "?api_key=" + KEYS.tmdb).then(function (j) {
            var by = {};
            (j.results || []).forEach(function (x) {
                var v = x.rating || "", rank = 99;
                (x.release_dates || []).forEach(function (d) {
                    var k = RELEASE_ORDER.indexOf(d.type);
                    if (k < 0) k = 9;
                    if (d.certification && k < rank) { rank = k; v = d.certification; }
                });
                by[x.iso_3166_1] = v;
            });
            var worst = -1;
            ["US", "GB", "DE", "FR", REGION].forEach(function (cc) { if (by[cc]) worst = Math.max(worst, minAge(cc, by[cc])); });
            return worst >= 0 && worst < 10;
        }).catch(function () { return false; });
    }
    /* The most popular ones, or on LG the most popular for all audiences (more are looked at: few are) */
    function pick(results, n) {
        if (!ALL_AGES) return Promise.resolve(top(results, n));
        var many = top(results, 30);
        return Promise.all(many.map(ageOk)).then(function (ok) {
            return many.filter(function (r, i) { return ok[i]; }).slice(0, n || 8);
        });
    }

    /* Popular movies and series on a service (Netflix, Prime Video…) in the screen's country. */
    function tmdb(providerId) {
        var common = "api_key=" + KEYS.tmdb + "&language=" + APL.locale + "&watch_region=" + REGION +
                     "&with_watch_providers=" + encodeURIComponent(providerId) + "&sort_by=popularity.desc";
        return Promise.all([
            getJson(TMDB + "/discover/tv?" + common).catch(function () { return { results: [] }; }),
            getJson(TMDB + "/discover/movie?" + common).catch(function () { return { results: [] }; })
        ]).then(function (res) {
            return pick((res[0].results || []).map(kind("tv")).concat((res[1].results || []).map(kind("movie")))).then(decorate);
        });
    }

    /* Trending titles of the week, all services (movie and series websites). */
    function trending() {
        return getJson(TMDB + "/trending/all/week?api_key=" + KEYS.tmdb + "&language=" + APL.locale).then(function (j) {
            return pick((j.results || []).filter(function (r) { return r.media_type === "movie" || r.media_type === "tv"; })
                .map(function (r) { r._kind = r.media_type; return r; })).then(decorate);
        });
    }

    /* Popular Japanese anime (anime websites and apps). */
    function anime() {
        var q = "api_key=" + KEYS.tmdb + "&language=" + APL.locale + "&with_genres=16&with_original_language=ja&sort_by=popularity.desc";
        return Promise.all([
            getJson(TMDB + "/discover/tv?" + q).catch(function () { return { results: [] }; }),
            getJson(TMDB + "/discover/movie?" + q).catch(function () { return { results: [] }; })
        ]).then(function (res) {
            return pick((res[0].results || []).map(kind("tv")).concat((res[1].results || []).map(kind("movie")))).then(decorate);
        });
    }

    /* Music: Top albums in the screen's country, live (Apple's official feed, no key). */
    var MUSIC_KEYS = { applemusic: 1, spotify: 1, deezer: 1, amazonmusic: 1, youtubemusic: 1, tidal: 1, qobuz: 1 };
    function appleCharts() {
        var path = "/api/v2/" + REGION.toLowerCase() + "/music/most-played/12/albums.json";
        return getJson("https://rss.marketingtools.apple.com" + path)
            .catch(function () { return getJson("https://rss.applemarketingtools.com" + path); })
            .then(function (j) {
                return ((j.feed && j.feed.results) || []).map(function (a) {
                    var art = String(a.artworkUrl100 || "");
                    if (!art) return null;
                    return {
                        bg: art.replace(/\/\d+x\d+[a-z]*\.(jpg|png)$/i, "/1600x1600bb.jpg"),
                        bgSmall: art.replace(/\/\d+x\d+[a-z]*\.(jpg|png)$/i, "/300x300bb.jpg"),
                        logo: null,
                        title: a.name || "",
                        sub: (a.artistName ? a.artistName + " · " : "") + APL.t("Top albums")
                    };
                }).filter(Boolean);
            });
    }

    /* YouTube: trending videos in the screen's country (cat = category, e.g. "10" for music). */
    function youtube(cat) {
        var url = "https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&maxResults=10&regionCode=" +
                  REGION + (cat ? "&videoCategoryId=" + cat : "") + "&key=" + KEYS.youtube;
        return getJson(url).then(function (j) {
            return (j.items || []).map(function (v) {
                var t = v.snippet.thumbnails || {};
                var best = t.maxres || t.standard || t.high;
                return best ? { bg: best.url, bgSmall: (t.medium || t.default || best).url, logo: null, title: v.snippet.title, sub: v.snippet.channelTitle } : null;
            }).filter(Boolean);
        });
    }

    /* Games: Steam top sellers in the screen's country (no key). Background = a screenshot of the game at
       1920×1080, title = the game's official logo (else its name). */
    var STEAM_CDN = "https://cdn.akamai.steamstatic.com/steam/apps/";
    var STEAM_LANG = APL.lang === "fr" ? "french" : APL.lang === "pl" ? "polish" : "english";       // language of the genres
    function games() {
        return getJson("https://store.steampowered.com/api/featuredcategories?cc=" + REGION + "&l=" + STEAM_LANG).then(function (j) {
            var seen = {}, list = [];
            ((j.top_sellers && j.top_sellers.items) || []).concat((j.new_releases && j.new_releases.items) || []).forEach(function (g) {
                if (!g || g.type !== 0 || seen[g.id] || /steam deck|valve index|steam controller/i.test(g.name || "")) return;
                seen[g.id] = 1; list.push(g);
            });
            return Promise.all(list.slice(0, 8).map(function (g) {
                return getJson("https://store.steampowered.com/api/appdetails?appids=" + g.id + "&cc=" + REGION + "&l=" + STEAM_LANG).then(function (d) {
                    var x = d && d[g.id] && d[g.id].success && d[g.id].data;
                    var shot = x && x.screenshots && x.screenshots[0];
                    if (!shot) return null;
                    var genres = (x.genres || []).slice(0, 2).map(function (z) { return z.description; }).join(" · ");
                    return { bg: shot.path_full, bgSmall: shot.path_thumbnail || shot.path_full, logo: STEAM_CDN + g.id + "/logo.png",
                             title: g.name, sub: (genres ? genres + " · " : "") + APL.t("Steam top sellers") };
                }).catch(function () { return null; });
            })).then(function (r) { return r.filter(Boolean); });
        });
    }

    /* Xbox Game Pass: popular Game Pass games (no key), with their large official
       textless picture. The "popular" list, else the whole console catalogue. */
    var GAMEPASS_LISTS = ["eab7757c-ff70-45af-bfa6-79d3cfb2bf81", "f6f1f99f-9b49-4ccd-b3bf-4d9767a77f5e"];
    function gamepass() {
        function ids(list) {
            return getJson("https://catalog.gamepass.com/sigls/v2?id=" + list + "&language=" + APL.locale.toLowerCase() + "&market=" + REGION).then(function (arr) {
                var r = (arr || []).filter(function (x) { return x && x.id; }).map(function (x) { return x.id; }).slice(0, 10);
                if (!r.length) throw new Error("empty list");
                return r;
            });
        }
        return ids(GAMEPASS_LISTS[0]).catch(function () { return ids(GAMEPASS_LISTS[1]); }).then(function (r) {
            return getJson("https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=" + r.join(",") +
                           "&market=" + REGION + "&languages=" + APL.locale.toLowerCase() + "&MS-CV=APLLauncher.1");
        }).then(function (j) {
            return (j.Products || []).map(function (p) {
                var lp = (p.LocalizedProperties || [])[0] || {}, imgs = lp.Images || [];
                function pick(purpose) { for (var i = 0; i < imgs.length; i++) if (imgs[i].ImagePurpose === purpose) return imgs[i]; return null; }
                var hero = pick("SuperHeroArt") || pick("TitledHeroArt") || pick("Screenshot");
                if (!hero || !hero.Uri) return null;
                var url = (hero.Uri.indexOf("//") === 0 ? "https:" : "") + hero.Uri;
                return { bg: url + "?w=1920&q=85", bgSmall: url + "?w=320&q=70", logo: null,
                         title: lp.ProductTitle || "", sub: "Xbox Game Pass" };
            }).filter(Boolean);
        });
    }

    /* Consoles: a Home tile for an input with its device chosen (Switch 2, PS5, Xbox, Steam Deck…) shows the games
       of the moment on that console, from each maker's own store, with no key and no account:
         PS5, PS4          the PlayStation Store's best sellers of the last 30 days, in the screen's country, with
                           each game's wide background art (else a screenshot) and its logo
         Switch 2, Switch  Nintendo's European eShop sorted by popularity (games out, or out within 45 days)
         Xbox (Series, One) Game Pass's most popular games (gamepass above)
         Steam Deck, Steam Machine, ROG Ally, Legion Go, PC: Steam's top sellers (games above)
       The older and retro consoles (PS3, PS2, Wii U, Wii, Xbox 360, Sega, Atari…) have no store left to ask:
       their tile keeps its own picture. The PlayStation app (Remote Play, PS Plus) shows the PS5's.
       The store's own web requests: one that changes gives no list, and then a few big games of the Switch 2 and
       the PS5 chosen by hand, with their official store pictures, stand in. */
    var CONSOLES = {
        switch2: { name: "Nintendo Switch 2", eshop: "BEE" }, "switch": { name: "Nintendo Switch", eshop: "HAC" },
        ps5: { name: "PS5", store: "PS5" }, ps4: { name: "PS4", store: "PS4" },
        xbox: { name: "Xbox", gamepass: 1 }, xboxseries: { name: "Xbox Series X|S", gamepass: 1 }, xboxone: { name: "Xbox One", gamepass: 1 },
        steamdeck: { name: "Steam Deck" }, steammachine: { name: "Steam Machine" }, rogally: { name: "ROG Ally" }, legiongo: { name: "Legion Go" },
        pc: { name: "PC" }
    };
    var NINTENDO = "https://assets.nintendo.com/image/upload/", PLAYSTATION = "https://gmedia.playstation.com/is/image/SIEPDC/";
    var PICKED = {
        switch2: [
            ["The Legend of Zelda: Ocarina of Time", "70010000130792/9fb8faf644291a8398e43eadab602842d21c6b80537f71be0462685f52605c51"],
            ["Pokémon Pokopia", "70010000107421/2045c3f67f865d333b1995562ad6b2894473b8a869e4c8efa01572539ec86019"],
            ["Mario Kart World", "70010000095431/b8ca3bbb06f7a4149bea701e6764ed302b9ec0b41b3d7137d52eddb6ed05d704"],
            ["Donkey Kong Bananza", "70010000096809/c111819ae2b07f446ab92d64c8d37e9ef8e541e30b687121fa6d5976096b61f9"],
            ["Metroid Prime 4: Beyond", "70010000104849/89135935439ee6c3125ed070b578dbf11d352afa8af0f1efec0f9fb150e856e8"],
            ["Kirby Air Riders", "70010000103775/23e7a16efe6b022a2e7b3922dc9648759ca6d2a47fbc4ee8c65b4b396564524a"],
            ["Pokémon Legends: Z-A", "70010000099365/5d23a0f34b2c8f5a9c22724692d58360e6313671a949663caf10017b59cb3a05"],
            ["Hyrule Warriors: Age of Imprisonment", "70010000103459/6c233749c2311251c1df347f5e46016b95c293d1568e1196b44d6712dcfae308"],
            ["The Legend of Zelda: Ocarina of Time", "70010000130792/2e76ea7cb3eb833a0cbe8c9b016b28b3a7ef95838b66c1eaced1c0db7747dd37"]
        ],
        ps5: [
            ["Grand Theft Auto VI", "grand-theft-auto-vi-screenshot-10-en-06may25"],
            ["Ghost of Yōtei", "ghost-of-yotei-screenshot-02-en-04sep26"],
            ["Marvel's Wolverine", "marvels-wolverine-overview-background-desktop-01-en-14aug26"],
            ["Death Stranding 2: On the Beach", "death-stranding-2-screenshot-05-en-10mar25"],
            ["Ghost of Tsushima", "ghost-of-tsushima-directors-cut-screenshot-05-en-22jun21"],
            ["Saros", "saros-screenshot-04-en-14feb25"],
            ["Astro Bot", "Astro-Bot-key-features-screenshot-02-en-24may24"],
            ["Grand Theft Auto VI", "grand-theft-auto-vi-screenshot-08-en-06may25"],
            ["Ghost of Tsushima", "ghost-of-tsushima-directors-cut-screenshot-01-en-22jun21"]
        ]
    };
    function picked(key) {
        var c = CONSOLES[key], wide = global.APL_HIRES ? 3840 : 1920;
        if (!PICKED[key]) return null;
        return PICKED[key].map(function (g) {
            var bg = key === "ps5" ? PLAYSTATION + g[1] + "?wid=" + wide + "&hei=" + wide * 9 / 16 + "&fit=crop" : NINTENDO + "c_fill,w_" + wide + ",ar_16:9/f_auto/q_auto/store/software/switch2/" + g[1];
            var small = key === "ps5" ? PLAYSTATION + g[1] + "?wid=320&hei=180&fit=crop" : NINTENDO + "c_fill,w_320,ar_16:9/f_auto/q_auto/store/software/switch2/" + g[1];
            return { bg: bg, bgSmall: small, logo: null, title: g[0], sub: c.name };
        });
    }
    function outOn(day) {
        var d = new Date(String(day).slice(0, 10) + "T12:00:00Z");
        return isNaN(d.getTime()) ? "" : APL.t("Out {date}", { date: d.getUTCDate() + " " + APL.t(MONTHS[d.getUTCMonth()]) });
    }

    /* PlayStation Store: the request its own pages make for "All games" sorted by Best Selling, one console. The
       store of the screen's language and country (fr-FR), else the English one of that country, else the US one. */
    var PS_GRID = "https://web.np.playstation.com/api/graphql/v1/op?operationName=categoryGridRetrieve";
    var PS_QUERY = "88c0b9a1273c6d320c51cd73e390924e21ae28bf09f01cde8b84b1034b16cd03", PS_ALL_GAMES = "28c9c2b2-cecc-415c-9a08-482a605cb104";
    function psStore(c) {
        var vars = { id: PS_ALL_GAMES, pageArgs: { size: 16, offset: 0 }, sortBy: { name: "sales30", isAscending: false }, filterBy: ["targetPlatforms:" + c.store], facetOptions: [] };
        var url = PS_GRID + "&variables=" + encodeURIComponent(JSON.stringify(vars)) + "&extensions=" + encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: PS_QUERY } }));
        var wide = global.APL_HIRES ? 3840 : 1920;
        var locales = [String(APL.lang || "en").slice(0, 2) + "-" + REGION, "en-" + REGION, "en-US"].filter(function (l, i, a) { return a.indexOf(l) === i; });
        function ask(i) {
            if (i >= locales.length) return Promise.reject(new Error("no list"));
            return global.fetch(url, { headers: { "x-psn-store-locale-override": locales[i], "content-type": "application/json" } }).then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            }).then(function (j) {
                var list = (j && j.data && j.data.categoryGridRetrieve && j.data.categoryGridRetrieve.concepts) || [];
                if (list.length < 3) throw new Error("too few");
                return list;
            }).catch(function () { return ask(i + 1); });
        }
        return ask(0).then(function (list) {
            return list.map(function (g) {
                var media = g.media || [];
                function pick(role) { for (var i = 0; i < media.length; i++) if (media[i].role === role && media[i].type === "IMAGE" && media[i].url) return media[i].url; return ""; }
                var art = pick("BACKGROUND_LAYER_ART") || pick("SCREENSHOT"), logo = pick("LOGO");
                if (!art || !g.name) return null;
                return { bg: art + "?w=" + wide, bgSmall: art + "?w=320", logo: logo ? logo + "?w=" + (global.APL_HIRES ? 1200 : 640) : null,
                         title: g.name, sub: APL.t("Trending on {console}", { console: c.name }) };
            }).filter(Boolean);
        });
    }

    /* Nintendo's European eShop: its own search, sorted by popularity. Its 16:9 pictures come 500 pixels wide;
       the same picture is there at 1600 (a size it lacks is skipped by the Top Shelf, launcher.js). */
    var ESHOP_LANGS = { fr: "fr", de: "de", es: "es", it: "it", nl: "nl", pt: "pt" };
    function eshop(c) {
        var lang = ESHOP_LANGS[String(APL.lang || "").slice(0, 2)] || "en";
        var q = "type:GAME AND playable_on_txt:" + c.eshop + " AND date_from:[* TO NOW+45DAYS]";
        return getJson("https://searching.nintendo-europe.com/" + lang + "/select?q=*&fq=" + encodeURIComponent(q) +
                       "&sort=" + encodeURIComponent("popularity asc") + "&rows=16&wt=json&fl=title,image_url_h16x9_s,date_from").then(function (j) {
            var now = Date.now(), wide = global.APL_HIRES ? 1920 : 1600;
            var list = ((j && j.response && j.response.docs) || []).map(function (g) {
                var pic = g.image_url_h16x9_s || "";
                if (!pic || !g.title) return null;
                var big = pic.replace(/_image500w\.(png|jpe?g)$/i, "_image1600w.$1").replace(/\/w_500\//, "/w_" + wide + "/");
                var out = g.date_from && Date.parse(g.date_from) > now;
                return { bg: big, bgSmall: pic, logo: null, title: String(g.title).trim(),
                         sub: out ? outOn(g.date_from) + " · " + c.name : APL.t("Trending on {console}", { console: c.name }) };
            }).filter(Boolean);
            if (list.length < 3) throw new Error("too few");
            return list;
        });
    }

    function consoleGames(key) {
        var c = CONSOLES[key];
        var live = c.store ? psStore(c) : c.eshop ? eshop(c) : c.gamepass ? gamepass() : games();
        return Promise.resolve(live).then(function (items) {
            if (!items || items.length < 3) throw new Error("too few");
            return items;
        }).catch(function () { return picked(key); });
    }

    /* Sport: next Ligue 1 and Champions League matches (TheSportsDB,
       free public key). Background = the match's picture, else a picture of the competition. */
    var SPORTSDB = "https://www.thesportsdb.com/api/v1/json/123/";
    var LEAGUES = [{ id: 4334, name: "Ligue 1" }, { id: 4480, name: APL.t("Champions League") }];
    var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    function when(e) {
        var d = e.strTimestamp ? new Date(e.strTimestamp.replace(/\+00:00$/, "") + "Z") : null;
        if (!d || isNaN(d.getTime())) return e.dateEvent || "";
        var hh = ("0" + d.getHours()).slice(-2), mm = ("0" + d.getMinutes()).slice(-2);
        return APL.t("{weekday} {month} {day} · {time}", { weekday: APL.t(DAYS[d.getDay()]), month: APL.t(MONTHS[d.getMonth()]), day: d.getDate(), time: hh + ":" + mm });
    }
    function sports() {
        return Promise.all(LEAGUES.map(function (L) {
            return Promise.all([
                getJson(SPORTSDB + "eventsnextleague.php?id=" + L.id).catch(function () { return {}; }),
                getJson(SPORTSDB + "lookupleague.php?id=" + L.id).catch(function () { return {}; })
            ]).then(function (r) {
                var lg = ((r[1] && r[1].leagues) || [])[0] || {};
                var fan = [lg.strFanart1, lg.strFanart2, lg.strFanart3, lg.strFanart4].filter(Boolean);
                var events = ((r[0] && r[0].events) || []).slice(0, 5);
                var items = events.map(function (e, i) {
                    var bg = e.strThumb || e.strFanart || fan[i % (fan.length || 1)];
                    if (!bg) return null;
                    var title = e.strHomeTeam && e.strAwayTeam ? e.strHomeTeam + " – " + e.strAwayTeam : (e.strEvent || L.name);
                    return { bg: bg, bgSmall: bg, logo: lg.strLogo || null, title: title, sub: L.name + " · " + when(e) };
                }).filter(Boolean);
                if (!items.length && fan.length) items.push({ bg: fan[0], bgSmall: fan[0], logo: lg.strLogo || null, title: L.name, sub: APL.t("Upcoming matches") });
                return items;
            });
        })).then(function (r) {
            // The two competitions take turns
            var out = [], a = r[0] || [], b = r[1] || [];
            for (var i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) out.push(a[i]); if (b[i]) out.push(b[i]); }
            return out;
        });
    }

    /* Dailymotion: trending videos in the screen's country (no key). */
    function dailymotion() {
        return getJson("https://api.dailymotion.com/videos?fields=title,thumbnail_1080_url,thumbnail_240_url,owner.screenname" +
                       "&flags=no_live&sort=trending&country=" + REGION.toLowerCase() + "&localization=" + APL.locale.replace("-", "_") + "&limit=10").then(function (j) {
            return (j.list || []).map(function (v) {
                return v.thumbnail_1080_url ? { bg: v.thumbnail_1080_url, bgSmall: v.thumbnail_240_url || v.thumbnail_1080_url,
                                                logo: null, title: v.title || "", sub: v["owner.screenname"] || "Dailymotion" } : null;
            }).filter(Boolean);
        });
    }

    /* Smart Hub Preview: the rows an app publishes for Samsung's home (webapis.preview.setPreviewData),
       e.g. Plex's Continue Watching or Spotify's mixes. The user's own content, kept by Samsung's content
       service in its private folder: read as root through Vetro. The image URLs can carry the app's
       token (Plex): they stay on the screen and are never logged. */
    var HUB_DB = "/opt/usr/home/owner/apps_rw/com.samsung.tv.contentservicemanager/data/.preview.db";
    var HUB_TTL = 10 * 60 * 1000;
    var HUB_JOIN = " from tiles t join sections s on s._id = t.section_id join accelerators a on a._id = s.accelerator_id";
    var hubPackages = null, hubAt = 0;
    function hubPackage(app) { var m = /^([A-Za-z0-9]{10})[.]/.exec(app.id || ""); return m ? m[1] : null; }
    function hubSql(sql) {
        // Vetro doubles backslashes: none in these commands. Its answer is cut after a few KB.
        return APL.sys.exec("sqlite3 -readonly -json " + HUB_DB + " \"" + sql + "\" 2>/dev/null").then(function (r) {
            // Vetro not up yet (right after a full start): the bridge answers { ok: false } with no exit_code
            // rather than failing. That's not "no rows": it fails, so the list is read again in 15 s. A command
            // that ran and failed (no sqlite3, no preview database) has an exit_code: no rows, no retry loop.
            if (!r || (r.ok === false && r.exit_code === undefined)) throw new Error("Vetro not ready");
            var out = String(r.output || "").trim();
            return out ? JSON.parse(out) : [];
        });
    }
    /* Which apps have tiles: read once, then every 10 minutes. */
    var hubRetry = null;
    function refreshHub() {
        if (APL.sys.PREVIEW || Date.now() - hubAt < HUB_TTL) return;
        hubAt = Date.now();
        hubSql("select distinct a.app_pkg_name pkg" + HUB_JOIN + " where t.image_url like 'http%'").then(function (rows) {
            var before = JSON.stringify(hubPackages);
            hubPackages = {};
            rows.forEach(function (r) { hubPackages[r.pkg] = true; });
            // The app in focus may already show something else: it gets its own rows now
            if (JSON.stringify(hubPackages) !== before && APL.onLiveSources) APL.onLiveSources();
        }, function () {
            // After a full start-up Vetro answers late: again in 15 s, without waiting for a focus change
            hubAt = 0;
            if (!hubRetry) hubRetry = setTimeout(function () { hubRetry = null; refreshHub(); }, 15000);
        });
    }
    /* The tiles' pictures are small: a larger one when the service has it. */
    function hubArt(url, w, h) {
        // Spotify album covers: the size is in the image id (b273 = 640 px, 82c1 = 2000 px)
        if (/^https:[/][/]i[.]scdn[.]co[/]image[/]ab67616d0000(b273|1e02)/.test(url)) return w > 1000 ? url.replace(/ab67616d0000(b273|1e02)/, "ab67616d000082c1") : url;
        // Plex: 240×360 posters; the same transcode address gives the 16:9 artwork
        if (!/[/]photo[/]:[/]transcode[?]/.test(url) || !/%2Fthumb%2F/.test(url)) return url;
        return url.replace(/width=[0-9]+/, "width=" + w).replace(/height=[0-9]+/, "height=" + h)
                  .replace(/%2Fthumb%2F[0-9]+/, "%2Fart");
    }
    function smartHub(pkg) {
        return hubSql("select s.title section, t.title, t.subtitle sub, t.image_url url, coalesce(t.action_play_url, t.action_click_url) link" + HUB_JOIN +
                      " where a.app_pkg_name = '" + pkg + "' and t.image_url like 'http%'" +
                      " order by s.position, s._id, t.position, t._id limit 8").then(function (rows) {
            return rows.map(function (r) {
                return { bg: hubArt(r.url, 1920, 1080), bgSmall: hubArt(r.url, 480, 270), logo: null, link: r.link || null,
                         title: r.title || "", sub: r.section || "",
                         // Under the title (metaOf): an episode or artists, not a playlist's description
                         type: [r.sub && r.sub.length <= 48 ? r.sub : "", r.section].filter(Boolean).join(" · ") };
            });
        });
    }

    /* Which source for this app? (null = no dynamic Top Shelf) */
    /* Settings › Appearance › Top Shelf, in this order: the app's own rows (What You're Watching, hubShelf), what
       is popular (liveShelf), then the app's artwork or the style chosen in Otherwise (launcher.js, genart.js). */
    function sourceFor(app) {
        var pub = APL.sys.pref("liveShelf") ? publicSource(app) : null, pkg = hubPackage(app);
        if (!APL.sys.pref("hubShelf")) return pub;
        refreshHub();
        if (!pkg || !hubPackages || !hubPackages[pkg]) return pub;
        // The app's own rows first; the public source when it has none any more
        return { id: "hub-" + pkg, ttl: HUB_TTL, load: function () {
            return smartHub(pkg).catch(function () { return null; }).then(function (mine) {
                return mine && mine.length ? mine : pub ? pub.load() : null;
            });
        } };
    }
    /* The online demo (PC preview without keys, GitHub Pages): Blender Studio's open movies (CC BY), with
       their TMDB pictures and ratings, stand in for what a movie or video app would show on a screen. */
    var DEMO_FILMS = [
        ["Sintel", 2010, 7.3, "/msqeiEyIRpPAtrCeRGFNZQ9tkJL.jpg"],
        ["Agent 327: Operation Barbershop", 2017, 6.9, "/aupI9kV5CawUp02XWnI2l7Ym9SH.jpg"],
        ["Big Buck Bunny", 2008, 6.5, "/xtdybjRRZ15mCrPOvEld305myys.jpg"],
        ["Charge", 2022, 7.1, "/hwvuivrtKFA4tPkW81txs7oKJOx.jpg"],
        ["Cosmos Laundromat", 2015, 6.3, "/f2wABsgj2lIR2dkDEfBZX8p4Iyk.jpg"],
        ["Sprite Fright", 2021, 7.7, "/aCMT1okuiKFnyKHdCOez66rJKyT.jpg"],
        ["Tears of Steel", 2012, 5.7, "/fOy6SL5Zs2PFcNXwqEPIDPrLB1q.jpg"],
        ["Caminandes: Llamigos", 2016, 6.6, "/tIX2BIhkhoFq1iwtHYzTSbHbe82.jpg"]
    ];
    function demoSource(app) {
        var start = 0, id = String(app.id || ""), i;
        for (i = 0; i < id.length; i++) start = (start + id.charCodeAt(i)) % DEMO_FILMS.length;   // a different film first per app
        return { id: "demo-" + start, load: function () {
            return Promise.resolve(DEMO_FILMS.slice(start).concat(DEMO_FILMS.slice(0, start)).map(function (f) {
                return { bg: IMG + "w1280" + f[3], bgSmall: IMG + "w300" + f[3], card: IMG + "w780" + f[3], title: f[0],
                         rating: f[2], ratingFrom: "TMDB", year: String(f[1]), type: "movie" };
            }));
        } };
    }
    function publicSource(app) {
        /* The demo stands in for a streaming service's own Top Shelf - Netflix,
           Prime Video, Disney+ - because that is what those apps actually carry.
           It used to cover live: "youtube", "trending" and "anime" as well, which
           is why TizenTube showed a Blender Studio film in the preview: a film
           that app does not have. Those apps keep their artwork until their own
           source (a YouTube key, a website) answers. */
        if (APL.sys.PREVIEW && !KEYS.tmdb && (TMDB_PROVIDERS[app.key] || app.tmdbProvider)) return demoSource(app);
        if (app.live === "youtube") return KEYS.youtube ? { id: "youtube", load: function () { return youtube(); } } : null;
        if (app.live === "youtube-music") return KEYS.youtube ? { id: "youtube-10", load: function () { return youtube("10"); } }
                                                              : { id: "music-" + REGION, load: appleCharts };
        if (app.live === "games") return { id: "games-steam", load: games };
        if (app.live === "gamepass") return { id: "gamepass", load: gamepass };
        // a console: an input's tile with its device chosen (sources.js), or a game app shown as one (live: "console:ps5")
        var ck = app.consoleKey || (/^console:/.test(app.live || "") ? app.live.slice(8) : "");
        if (ck && CONSOLES[ck]) return { id: "console-" + ck, load: function () { return consoleGames(ck); } };
        if (app.live === "sports") return { id: "sports", load: sports };
        if (app.live === "dailymotion") return { id: "dailymotion", load: dailymotion };
        if (app.live === "trending") return KEYS.tmdb ? { id: "trending", load: trending } : null;
        if (app.live === "anime") return KEYS.tmdb ? { id: "anime", load: anime } : null;
        // Streaming service: known in advance, or recognised automatically (autoart.js)
        var p = TMDB_PROVIDERS[app.key] || app.tmdbProvider;
        if (p && KEYS.tmdb) return { id: "tmdb-" + p, load: function () { return tmdb(p); } };
        if (MUSIC_KEYS[app.key] || app.music) return { id: "music-" + REGION, load: appleCharts };
        return null;
    }

    var inflight = {};
    function itemsFor(app) {
        var src = sourceFor(app);
        if (!src) return Promise.resolve(null);
        var cached = cacheGet(src.id, false, src.ttl);
        if (cached) return Promise.resolve(cached);
        if (!inflight[src.id]) {
            inflight[src.id] = src.load().then(function (items) {
                delete inflight[src.id];
                if (items && items.length) cachePut(src.id, items);
                return items && items.length ? items : null;
            }, function () { delete inflight[src.id]; return null; });
        }
        return inflight[src.id];
    }

    /* Right away: what we already have, even if older than 6 h. The update happens on the side, and
       serves the next time: fetching 8 movies from 3 services takes several seconds. */
    function itemsNow(app) {
        var src = sourceFor(app);
        if (!src) return Promise.resolve(null);
        var read = itemsFor(app), old = cacheGet(src.id, true);
        return old ? Promise.resolve(old) : read;
    }

    /* The large artwork of a movie or series, from its title (widgets.js): see keyArt. */
    function same(a, b) {
        function flat(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9À-ſ]+/g, ""); }
        return flat(a) === flat(b);
    }
    function searchArt(title, year) {
        if (!KEYS.tmdb || !title) return Promise.resolve(null);
        return getJson(TMDB + "/search/multi?api_key=" + KEYS.tmdb + "&language=" + APL.locale + "&query=" + encodeURIComponent(title)).then(function (d) {
            var found = (d.results || []).filter(function (r) { return r.backdrop_path && (r.media_type === "tv" || r.media_type === "movie"); });
            // The same title (and the same year, if the provider gives it) before the first one found
            var exact = found.filter(function (r) { return same(r.name || r.title, title) || same(r.original_name || r.original_title, title); });
            var dated = exact.filter(function (r) { return year && String(r.first_air_date || r.release_date || "").substr(0, 4) === year; });
            var hit = dated[0] || exact[0] || found[0];
            if (!hit) return null;
            hit._kind = hit.media_type === "tv" ? "tv" : "movie";
            return artOf(hit);
        }).catch(function () { return null; });
    }
    /* The official title logo of a film or a series (TMDB, the same picture the cards lay over a
       backdrop): the wall shows it in place of the name when one exists. */
    function logoArt(title, year) {
        if (!KEYS.tmdb || !title) return Promise.resolve("");
        function pickLogo(list, lang) {
            return (list || []).filter(function (b) { return b.iso_639_1 === lang && b.file_path; })
                .sort(function (a, b) { return (b.vote_average || 0) - (a.vote_average || 0); })[0];
        }
        return getJson(TMDB + "/search/multi?api_key=" + KEYS.tmdb + "&language=" + APL.locale + "&query=" + encodeURIComponent(title)).then(function (d) {
            var found = (d.results || []).filter(function (r) { return r.media_type === "tv" || r.media_type === "movie"; });
            var exact = found.filter(function (r) { return same(r.name || r.title, title) || same(r.original_name || r.original_title, title); });
            var dated = exact.filter(function (r) { return year && String(r.first_air_date || r.release_date || "").substr(0, 4) === year; });
            var hit = dated[0] || exact[0] || found[0];
            if (!hit) return "";
            var kind = hit.media_type === "tv" ? "tv" : "movie";
            return getJson(TMDB + "/" + kind + "/" + hit.id + "/images?api_key=" + KEYS.tmdb + "&include_image_language=" + APL.lang + ",en,null").then(function (im) {
                var logo = pickLogo(im.logos, APL.lang) || pickLogo(im.logos, "en");
                return logo ? IMG + big("w500") + logo.file_path : "";
            });
        }).catch(function () { return ""; });
    }

    /* Like on Apple TV, the picture with the title already drawn on it: TMDB tags it with a language, the
       interface's language first. Else the textless background, with the title logo laid over it (widgets.js). */
    /* A card is about a quarter of the screen wide: 1280 px is sharp on a page drawn in 4K, where the
       "original" cost a 4K decode for each card (widgets.js) */
    function cardSize() { return global.APL_HIRES ? "w1280" : "w780"; }
    function keyArt(hit) {
        var plain = { image: IMG + cardSize() + hit.backdrop_path };
        return getJson(TMDB + "/" + hit._kind + "/" + hit.id + "/images?api_key=" + KEYS.tmdb + "&include_image_language=" + APL.lang + ",en,null").then(function (im) {
            function best(list, lang) {
                return (list || []).filter(function (b) { return b.iso_639_1 === lang && b.file_path; })
                    .sort(function (a, b) { return (b.vote_average || 0) - (a.vote_average || 0); })[0];
            }
            var titled = best(im.backdrops, APL.lang) || best(im.backdrops, "en");
            if (titled) return { image: IMG + cardSize() + titled.file_path, titled: true };
            var logo = best(im.logos, APL.lang) || best(im.logos, "en");
            return { image: plain.image, logo: logo ? IMG + big("w500") + logo.file_path : "" };
        }).catch(function () { return plain; });
    }
    function artOf(hit, imdbId) {
        return Promise.all([noteFor(hit, imdbId), keyArt(hit)]).then(function (both) {
            var n = both[0], k = both[1];
            return { title: hit.title || hit.name, image: k.image, titled: !!k.titled, logo: k.logo || "", rating: n.rating, ratingFrom: n.ratingFrom };
        });
    }
    /* The same from an IMDb id (Stremio uses them). */
    function findImdb(imdbId) {
        if (!KEYS.tmdb || !/^tt[0-9]+$/.test(imdbId)) return Promise.resolve(null);
        return getJson(TMDB + "/find/" + imdbId + "?api_key=" + KEYS.tmdb + "&language=" + APL.locale + "&external_source=imdb_id").then(function (d) {
            var film = (d.movie_results || []).filter(function (r) { return r.backdrop_path; })[0];
            var show = (d.tv_results || []).filter(function (r) { return r.backdrop_path; })[0];
            var hit = film || show;
            if (!hit) return null;
            hit._kind = film ? "movie" : "tv";
            return artOf(hit, imdbId);
        }).catch(function () { return null; });
    }

    /* ---------- Universal Search ----------
       What the screen's services stream in its country (TMDB/JustWatch), for search.js:
       a title, its year, its picture and the services that have it. The service is named
       by the catalog's key, so search.js matches it with the app that is installed.
       No key (PC preview): a few open films, with the demo services. */
    var PROVIDER_OF = {};
    (function () {
        for (var k in TMDB_PROVIDERS) {
            if (!Object.prototype.hasOwnProperty.call(TMDB_PROVIDERS, k)) continue;
            String(TMDB_PROVIDERS[k]).split("|").forEach(function (id) { PROVIDER_OF[id] = k; });
        }
    })();
    var DEMO_SEARCH = [
        ["Sintel", "2010", "/msqeiEyIRpPAtrCeRGFNZQ9tkJL.jpg", "primevideo", "Prime Video"],
        ["Big Buck Bunny", "2008", "/xtdybjRRZ15mCrPOvEld305myys.jpg", "netflix", "Netflix"],
        ["Sprite Fright", "2021", "/aCMT1okuiKFnyKHdCOez66rJKyT.jpg", "appletv", "Apple TV"],
        ["Charge", "2022", "/hwvuivrtKFA4tPkW81txs7oKJOx.jpg", "primevideo", "Prime Video"],
        ["Tears of Steel", "2012", "/fOy6SL5Zs2PFcNXwqEPIDPrLB1q.jpg", "netflix", "Netflix"],
        ["Cosmos Laundromat", "2015", "/f2wABsgj2lIR2dkDEfBZX8p4Iyk.jpg", "appletv", "Apple TV"]
    ];
    function demoSearch(q) {
        var list = DEMO_SEARCH;
        if (q.length >= 2) {
            list = DEMO_SEARCH.filter(function (d) { return d[0].toLowerCase().indexOf(q) !== -1; });
        }
        return list.map(function (d, i) {
            return { id: "demo" + i, kind: "movie", title: d[0], year: d[1], backdrop: IMG + "w300" + d[2],
                     poster: "", providers: [{ key: d[3], name: d[4] }] };
        });
    }
    function providersOf(r) {
        var kind = r.media_type === "movie" ? "movie" : "tv";
        var out = {
            id: r.id, kind: kind, title: r.title || r.name || "",
            year: String(r.release_date || r.first_air_date || "").substr(0, 4),
            backdrop: r.backdrop_path ? IMG + "w300" + r.backdrop_path : "",
            poster: r.poster_path ? IMG + "w342" + r.poster_path : "",
            providers: []
        };
        return getJson(TMDB + "/" + kind + "/" + r.id + "/watch/providers?api_key=" + KEYS.tmdb).then(function (j) {
            var reg = (j.results || {})[REGION] || {};
            (reg.flatrate || []).forEach(function (p) {
                var key = PROVIDER_OF[p.provider_id];
                if (key) out.providers.push({
                    key: key,
                    name: p.provider_name,
                    link: buildDeepLink(key, r.id, kind)
                });
            });
            return out;
        }, function () { return out; });
    }
    function buildDeepLink(key, tmdbId, kind) {
        // Build service-specific deep link payloads for APL.launchDeepLink
        switch (key) {
            case "primevideo":
                // Prime Video uses GTI; TMDB doesn't provide it directly
                // Fallback: eden_resume with TMDB ID
                return JSON.stringify({ action: "play", tmdbId: tmdbId, tmdbType: kind });
            case "appletv":
                // Apple TV+ uses appletv://video/<id> or eden_resume
                return JSON.stringify({ action: "play", tmdbId: tmdbId, tmdbType: kind });
            case "disneyplus":
            case "hotstar":
            case "jiohotstar":
                return JSON.stringify({ action: "play", tmdbId: tmdbId, tmdbType: kind });
            case "netflix":
                return JSON.stringify({ action: "play", tmdbId: tmdbId, tmdbType: kind });
            case "sonyliv":
                return JSON.stringify({ action: "play", tmdbId: tmdbId, tmdbType: kind });
            case "hbomax":
            case "max":
                return JSON.stringify({ action: "play", tmdbId: tmdbId, tmdbType: kind });
            case "canalplus":
                return JSON.stringify({ action: "play", tmdbId: tmdbId, tmdbType: kind });
            case "arte":
                return JSON.stringify({ action: "play", tmdbId: tmdbId, tmdbType: kind });
            case "paramountplus":
                return JSON.stringify({ action: "play", tmdbId: tmdbId, tmdbType: kind });
            case "crunchyroll":
                return JSON.stringify({ action: "play", tmdbId: tmdbId, tmdbType: kind });
            case "rakutentv":
                return JSON.stringify({ action: "play", tmdbId: tmdbId, tmdbType: kind });
            case "plutotv":
                return JSON.stringify({ action: "play", tmdbId: tmdbId, tmdbType: kind });
            default:
                return JSON.stringify({ action: "play", tmdbId: tmdbId, tmdbType: kind });
        }
    }
    function searchTitles(q) {
        q = String(q || "").trim().toLowerCase();
        if (!KEYS.tmdb) return Promise.resolve(q.length < 2 ? demoSearch(q) : demoSearch(q));
        // Empty or very short query: show trending/popular for the region
        if (q.length < 2) {
            var trendKey = "trending." + REGION, hit = cacheGet(trendKey, false, 60 * 60 * 1000);
            if (hit) return Promise.resolve(hit);
            return getJson(TMDB + "/trending/all/week?api_key=" + KEYS.tmdb + "&language=" + APL.locale).then(function (j) {
                var list = (j.results || []).filter(function (r) {
                    return (r.media_type === "movie" || r.media_type === "tv") && (r.backdrop_path || r.poster_path);
                }).slice(0, 20);
                return Promise.all(list.map(providersOf)).then(function (rows) {
                    var out = rows.filter(function (r) { return r.providers.length; });
                    if (out.length) cachePut(trendKey, out, 60 * 60 * 1000);
                    return out;
                });
            }, function () { return []; });
        }
        var key = "srch." + REGION + "." + q, hit = cacheGet(key);
        if (hit) return Promise.resolve(hit);
        return getJson(TMDB + "/search/multi?api_key=" + KEYS.tmdb + "&language=" + APL.locale +
                       "&include_adult=false&query=" + encodeURIComponent(q)).then(function (j) {
            var list = (j.results || []).filter(function (r) {
                return (r.media_type === "movie" || r.media_type === "tv") && (r.backdrop_path || r.poster_path);
            }).slice(0, 20);
            return Promise.all(list.map(providersOf)).then(function (rows) {
                var out = rows.filter(function (r) { return r.providers.length; });
                if (out.length) cachePut(key, out);
                return out;
            });
        }, function () { return []; });
    }

    // Once Vetro is up (system.js checks it at 4 s): the first app in focus already has its own rows
    if (!APL.sys.PREVIEW) setTimeout(refreshHub, 6000);

    APL.live = {
        searchArt: searchArt,
        logoOf: logoArt,
        findImdb: findImdb,
        searchTitles: searchTitles,
        itemsFor: itemsFor,
        itemsNow: itemsNow,
        noteOf: noteOf,
        metaOf: metaOf,
        hasSource: function (app) { return !!sourceFor(app); },
        keys: function () { return { tmdb: !!KEYS.tmdb, youtube: !!KEYS.youtube, fanart: !!KEYS.fanart }; },
        region: function () { return REGION; }                           // the screen's country (autoart.js too)
    };
})(window);
