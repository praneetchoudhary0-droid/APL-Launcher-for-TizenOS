/* ============================================================
   search.js — Search, the Apple TV way.

   A row of letters at the top, the matching apps below, updated at every
   letter, then the films and series that stream in the screen's country
   (liveshelf.js asks TMDB/JustWatch): OK on one opens the service that has
   it. When no direct link to the title is known, it opens the app, as the
   Home Screen does. OK on a letter types it, OK on an app opens it. The
   remote's digits and a keyboard (PC preview) type too. Opened with ▲ from
   the full screen Top Shelf (▲ from the dock, then ▲ again), or from the
   Control Center. A magnifier at the top left of the Home Screen, across
   from the status pill, shows it's up there; in full screen it reads
   "▲ Search".
   Apps only from the launcher: those in folders too, and the hidden ones
   with Settings › Home Screen › Search Hidden Apps.
   ============================================================ */
(function (global) {
    "use strict";

    var APL = global.APL, K = APL.KEY;
    var LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
    var root, fieldEl, keysEl, resultsEl, emptyEl, filmsEl, filmHead, noteEl, nav;
    var isOpen = false, query = "", keys = [], found = [];
    var appTiles = [], filmTiles = [], filmToken = 0, filmTimer = null;

    /* PC preview: the mouse does what the remote does — the magnifier opens Search,
       a letter types it, a tile opens. On the screen the keys are the only input. */
    function clickable(node, fn) {
        if (!APL.sys.PREVIEW) return;
        node.style.pointerEvents = "auto";        // the rules keep the remote out of it
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
    /* The name's start first, then the start of a word in it, then anywhere. Nothing typed: the recent apps. */
    function match(q) {
        var all = candidates();
        if (!q) {
            var recent = APL.sys.pref("recentApps") || [];
            return recent.map(function (id) { return all.filter(function (a) { return a.id === id; })[0]; }).filter(Boolean);
        }
        var start = [], word = [], inside = [];
        all.forEach(function (a) {
            var n = norm(a.name), at = n.indexOf(q);
            if (at === 0) start.push(a);
            else if (at > 0 && (" " + n).indexOf(" " + q) !== -1) word.push(a);
            else if (at > 0) inside.push(a);
        });
        return start.concat(word, inside);
    }

    /* The catalog's key ("primevideo", "appletv") is what the providers in liveshelf.js name. */
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
        resultsEl = el("div", "search__results");
        emptyEl = el("p", "search__empty");
        filmHead = el("p", "search__films-head", APL.t("Movies & shows"));
        filmsEl = el("div", "search__films");
        noteEl = el("p", "search__note");
        root.appendChild(fieldEl); root.appendChild(resultsEl);
        root.appendChild(emptyEl); root.appendChild(filmHead); root.appendChild(filmsEl);
        root.appendChild(noteEl);
        /* The preview has no TMDB key: say why searching a real film finds nothing. */
        if (APL.sys.PREVIEW && (!APL.live || !APL.live.keys || !APL.live.keys().tmdb)) {
            noteEl.textContent = APL.t("Preview: demo titles. Add a TMDB key in js/keys.local.js for the real ones.");
        }
        document.body.appendChild(root);

        fieldEl.addEventListener("input", refresh);
        fieldEl.addEventListener("keydown", function (e) {
            var c = e.keyCode;
            if (c === K.ENTER || c === K.DOWN && filmTiles.length) { e.preventDefault(); e.stopPropagation(); focusFirstFilm(); }
            else if (c === 27 || c === 10009) { e.preventDefault(); e.stopPropagation(); close(); }
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
                return false;
            }
        });
    }

    function type(c) { if (query.length < 30) { query += c; refresh(); } }
    function erase() { if (query) { query = query.slice(0, -1); refresh(); } }

    function relayout(keep) {
        var list = [fieldEl].concat(appTiles, filmTiles), at = keep ? list.indexOf(keep) : -1, cur = nav.current && nav.current();
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

    /* The films the screen's services have: each one is only shown when its service is installed.
       Shows multiple results per service (up to 12 total). */
    function setFilms(list) {
        var by = appsByKey(), keep = nav.current && nav.current();
        filmsEl.innerHTML = "";
        filmTiles = [];
        var count = 0;
        (list || []).forEach(function (f) {
            if (count >= 12) return;
            var app = null;
            (f.providers || []).some(function (p) { if (p.key && by[p.key]) { app = by[p.key]; return true; } return false; });
            if (!app) return;
            var t = filmTile(f, app);
            filmTiles.push(t);
            filmsEl.appendChild(t);
            count++;
        });
        var on = filmTiles.length > 0;
        filmsEl.style.display = on ? "" : "none";
        filmHead.style.display = on ? "" : "none";
        if (on) emptyEl.textContent = "";
        relayout(keep);
    }

    /* Asked 450 ms after the last letter, and only the last answer is drawn. */
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

    function focusFirstFilm() {
        if (filmTiles.length) {
            nav.focus(1 + appTiles.length); // field + apps = first film index
        }
    }

    /* Field and results again; the focus stays where it is (on the field while typing). */
    function refresh() {
        var q = norm(query).replace(/\s+/g, " ").replace(/^ /, "");
        fieldEl.value = query;
        fieldEl.classList.toggle("is-empty", !query);
        found = match(q);
        var shown = q && found.length > 8 ? found.slice(0, 8) : found;
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
        askFilms(q);
    }

    /* A service that takes the title itself (a payload to APL.launchDeepLink) goes here first.
       Until one is known to work on the screen, OK opens the app, as from the Home Screen. */
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
        document.body.classList.add("has-search");          // the Home Screen steps back (launcher.css)
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

    /* The magnifier at the top left (launcher.css): "▲ Search" in full screen, where ▲ opens it (launcher.js). */
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