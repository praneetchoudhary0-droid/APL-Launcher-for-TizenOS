/* ============================================================
   search.js — Search, the Apple TV way.

   Search field at top. Below: three tabs — Movies, TV Shows, Apps.
   Each tab shows its own results (trending when empty, matches when typed).
   Remote digits and PC keyboard type into the field. ▲ from full-screen
   Top Shelf or Control Center opens it. Magnifier at top left shows it's there.
   ============================================================ */
(function (global) {
    "use strict";

    var APL = global.APL, K = APL.KEY;
    var root, fieldEl, tabsEl, resultsEl, emptyEl, noteEl, nav;
    var isOpen = false, query = "", found = [];
    var appTiles = [], movieTiles = [], showTiles = [], filmToken = 0, filmTimer = null;
    var currentTab = "movies"; // "movies", "shows", "apps"
    var tabButtons = {};

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
        fieldEl = el("input", "search__field");
        fieldEl.type = "text";
        fieldEl.maxLength = 30;
        fieldEl.placeholder = APL.t("Search");
        fieldEl.setAttribute("autocomplete", "off");
        fieldEl.setAttribute("spellcheck", "false");

        tabsEl = el("div", "search__tabs");
        resultsEl = el("div", "search__results");
        emptyEl = el("p", "search__empty");
        noteEl = el("p", "search__note");

        root.appendChild(fieldEl); root.appendChild(tabsEl); root.appendChild(resultsEl);
        root.appendChild(emptyEl); root.appendChild(noteEl);

        if (APL.sys.PREVIEW && (!APL.live || !APL.live.keys || !APL.live.keys().tmdb)) {
            noteEl.textContent = APL.t("Preview: demo titles. Add a TMDB key in js/keys.local.js for the real ones.");
        }
        document.body.appendChild(root);

        /* Build tabs */
        var tabs = [
            { id: "movies", label: APL.t("Movies") },
            { id: "shows", label: APL.t("TV Shows") },
            { id: "apps", label: APL.t("Apps") }
        ];
        tabs.forEach(function (tab) {
            var btn = el("button", "search__tab" + (tab.id === currentTab ? " is-active" : ""), tab.label);
            btn.dataset.tab = tab.id;
            tabButtons[tab.id] = btn;
            tabsEl.appendChild(btn);
            clickable(btn, function () { switchTab(tab.id); });
        });

        fieldEl.addEventListener("input", refresh);
        fieldEl.addEventListener("keydown", function (e) {
            var c = e.keyCode;
            if (c === K.ENTER) {
                e.preventDefault(); e.stopPropagation();
                focusFirstResult();
            } else if (c === 27 || c === 10009) {
                e.preventDefault(); e.stopPropagation(); close();
            } else if (c === K.LEFT || c === K.RIGHT) {
                e.preventDefault(); e.stopPropagation();
                switchTabByKey(c === K.LEFT ? -1 : 1);
            }
        });
        fieldEl.addEventListener("blur", function () { root.classList.remove("is-typing"); });

        nav = new APL.Nav({
            onSelect: function (i) {
                var t = nav.tiles[i];
                if (t._film) { openFilm(t._film, t._filmApp); return; }
                if (t._app) { var app = t._app; close(); APL.openApp(app); }
            },
            onBack: close,
            onKey: function (code, e) {
                if (code >= 48 && code <= 57) { type(String(code - 48)); return true; }
                if (code === K.BACKSPACE && e.key === "Backspace") { erase(); return true; }
                if (e.key && e.key.length === 1 && /[\w ]/.test(e.key)) { type(norm(e.key)); return true; }
                if (code === K.LEFT || code === K.RIGHT) {
                    e.preventDefault(); e.stopPropagation();
                    switchTabByKey(code === K.LEFT ? -1 : 1);
                    return true;
                }
                return false;
            }
        });
    }

    function type(c) { if (query.length < 30) { query += c; refresh(); } }
    function erase() { if (query) { query = query.slice(0, -1); refresh(); } }

    function switchTab(id) {
        if (id === currentTab) return;
        currentTab = id;
        Object.keys(tabButtons).forEach(function (k) {
            tabButtons[k].classList.toggle("is-active", k === id);
        });
        /* Animate results out, then in */
        root.classList.remove("is-open");
        setTimeout(function () {
            refresh();
            requestAnimationFrame(function () {
                root.classList.add("is-open");
            });
        }, 150);
    }
    function switchTabByKey(dir) {
        var order = ["movies", "shows", "apps"];
        var idx = order.indexOf(currentTab);
        var next = order[(idx + dir + order.length) % order.length];
        switchTab(next);
    }

    function relayout(keep) {
        var tiles = [fieldEl];
        if (currentTab === "movies") tiles = tiles.concat(movieTiles);
        else if (currentTab === "shows") tiles = tiles.concat(showTiles);
        else tiles = tiles.concat(appTiles);
        var at = keep ? tiles.indexOf(keep) : -1, cur = nav.current && nav.current();
        if (at < 0 && cur) at = tiles.indexOf(cur);
        nav.setTiles(tiles);
        nav.focus(at >= 0 ? at : 0);
    }

    function filmTile(f, app, kind) {
        var t = el("div", "search__film");
        var poster = el("div", "search__film__poster");
        var art = f.poster || f.backdrop;
        if (art) poster.style.backgroundImage = "url('" + art + "')";
        t.appendChild(poster);
        var meta = el("div", "search__film__meta");
        meta.appendChild(el("span", "search__film__title", f.title + (f.year ? " (" + f.year + ")" : "")));
        meta.appendChild(el("span", "search__film__app", app.name));
        t.appendChild(meta);
        t._film = f;
        t._filmApp = app;
        t._kind = kind;
        clickable(t, function () { openFilm(f, app); });
        return t;
    }

    function setFilms(list) {
        var by = appsByKey(), keep = nav.current && nav.current();
        resultsEl.innerHTML = "";
        movieTiles = [];
        showTiles = [];
        var movieCount = 0, showCount = 0;
        (list || []).forEach(function (f) {
            var app = null;
            (f.providers || []).some(function (p) { if (p.key && by[p.key]) { app = by[p.key]; return true; } return false; });
            if (!app) return;
            var kind = f.kind || (f.media_type === "tv" ? "tv" : "movie");
            var t = filmTile(f, app, kind);
            if (kind === "tv" && showCount < 20) {
                showTiles.push(t);
                showCount++;
                resultsEl.appendChild(t);
            } else if (kind === "movie" && movieCount < 20) {
                movieTiles.push(t);
                movieCount++;
                resultsEl.appendChild(t);
            }
        });
        var hasMovies = movieTiles.length > 0;
        var hasShows = showTiles.length > 0;
        var on = hasMovies || hasShows;
        if (on) {
            var q = norm(query).replace(/\s+/g, " ").replace(/^ /, "");
            emptyEl.textContent = "";
        }
        relayout(keep);
    }

    function askFilms(q, kind) {
        clearTimeout(filmTimer);
        var token = ++filmToken;
        if (!APL.live || !APL.live.searchTitles) return;
        filmTimer = setTimeout(function () {
            APL.live.searchTitles(q, kind).then(function (list) {
                if (token === filmToken) setFilms(list || []);
            }, function () { if (token === filmToken) setFilms([]); });
        }, 450);
    }

    function focusFirstResult() {
        var tiles = [];
        if (currentTab === "movies") tiles = movieTiles;
        else if (currentTab === "shows") tiles = showTiles;
        else tiles = appTiles;
        if (tiles.length) nav.focus(1); // 0 = field, 1 = first result
    }

    function refresh() {
        var q = norm(query).replace(/\s+/g, " ").replace(/^ /, "");
        fieldEl.value = query;
        fieldEl.classList.toggle("is-empty", !query);
        found = match(q);
        var shown = q && found.length > 12 ? found.slice(0, 12) : found;
        if (currentTab === "apps") {
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
            relayout();
        } else {
            var kind = currentTab === "movies" ? "movie" : "tv";
            askFilms(q, kind);
        }
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
        currentTab = "movies";
        nav.setTiles([]);
        refresh();
        nav.focus(0);
        root.classList.add("is-open");
        document.body.classList.add("has-search");
        APL.pushNav(nav);
        isOpen = true;
        askFilms("", "movie");
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