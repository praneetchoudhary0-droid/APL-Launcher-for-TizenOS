/* ============================================================
   glass.js — pre-blurred glass for the dock and Control Center.

   The dock and the Control Center tiles used backdrop-filter. On a
   Tizen set that is the most expensive thing on screen: the blur is
   re-run every time a tile scales on focus or a panel slides in. This
   freezes the backdrop once per artwork (a 48x27 copy upscaled to a
   480x270 tile, so the downscale itself is the blur, enlarged a
   quarter and 5% brighter), then shows the slice that sits under each
   surface. Opening a panel, moving focus or changing the artwork then
   only changes background-position: nothing filters, and nothing is
   drawn per frame.

     src()      the frozen backdrop in use ("" when there is none)
     lens(x,y)  the background-position for a stage point
     offset(el) stage rectangle of an element, ignoring transforms
     paint()    re-slice every surface now
     refresh()  re-read the artwork, then paint (debounced)
     setSource(url)  force an artwork (a page that is not the Home
                     Screen, e.g. a fixed backdrop); release() undoes it.
     onChange(fn)    called with the new backdrop ("" when there is
                     none), for a sheet that shows it full-frame.

   Everything is behind body.glass, added here, so the skin can be
   switched off and the old translucent fills come straight back.
   ============================================================ */
