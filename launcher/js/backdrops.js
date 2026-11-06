/* ============================================================
   backdrops.js — one current title per streaming app.

   The Top Shelf already has the service's trending titles (liveshelf.js),
   but it only fills in after a pause, and an app with no TMDB provider
   (Nuvio, Stremio) has no list at all. This module gives every app that
   streams something a single landscape frame from JustWatch's public
   trending list for the screen's country — the same storefront the
   search uses — and keeps a rotation per app, so a later launch opens on
   a different title.

   A pick is chosen once, assigned from the row actually on screen (so two
   tiles never show the same poster), and cached for six hours. Nothing is
   drawn per frame: launcher.js only sets a background-image.

     supports(key)      the app has a storefront list
     pick(key)          the frame this launch shows for the app, or null
     title(key)         its title, year and rating, for the corner slate
     start(fn)          load the catalogue; fn is called when it changes
     refresh()          fetch again now
     status()           read-only, for the browser checks
   ============================================================ */
(function (global) {
    "use strict";

    var APL = global.APL = global.APL || {};

    /* v1: the store's own key, so a change of shape rebuilds the catalogue
       rather than keeping a session of the old frames. */
    var STORE_KEY = "apl.backdrops.v1";
    var WATCH_URL = "https://apis.justwatch.com/graphql";
    var IMAGE_BASE = "https://images.justwatch.com";
    /* 1920 is what this host's backdrop CDN tops out at, and the stage is a
       1920x1080 surface: a true 1:1 frame rather than a 1440 that reads as
       soft on a 4K set. */
    var PROFILE = "s1920";
    var FRESH = 6 * 60 * 60 * 1000;
    var MAX_PICKS = 5;
    var GENERAL = "general";

    /* Package technical names reported on each offer. JustWatch's own package
       filter is ignored on some storefronts, so the catalogue is filtered here. */
    var SERVICES = {
        netflix: ["netflix", "netflixbasicwithads"],
        primevideo: ["amazonprimevideo", "amazonprimevideowithads"],
        jiohotstar: ["jiohotstar", "hotstar"],
        appletv: ["appletvplus", "itunes"],
        sonyliv: ["sonyliv"],
        /* Stremio has no public catalogue of its own: it shares the storefront
           list rather than claiming a provider's titles. */
        stremio: null
    };
    /* Apps that draw their titles from another app's list instead of their own.
       Nuvio runs Netflix's catalogue, so its backdrop comes from Netflix's. */
    var SHARES = {
        nuvio: "netflix",
        hotstar: "jiohotstar"
    };
    var QUERY = "query APLBackdrop($country: Country!, $language: Language!, $first: Int!) { " +
        "popularTitles(country: $country, first: $first, sortBy: TRENDING) { edges { node { " +
        "objectType content(country: $country, language: $language) { title originalReleaseYear " +
        "backdrops { backdropUrl } } " +
        "offers(country: $country, platform: WEB) { package { technicalName } } } } } }";

    var cache = null;
    var listeners = [];
    var started = false;
    var loading = false;
    var advanced = false;
    /* One different title per app for as long as it is held. Set by assign() from
       the row the launcher actually shows; null until then. */
    var assignment = null;

    function now() { return Date.now(); }
    function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }

    function readStore() {
        try { return JSON.parse(global.localStorage.getItem(STORE_KEY) || "null"); }
        catch (e) { return null; }
    }
    function writeStore(value) {
        try { global.localStorage.setItem(STORE_KEY, JSON.stringify(value)); return true; }
        catch (e) { return false; }
    }
    /* The same country as the Top Shelf: Samsung's own, once known, then the
       screen's language, else the United States. */
    function storefront() {
        try {
            var r = global.localStorage.getItem("apl.region") || "";
            if (/^[A-Z]{2}$/.test(r)) return r;
        } catch (e) {}
        var match = /[-_]([A-Za-z]{2})$/.exec(String(global.navigator.language || ""));
        if (match) return match[1].toUpperCase();
        return "US";
    }
    function imageUrl(path) {
        if (!path) return "";
        if (path.indexOf("http") === 0) return path;
        return IMAGE_BASE + path.replace("{profile}", PROFILE).replace("{format}", "jpg");
    }

    function post(body, callback) {
        var finished = false, xhr;
        function finish(err, data) {
            if (finished) return;
            finished = true;
            callback(err, data);
        }
        try { xhr = new global.XMLHttpRequest(); }
        catch (e) { finish(e); return; }
        xhr.open("POST", WATCH_URL, true);
        xhr.timeout = 12000;
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.onreadystatechange = function () {
            var data;
            if (xhr.readyState !== 4) return;
            if (xhr.status < 200 || xhr.status >= 300) { finish(new Error("Status " + xhr.status)); return; }
            try { data = JSON.parse(xhr.responseText); }
            catch (e) { finish(e); return; }
            finish(null, data);
        };
        xhr.ontimeout = function () { finish(new Error("Timeout")); };
        xhr.onerror = function () { finish(new Error("Network error")); };
        try { xhr.send(body); } catch (e) { finish(e); }
    }

    function notify() {
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](); } catch (e) {}
        }
    }

    /* One trending pass fills every service. A service with too few of its own
       titles is topped up from the storefront list so its app still has a
       backdrop, and the entry records that it came from the wider list. */
    function pushUnique(list, item) {
        for (var i = 0; i < list.length; i++) if (list[i].url === item.url) return false;
        list.push(item);
        return true;
    }
    function buildPicks(data, country) {
        var edges = data && data.data && data.data.popularTitles && data.data.popularTitles.edges;
        /* The profile travels with the cache: a stored catalogue whose image
           widths no longer match the one this build asks for is stale, not
           reusable — otherwise every frame 404s until the six hours run out. */
        var picks = { country: country, profile: PROFILE, at: now(), picks: {}, cursors: (cache && cache.cursors) || {} };
        var general = [], keys = Object.keys(SERVICES), i, k;
        if (!edges) return null;
        picks.picks[GENERAL] = general;
        for (k = 0; k < keys.length; k++) picks.picks[keys[k]] = [];
        for (i = 0; i < edges.length; i++) {
            var node = edges[i] && edges[i].node;
            var content = node && node.content;
            var backdrops = content && content.backdrops;
            var url = imageUrl(backdrops && backdrops[0] && backdrops[0].backdropUrl);
            if (!url) continue;
            var packages = [], offers = node.offers || [];
            for (var o = 0; o < offers.length; o++) {
                if (offers[o] && offers[o].package && offers[o].package.technicalName) packages.push(offers[o].package.technicalName);
            }
            var item = { title: content.title || "", year: content.originalReleaseYear || 0, url: url };
            if (general.length < MAX_PICKS) pushUnique(general, item);
            for (k = 0; k < keys.length; k++) {
                var aliases = SERVICES[keys[k]];
                if (!aliases || picks.picks[keys[k]].length >= MAX_PICKS) continue;
                for (var p = 0; p < aliases.length; p++) {
                    if (packages.indexOf(aliases[p]) >= 0) { pushUnique(picks.picks[keys[k]], item); break; }
                }
            }
        }
        /* Nuvio and Stremio share the storefront list. A service with fewer than
           two of its own titles is topped up so it still rotates between
           launches. */
        for (k = 0; k < keys.length; k++) {
            var list = picks.picks[keys[k]], g;
            if (!SERVICES[keys[k]]) { picks.picks[keys[k]] = general.slice(0, MAX_PICKS); continue; }
            for (g = 0; g < general.length && list.length < 2; g++) {
                pushUnique(list, { title: general[g].title, year: general[g].year, url: general[g].url, shared: true });
            }
        }
        return picks;
    }

    function save() {
        if (!cache) return;
        writeStore(cache);
    }

    /* Advance only when this document has cached choices, so a first run starts
       at the newest pick and every later launch opens on a different title. */
    function advanceCursors() {
        if (advanced || !cache || !cache.picks) return;
        advanced = true;
        var changed = false, keys = Object.keys(cache.picks), i;
        for (i = 0; i < keys.length; i++) {
            var list = cache.picks[keys[i]];
            if (!list || !list.length) continue;
            cache.cursors = cache.cursors || {};
            cache.cursors[keys[i]] = ((cache.cursors[keys[i]] || 0) + 1) % list.length;
            changed = true;
        }
        if (changed) save();
    }

    function refresh() {
        if (loading) return;
        loading = true;
        var country = storefront();
        post(JSON.stringify({
            operationName: "APLBackdrop",
            query: QUERY,
            variables: { country: country, language: "en", first: 100 }
        }), function (err, data) {
            loading = false;
            if (err) return;
            var next = buildPicks(data, country);
            if (!next) return;
            if (!cache) advanced = true;      /* first catalogue: start at the newest pick */
            next.cursors = next.cursors || {};
            cache = next;
            assignment = null;
            save();
            notify();
        });
    }

    function start(listener) {
        if (typeof listener === "function") listeners.push(listener);
        if (started) { if (cache) notify(); return; }
        started = true;
        if (!cache) cache = readStore();
        if (cache) {
            cache.picks = cache.picks || {};
            cache.cursors = cache.cursors || {};
            advanceCursors();
            assignment = null;
        }
        notify();
        /* Let the Home Screen paint and settle before the catalogue request. */
        setTimeout(function () {
            var stale = !cache || !cache.at || cache.profile !== PROFILE ||
                        cache.country !== storefront() || (now() - cache.at) > FRESH;
            if (stale) refresh();
        }, 1500);
        setInterval(function () {
            if (!cache || !cache.at || (now() - cache.at) > FRESH) refresh();
        }, FRESH);
    }

    function keyFor(id) {
        if (has(SHARES, id)) return SHARES[id];
        return has(SERVICES, id) ? (SERVICES[id] ? id : GENERAL) : "";
    }

    /* The same title sits near the top of several provider lists and at the top
       of the storefront list, so on a fresh catalogue every app would open on
       one image and moving along the row would look like nothing happened.
       Assign each app the first title no earlier app in the row has taken,
       starting from its own rotation point. */
    function assignFrom(ids) {
        var taken = {}, out = {}, i, j, id, key, list, start, cand, pick;
        for (i = 0; i < ids.length; i++) {
            id = ids[i];
            key = keyFor(id);
            list = key && cache && cache.picks && cache.picks[key];
            if (!list || !list.length) continue;
            start = ((cache.cursors && cache.cursors[key]) || 0) % list.length;
            pick = null;
            for (j = 0; j < list.length; j++) {
                cand = list[(start + j) % list.length];
                if (cand && !taken[cand.url]) { pick = cand; break; }
            }
            /* Every title in the list is already shown by a neighbour: keep the
               app's own rotation pick rather than returning nothing. */
            if (!pick) pick = list[start];
            if (pick) { out[id] = pick; taken[pick.url] = true; }
        }
        return out;
    }

    /* Which title one app should slide to when it is left in focus: walk its own
       list from the pick it is showing and take the first title no other app on
       the row is showing. */
    function nextPick(id, row) {
        var key, list, current, taken = {}, start = 0, pass, i, j, cand, other;
        if (!assignment || !assignment[id]) return null;
        key = keyFor(id);
        list = key && cache && cache.picks && cache.picks[key];
        if (!list || list.length < 2) return null;
        row = row || [];
        for (i = 0; i < row.length; i++) {
            other = assignment[row[i]];
            if (other && other.url) taken[other.url] = true;
        }
        current = assignment[id];
        for (i = 0; i < list.length; i++) if (list[i] === current) { start = i; break; }
        for (pass = 0; pass < 2; pass++) {
            for (j = 1; j <= list.length; j++) {
                cand = list[(start + j) % list.length];
                if (!cand) continue;
                if (!pass) { if (!taken[cand.url]) return cand; }
                else if (cand.url !== current.url) return cand;
            }
        }
        return null;
    }

    /* Is this address already the backdrop of some other app? */
    function usesUrl(url, id) {
        var other;
        for (other in assignment) {
            if (!has(assignment, other) || other === id) continue;
            if (assignment[other] && assignment[other].url === url) return true;
        }
        return false;
    }
    /* Remember the title a pick settled on, so the next render agrees with it. */
    function remember(id, pick) {
        if (!assignment) assignment = {};
        assignment[id] = pick;
    }

    APL.backdrops = {
        supports: function (id) { return keyFor(id) !== ""; },
        /* Hand the row the launcher shows so its apps get distinct titles. */
        assign: function (ids) {
            if (!ids || !ids.length || !cache || !cache.picks) { assignment = null; return null; }
            assignment = assignFrom(ids);
            return assignment;
        },
        /* The single frame this launch shows for an app, or null. A pick that is
           already taken is walked to the next distinct title and remembered,
           whether or not assign() has run yet. */
        pick: function (id) {
            var key, list, index, i, cand;
            if (assignment && assignment[id]) return assignment[id];
            key = keyFor(id);
            if (!key || !cache || !cache.picks) return null;
            list = cache.picks[key];
            if (!list || !list.length) return null;
            index = (cache.cursors && cache.cursors[key] || 0) % list.length;
            cand = list[index];
            if (!cand || !usesUrl(cand.url, id)) return cand;
            for (i = 1; i <= list.length; i++) {
                cand = list[(index + i) % list.length];
                if (cand && cand.url && !usesUrl(cand.url, id)) { remember(id, cand); return cand; }
            }
            return list[index];
        },
        /* The title a focus dwell would slide in, without committing it. */
        peek: function (id, row) { return nextPick(id, row); },
        /* Commit that title as the app's pick. */
        rotate: function (id, row) {
            var pick = nextPick(id, row);
            if (pick && assignment) assignment[id] = pick;
            return pick;
        },
        start: start,
        refresh: refresh,
        /* Read-only status for browser checks; no titles are exposed to the UI. */
        status: function () {
            var counts = {}, keys = cache && cache.picks ? Object.keys(cache.picks) : [];
            for (var i = 0; i < keys.length; i++) counts[keys[i]] = cache.picks[keys[i]].length;
            return { country: cache && cache.country || "", at: cache && cache.at || 0, counts: counts, loading: loading };
        }
    };
}(window));
