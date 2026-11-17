/* ============================================================
   search.js — Search, the Apple TV way (CleanFrame style).

   Search field at top. Letter grid below. Matching apps in a row.
   Films & shows in horizontal rows (Movies, TV Shows) — CleanFrame style.
   Remote digits and PC keyboard type into the field.
   Opened with ▲ from full screen Top Shelf or Control Center.
   ============================================================ */
(function (global) {
    "use strict";

    var APL = global.APL, K = APL.KEY;
    var root, fieldEl, keysEl, resultsEl, emptyEl, filmsEl, filmHead, noteEl, nav;
    var isOpen = false, query = "", keys = [], found = [];
    var appTiles = [], filmTiles = [], filmToken = 0, filmTimer = null;

    /* PC preview: mouse clicks what remote does — magnifier opens Search,
       a letter types it, a tile opens. On TV the keys are the only input. */
    function clickable(node, fn) {
        if (!APL.sys.PREVIEW) return;
        node.style.pointerEvents = "auto";
        node.addEventListener("click", function (e) { e.preventDefault(); fn(); });
    }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }
    /* Lowercase, without accents: "é" finds "e", "Arte" finds "arte". */
    function norm(s) {
        s = String(s || "").toLowerCase();
        return s.normalize ? s.normalize("NFD").replace(/[̀-ͯ]/g, "") : s;
    }

    function candidates() {
        var hidden = APL.sys.pref("searchHidden") ? [] : APL.sys.pref("hiddenApps") || [];
        return ((APL.allApps && APL.allApps()) || []).filter(function (a) {
            return !a.folder && hidden.indexOf(a.id) === -1;
        });
    }
    /* Fuzzy match: exact prefix > word prefix > substring > fuzzy (distance <= 2) */
    function match(q) {
        var all = candidates();
        if (!q) {
            var recent = APL.sys.pref("recentApps") || [];
            return recent.map(function (id) { return all.filter(function (a) { return a.id === id; })[0]; }).filter(Boolean);
        }
        var start = [], word = [], inside = [], fuzzy = [];
        all.forEach(function (a) {
            var n = norm(a.name), at = n.indexOf(q);
            if (at === 0) start.push(a);
            else if (at > 0 && (" " + n).indexOf(" " + q) !== -1) word.push(a);
            else if (at > 0) inside.push(a);
            else if (levenshtein(n, q) <= 2 || (n.length > q.length && levenshtein(n.substr(0, q.length + 1), q) <= 2)) fuzzy.push(a);
        });
        return start.concat(word, inside, fuzzy);
    }
    /* Levenshtein distance for fuzzy matching */
    function levenshtein(a, b) {
        var m = a.length, n = b.length, d = [], i, j;
        if (!m) return n; if (!n) return m;
        for (i = 0; i <= m; i++) d[i] = [i];
        for (j = 0; j <= n; j++) d[0][j] = j;
        for (i = 1; i <= m; i++) {
            for (j = 1; j <= n; j++) {
                d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] :
                    Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]) + 1;
            }
        }
        return d[m][n];
    }

    function appsByKey() {
        var map = {};
        ((APL.allApps && APL.allApps()) || []).forEach(function (a) { if (a.key) map[a.key] = a; });
        return map;
    }

    function buildDom() {
        root = el("section", "search");
        root.appendChild(el("div", "search__dim"));
        fieldEl = el("div", "search__field");
        keysEl = el("div", "search__keys");
        resultsEl = el("div", "search__results");
        emptyEl = el("p", "search__empty");
        filmHead = el("p", "search__films-head", APL.t("Movies & shows"));
        filmsEl = el("div", "search__films");
        noteEl = el("p", "search__note");
        root.appendChild(fieldEl); root.appendChild(keysEl); root.appendChild(resultsEl);
        root.appendChild(emptyEl); root.appendChild(filmHead); root.appendChild(filmsEl);
        root.appendChild(noteEl);
        if (APL.sys.PREVIEW && (!APL.live || !APL.live.keys || !APL.live.keys().tmdb)) {
            noteEl.textContent = APL.t("Preview: demo titles. Add a TMDB key in js/keys.local.js for the real ones.");
        }
        document.body.appendChild(root);

        var LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
        LETTERS.forEach(function (c) { keys.push({ type: c, label: c }); });
        keys.push({ type: " ", label: APL.t("Space"), wide: true });
        keys.push({ del: true, label: APL.t("Delete"), wide: true });
        keys.forEach(function (k) {
            var t = el("div", "search__key" + (k.wide ? " search__key--wide" : ""), k.label);
            k.el = t;
            keysEl.appendChild(t);
            clickable(t, function () { press(k); });
        });

        nav = new APL.Nav({
            onSelect: function (i) {
                var t = nav.tiles[i];
                if (t._key) { press(t._key); return; }
                if (t._film) { openFilm(t._film, t._filmApp); return; }
                if (t._app) { var app = t._app; close(); APL.openApp(app); }
            },
            onBack: close,
            onKey: function (code, e) {
                if (code >= 48 && code <= 57) { type(String(code - 48)); return true; }
                if (code === K.BACKSPACE && e.key === "Backspace") { erase(); return true; }
                if (e.key && e.key.length === 1 && /[\w ]/.test(e.key)) { type(norm(e.key)); return true; }
                return false;
            }
        });
    }

    function press(k) { if (k.del) erase(); else type(k.type); }
    function type(c) { if (query.length < 30) { query += c; refresh(); } }
    function erase() { if (query) { query = query.slice(0, -1); refresh(); } }

    function allTiles() {
        return keys.map(function (k) { return k.el; }).concat(appTiles, filmTiles);
    }
    function relayout(keep) {
        var list = allTiles(), at = keep ? list.indexOf(keep) : -1, cur = nav.current && nav.current();
        if (at < 0 && cur) at = list.indexOf(cur);
        nav.setTiles(list);
        nav.focus(at >= 0 ? at : 0);
    }

    function filmTile(f, app) {
        var t = el("div", "search__film");
        var art = f.backdrop || f.poster;
        if (art) t.style.backgroundImage = "url('" + art + "')";
        t.appendChild(el("span", "search__film__title", f.title + (f.year ? " (" + f.year + ")" : "")));
        t.appendChild(el("span", "search__film__app", app.name));
        t._film = f;
        t._filmApp = app;
        clickable(t, function () { openFilm(f, app); });
        return t;
    }

    function setFilms(list) {
        var by = appsByKey(), keep = nav.current && nav.current();
        filmsEl.innerHTML = "";
        filmTiles = [];
        (list || []).forEach(function (f) {
            var app = null;
            (f.providers || []).some(function (p) { if (p.key && by[p.key]) { app = by[p.key]; return true; } return false; });
            if (!app) return;
            var t = filmTile(f, app);
            filmTiles.push(t);
            filmsEl.appendChild(t);
        });
        var on = filmTiles.length > 0;
        filmsEl.style.display = on ? "" : "none";
        filmHead.style.display = on ? "" : "none";
        if (on) emptyEl.textContent = "";
        relayout(keep);
    }

    function askFilms(q) {
        clearTimeout(filmTimer);
        var token = ++filmToken;
        if (!APL.live || !APL.live.searchTitles || q.length < 2) return;
        filmTimer = setTimeout(function () {
            APL.live.searchTitles(q).then(function (list) {
                if (token === filmToken) setFilms(list || []);
            }, function () { if (token === filmToken) setFilms([]); });
        }, 450);
    }

    function refresh() {
        var q = norm(query).replace(/\s+/g, " ").replace(/^ /, "");
        fieldEl.textContent = query || APL.t("Search");
        fieldEl.classList.toggle("is-empty", !query);
        found = match(q);
        var shown = q && found.length > 6 ? found.slice(0, 6) : found;
        resultsEl.innerHTML = "";
        appTiles = shown.map(function (app) {
            var t = APL.makeTile(app, 1);
            t._app = app;
            resultsEl.appendChild(t);
            clickable(t, function () { close(); APL.openApp(app); });
            return t;
        });
        emptyEl.textContent = !q ? (found.length ? APL.t("Recently Used") : "") :
            found.length ? "" : APL.t("No apps found for “{q}”", { q: query.trim() });
        root.classList.toggle("has-recent", !q && found.length > 0);
        clearTimeout(filmTimer);
        filmToken++;
        setFilms([]);
        askFilms(q);
    }

    function openFilm(f, app) {
        close();
        if (APL.sys.PREVIEW) {
            APL.toast(APL.t("Preview: on your TV, “{title}” would open in {app}", { title: f.title, app: app.name }));
            return;
        }
        if (f.link && APL.launchDeepLink) {
            APL.launchDeepLink(app.id, f.link).catch(function () { APL.launchApp(app.id).catch(failed); });
            return;
        }
        APL.launchApp(app.id).catch(failed);
    }
    function failed(e) { APL.toast((e && e.message) || APL.t("Couldn't open the app")); }

    function open() {
        if (!root) buildDom();
        query = "";
        nav.setTiles([]);
        refresh();
        nav.focus(0);
        root.classList.add("is-open");
        document.body.classList.add("has-search");
        APL.pushNav(nav);
        isOpen = true;
    }
    function close() {
        if (!isOpen) return;
        root.classList.remove("is-open");
        document.body.classList.remove("has-search");
        APL.popNav(nav);
        isOpen = false;
    }

    function addHint() {
        var h = el("div", "search-hint");
        h.innerHTML = '<span class="search-hint__chevron"></span>' + APL.icon("search", 30, 2.4);
        h.appendChild(el("span", "search-hint__text", APL.t("Search")));
        clickable(h, open);
        document.body.appendChild(h);
    }
    if (document.body) addHint(); else document.addEventListener("DOMContentLoaded", addHint);

    APL.search = { open: open, close: close, isOpen: function () { return isOpen; } };
})(window);