(function (global) {
    "use strict";

    var APL = global.APL = global.APL || {};

    var BAKE_W = 480, BAKE_H = 270;      /* 1/4 of the stage */
    var TINY_W = 48, TINY_H = 27;        /* 1/40: two steps down, no filter */
    var ZOOM = 1.25;                     /* the backdrop is enlarged behind the glass */
    var LIGHT = 1.05;                    /* 5% above the picture: lit, never washed out */

    /* Every surface that should read as a lens. Add a selector here and it
       gets the material, with no other change. */
    var TARGETS = [
        ".dock",
        ".cc__t"
    ];

    var baked = "";          /* data URL of the frozen backdrop */
    var bakedFrom = "";      /* the artwork it was made from */
    var queued = "";         /* artwork being prepared right now */
    var forced = "";         /* setSource() override */
    var timer = 0;
    var settle = 0;          /* second look, once the new backdrop has faded in */
    var body = null;

    function $(id) { return document.getElementById(id); }

    function urlOf(el) {
        if (!el) return "";
        var bg = global.getComputedStyle(el).backgroundImage || "";
        var m = /url\(["']?([^"')]+)["']?\)/.exec(bg);
        return m ? m[1] : "";
    }

    /* The artwork on screen. A generated brand card has no URL (it is a
       gradient), and those keep the plain translucent fill: an empty
       answer is a valid answer. */
    function scene() {
        /* The layer actually on screen: the dock keeps one prepared .bg per app,
           and those are the ones that carry the artwork, not #bgA/#bgB. */
        return urlOf(document.querySelector(".bg.is-active")) ||
               urlOf($("bgA")) || urlOf($("bgB")) || urlOf($("bgBlur"));
    }

    /* One frozen copy per artwork. The second canvas is the only "blur":
       drawing 48x27 into 480x270 is a 10x upscale, which the compositor
       smooths for free. */
    function bake(src, done) {
        if (!src) { drop(); return; }
        if (src === bakedFrom && baked) { paint(); if (done) done(); return; }
        if (src === queued) return;
        queued = src;
        var img = new global.Image();
        img.onload = function () {
            queued = "";
            try {
                /* The glass enlarges what sits behind it by a quarter: sample
                   the middle 80% of the artwork, so every slice is a 1.25x
                   crop of the backdrop and the edges of the pane never show
                   the pixels the surface used to sit on. */
                var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
                var sw = iw / ZOOM, sh = ih / ZOOM;

                var tiny = document.createElement("canvas");
                tiny.width = TINY_W;
                tiny.height = TINY_H;
                tiny.getContext("2d").drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, TINY_W, TINY_H);

                var out = document.createElement("canvas");
                out.width = BAKE_W;
                out.height = BAKE_H;
                var c = out.getContext("2d");
                c.imageSmoothingEnabled = true;
                if ("imageSmoothingQuality" in c) c.imageSmoothingQuality = "high";
                /* Brightness is baked once here: no filter, no redraw, on the
                   TV's animation path. */
                if ("filter" in c) c.filter = "brightness(" + LIGHT + ")";
                c.drawImage(tiny, 0, 0, BAKE_W, BAKE_H);

                baked = out.toDataURL("image/jpeg", 0.72);
                bakedFrom = src;
                forget();
                paint();
                notify();
                if (done) done();
            } catch (e) { queued = ""; }
        };
        img.onerror = function () { queued = ""; };
        /* A poster from the catalogue lives on images.justwatch.com: without
           this the canvas is tainted, toDataURL throws, and every lens would
           quietly disappear behind remote artwork. */
        if (!/^(data:|blob:)/i.test(src)) img.crossOrigin = "anonymous";
        img.src = src;
    }

    /* No artwork: hide every lens and leave the CSS fills in charge. */
    function drop() {
        var list = document.querySelectorAll(TARGETS.join(",")), i, l;
        baked = "";
        bakedFrom = "";
        for (i = 0; i < list.length; i++) {
            l = list[i].__cgLayer;
            if (l) l.classList.remove("is-on");
            list[i].__cgKey = "";
        }
        notify();
    }

    function notify() {
        if (typeof api.onChange === "function") api.onChange(baked);
    }

    function forget() {
        var list = document.querySelectorAll(TARGETS.join(",")), i;
        for (i = 0; i < list.length; i++) list[i].__cgKey = "";
    }

    /* The layer is inserted, never written into the surface's own
       background: the tiles keep their tint, their ::after sheen and the
       white plate on focus, and the text simply sits above it. */
    function layerFor(el) {
        var l = el.__cgLayer;
        if (l && l.parentNode === el) return l;
        l = document.createElement("i");
        l.className = "cg__glass";
        l.setAttribute("aria-hidden", "true");
        el.insertBefore(l, el.firstChild);
        el.__cgLayer = l;
        el.__cgKey = "";
        return l;
    }

    /* Stage rectangle from layout offsets. A focused tile is scaled and a
       panel slides in, so a client rect would sample the transformed box
       and leave the slice a few pixels off; offsets ignore all of that. */
    function offset(el) {
        var x = 0, y = 0, n = el;
        while (n && n !== body && n !== document.documentElement) {
            x += n.offsetLeft;
            y += n.offsetTop;
            n = n.offsetParent;
        }
        return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight };
    }

    function lens(x, y) { return (-x) + "px " + (-y) + "px"; }

    function paint() {
        if (!baked) return;
        var list = document.querySelectorAll(TARGETS.join(",")), i, el, r, key, l;
        for (i = 0; i < list.length; i++) {
            el = list[i];
            if (!el.offsetWidth || el.offsetHeight < 4) continue;
            r = offset(el);
            key = r.x + "," + r.y + "," + r.w + "," + r.h;
            l = el.__cgLayer;
            if (el.__cgKey === key && l && l.parentNode === el && l.classList.contains("is-on")) continue;
            el.__cgKey = key;
            l = layerFor(el);
            if (l.__src !== baked) {
                /* New artwork under the glass. A fresh pane is laid on top and
                   fades in over the old one, so the pill and the dock cross into
                   the new show instead of blinking at the swap. */
                var n = document.createElement("i");
                n.className = "cg__glass";
                n.setAttribute("aria-hidden", "true");
                n.__src = baked;
                n.style.backgroundImage = 'url("' + baked + '")';
                n.style.backgroundPosition = lens(r.x, r.y);
                n.style.opacity = "0";
                el.insertBefore(n, l.parentNode === el ? l.nextSibling : el.firstChild);
                void n.offsetWidth;
                n.classList.add("is-on");
                n.style.opacity = "";
                el.__cgLayer = n;
                (function (old) {
                    global.setTimeout(function () { if (old && old.parentNode) old.parentNode.removeChild(old); }, 420);
                })(l);
                l = n;
            } else {
                l.style.backgroundPosition = lens(r.x, r.y);
                l.classList.add("is-on");
            }
        }
    }

    function refresh() {
        global.clearTimeout(timer);
        timer = global.setTimeout(function () {
            var src = forced || scene();
            /* A tile with no artwork of its own (a generated brand card, a
               gradient, an app with no backdrop) used to empty the lens on the
               spot: the glass appeared and was gone a moment later, on every
               move. The last real artwork stays until another one arrives. */
            if (!src) { if (baked) paint(); return; }
            bake(src);
        }, 120);
        /* The backdrop of the app being focused fades in after the key, so the
           first look can still see the app before it: look again once the
           fade is done, or the lens would keep the old artwork. */
        global.clearTimeout(settle);
        settle = global.setTimeout(sync, 520);
    }

    /* Bake again only when the artwork really changed. */
    function sync() {
        var src = forced || scene();
        if (src && src !== bakedFrom) bake(src);
    }

    function setSource(url) { forced = url || ""; refresh(); }

    /* The sheet on a page with no Home Screen behind it: release() really does
       drop the lens, unlike moving focus. */
    function release() {
        forced = "";
        global.clearTimeout(timer);
        timer = global.setTimeout(function () { if (scene()) refresh(); else drop(); }, 120);
    }

    var api = {
        src: function () { return baked; },
        lens: lens,
        offset: offset,
        paint: paint,
        refresh: refresh,
        setSource: setSource,
        release: release
    };
    APL.glass = api;

    /* A page that opens over the Home Screen re-slices after its own layout
       has settled: one call, and its panes carry the material. */
    APL.glassAfter = function (el) {
        global.setTimeout(function () {
            paint();
            if (el && el.classList) el.classList.add("has-glass");
        }, 0);
    };

    /* Settings > Liquid Glass. `perf`, the screen's own light mode, wins:
       it exists to keep the set smooth. */
    function wanted() {
        if (!APL.sys || !APL.sys.pref) return true;
        var v = APL.sys.pref("liquidGlass");
        return v === undefined ? true : !!v;
    }

    function apply() {
        body = document.body;
        if (!body) return;
        var on = wanted() && !body.classList.contains("perf");
        body.classList.toggle("glass", on);
        if (!on) { baked = ""; bakedFrom = ""; drop(); return; }
        refresh();
    }

    function start() {
        apply();
        if (APL.sys && APL.sys.onPref) APL.sys.onPref("liquidGlass", apply);
        if (!body || !body.classList.contains("glass")) return;
        refresh();
        /* The first artwork lands late, and a page that opens over the Home
           Screen asks again once it has: three cheap looks, then silence. */
        [900, 1800, 3000].forEach(function (ms) { global.setTimeout(refresh, ms); });
        document.addEventListener("keydown", refresh, true);
        /* A redrawn tile gets its layer back, and a backdrop that has just
           finished fading gets sliced in place of the one before it. */
        document.addEventListener("keyup", function () { paint(); sync(); }, true);
        document.addEventListener("transitionend", function () { paint(); sync(); }, true);
        /* Surfaces rebuilt while the glass is on (Control Center redraws its
           tiles on every move) get their lens back within a frame: no flash of
           the plain fill, no glass that appears and is gone again. */
        if (global.MutationObserver) {
            var observer = new global.MutationObserver(function () {
                global.clearTimeout(observer._t);
                observer._t = global.setTimeout(paint, 40);
            });
            observer.observe(body, { childList: true, subtree: true });
        }
        global.addEventListener("resize", paint);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})(window);
