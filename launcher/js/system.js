/* ============================================================
   system.js — Samsung hardware access + launcher preferences.

   APIs used (all available to a non-partner Tizen app):
     tizen.tvaudiocontrol      volume, mute, audio output format
     webapis.productinfo       model, firmware
     webapis.network           connection type, SSID, IP, MAC, DNS…
     tizen.systeminfo          storage, display, Tizen version
     tizen.tvinputdevice       Play/Pause, color and Info keys
   Remote keys, picture, Game Mode: root commands through Vetro
   (via the private bridge, bridge/service.js). Without Vetro, the local
   network remote (ws://127.0.0.1:8001) puts the screen to sleep: the first
   time, the screen asks whether to allow APL Launcher, which must be accepted.

   On PC (preview), everything is simulated and marked "(preview)".
   ============================================================ */
(function (global) {
    "use strict";

    var tz = global.tizen;
    var wa = global.webapis;
    var PREVIEW = !tz;
    var APL = global.APL;

    /* ---------- preferences (stored on the screen) ---------- */
    var DEFAULTS = {
        profileName: "",            // first name shown in Control Center (Settings)
        clock24: true,
        showHint: true,
        reduceMotion: false,
        dnd: false,
        sleepTimer: 0,              // minutes, 0 = off
        sleepAt: 0,                 // timestamp of the scheduled sleep
        screensaverDelay: 5,        // minutes, 0 = never
        screensaverStyle: "aerial", // "aerial" (Apple videos) | "art" (app artwork) | "dark"
        uiSounds: true,             // small navigation clicks, like on Apple TV
        hiddenApps: [],
        appOrder: [],
        sourceDevices: {},          // device chosen for each input (Sources screen)
        sourcePorts: null,          // the screen's HDMI ports, read through Vetro (sources.js)
        pinnedSources: [],          // inputs shown on the Home Screen as tiles (sources.js)
        autoUpdate: true,           // launcher updates from GitHub, on their own
        autoArt: true,              // logos, backgrounds and content found automatically (App Store, TMDB)
        appsPerRow: 6,              // dock and grid: 5, 6 or 7 (launcher.js sizes())
        searchHidden: false,        // Search also finds the hidden apps (search.js)
        shelfArt: "sheets",         // Top Shelf of apps without artwork: "sheets" | "logo" | "black" (genart.js, launcher.js)
        smartHubTileSet: false,     // the Smart Hub tile was hidden once in this profile (it starts hidden)
        hubShelf: true,             // Top Shelf: the apps' own Smart Hub rows first (liveshelf.js)
        liveShelf: true,            //   then the content of the moment (TMDB / YouTube…), then shelfArt
        liquidGlass: true,          // dock and Control Center slice the picture under them (glass.js)
        dynamicBackdrops: true,     // an app with no artwork gets the storefront's trending frame (backdrops.js)
        visualEffects: PREVIEW,     // blur / glass: costly on the screen, off by default
        gameWanted: false,          // Game Mode requested (applied when switching to an input)
        ccHintCount: 0,             // number of times the Control Center tip has been shown
        appearance: "dark",         // "dark" | "light" | "auto" (follows the sun)
        folders: [],                // Home Screen folders: { id, name, apps: [ids] }
        aerialHidden: [],           // themes and places hidden from the Aerial screen saver
        bgMotion: false,            // slow background motion: costs more than one CPU core when idle
        homeReturn: true,           // when an app closes: the launcher rather than the Samsung home
        alexaBridge: true,          // the Echo Dot can open apps (overlay/Alexa.cs)
        servicesCut: {},            // blocked Samsung services and their original settings (services.js)
        bootCleanup: true,          // once per power-on: closes what Samsung opens on its own
        homeAppSaved: null,         // { home, autostart } before "Start on APL Launcher", put back when it is turned off
        idleClose: true,            // an app left in the background for 10 min is closed (overlay/IdleApps.cs)
        pauseKey: "controlcenter",  // ⏯ in an app: "controlcenter" | "playpause", the app's own (overlay/Program.cs)
        language: "auto"            // "auto" (screen language) | "en" | "fr": read at start-up by i18n.js
    };
    /* Screen settings (shared) and the settings of each profile in the household:
       Home Screen layout, hidden apps, preferences, recent apps. */
    var PROFILE_KEYS = { hiddenApps: 1, appOrder: 1, clock24: 1, showHint: 1, reduceMotion: 1, dnd: 1,
                         uiSounds: 1, screensaverStyle: 1, screensaverDelay: 1, liveShelf: 1, hubShelf: 1, recentApps: 1,
                         appearance: 1, folders: 1, aerialHidden: 1, smartHubTileSet: 1 };
    DEFAULTS.recentApps = [];
    var COLORS = ["#ff9f0a", "#30d158", "#0a84ff", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a", "#ac8e68"];
    function load(k, fallback) {
        try { var v = JSON.parse(global.localStorage.getItem(k) || "null"); return v || fallback; } catch (e) { return fallback; }
    }
    function save(k, v) { try { global.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

    var prefs = load("apl.prefs", {});
    var household = load("apl.profiles", null);
    if (!household || !household.list || !household.list.length) {
        // First launch with profiles: the current settings become those of the first profile
        household = { current: "p1", list: [{ id: "p1", name: prefs.profileName || APL.t("Me"), color: COLORS[2] }] };
        var first = {};
        Object.keys(PROFILE_KEYS).forEach(function (k) { if (k in prefs) first[k] = prefs[k]; });
        save("apl.prefs.p1", first);
        save("apl.profiles", household);
    }
    var pprefs = load("apl.prefs." + household.current, {});
    // Up to 1.0.19, Otherwise also had App Colors (now Large Logo) and the APL wallpaper (now Black)
    var OLD_ART = { colors: "logo", wallpaper: "black", all: "black" };
    if (OLD_ART[prefs.shelfArt]) { prefs.shelfArt = OLD_ART[prefs.shelfArt]; save("apl.prefs", prefs); }
    // Up to 1.0.14, "App Backgrounds" off (per profile) gave a plain dark Top Shelf: now shelfArt "black"
    household.list.forEach(function (p) {
        var pp = p.id === household.current ? pprefs : load("apl.prefs." + p.id, {});
        if (!("appBackgrounds" in pp)) return;
        if (pp.appBackgrounds === false && p.id === household.current) { prefs.shelfArt = "black"; save("apl.prefs", prefs); }
        delete pp.appBackgrounds;
        save("apl.prefs." + p.id, pp);
    });

    function currentProfile() {
        for (var i = 0; i < household.list.length; i++) if (household.list[i].id === household.current) return household.list[i];
        return household.list[0];
    }
    function pref(k) {
        if (k === "profileName") return currentProfile().name;
        var src = PROFILE_KEYS[k] ? pprefs : prefs;
        return (k in src) ? src[k] : DEFAULTS[k];
    }
    function setPref(k, v) {
        if (k === "profileName") { currentProfile().name = v; save("apl.profiles", household); }
        else if (PROFILE_KEYS[k]) { pprefs[k] = v; save("apl.prefs." + household.current, pprefs); }
        else { prefs[k] = v; save("apl.prefs", prefs); }
        (listeners[k] || []).forEach(function (fn) { fn(v); });
    }
    var listeners = {};
    function onPref(k, fn) { (listeners[k] = listeners[k] || []).push(fn); }

    /* ---------- profiles ---------- */
    var profileListeners = [];
    var profiles = {
        list: function () { return household.list.slice(); },
        current: currentProfile,
        colors: COLORS,
        switchTo: function (id) {
            if (id === household.current) return;
            household.current = id;
            save("apl.profiles", household);
            pprefs = load("apl.prefs." + id, {});
            Object.keys(PROFILE_KEYS).forEach(function (k) { (listeners[k] || []).forEach(function (fn) { fn(pref(k)); }); });
            profileListeners.forEach(function (fn) { fn(currentProfile()); });
        },
        add: function (name) {
            var n = 1, id;
            do { id = "p" + (++n); } while (household.list.some(function (p) { return p.id === id; }));
            var p = { id: id, name: name || APL.t("Profile {n}", { n: household.list.length + 1 }), color: COLORS[household.list.length % COLORS.length] };
            household.list.push(p);
            save("apl.profiles", household);
            return p;
        },
        update: function (id, fields) {
            household.list.forEach(function (p) { if (p.id === id) Object.keys(fields).forEach(function (k) { p[k] = fields[k]; }); });
            save("apl.profiles", household);
            profileListeners.forEach(function (fn) { fn(currentProfile()); });
        },
        remove: function (id) {
            if (household.list.length < 2) return false;
            household.list = household.list.filter(function (p) { return p.id !== id; });
            try { global.localStorage.removeItem("apl.prefs." + id); } catch (e) {}
            if (household.current === id) profiles.switchTo(household.list[0].id);
            save("apl.profiles", household);
            return true;
        },
        onChange: function (fn) { profileListeners.push(fn); },
        /* History: the last apps opened by this profile */
        noteLaunch: function (appId) {
            var r = (pref("recentApps") || []).filter(function (x) { return x !== appId; });
            r.unshift(appId);
            setPref("recentApps", r.slice(0, 12));
        }
    };

    function safe(fn, fallback) { try { var v = fn(); return (v === undefined || v === null || v === "") ? fallback : v; } catch (e) { return fallback; } }

    /* ---------- sound ---------- */
    var mock = { volume: 18, mute: false };
    var audio = {
        getVolume: function () { return PREVIEW ? mock.volume : safe(function () { return tz.tvaudiocontrol.getVolume(); }, 0); },
        setVolume: function (v) {
            v = Math.max(0, Math.min(100, Math.round(v)));
            if (PREVIEW) { mock.volume = v; return v; }
            safe(function () { tz.tvaudiocontrol.setVolume(v); });
            return audio.getVolume();
        },
        isMute: function () { return PREVIEW ? mock.mute : safe(function () { return tz.tvaudiocontrol.isMute(); }, false); },
        setMute: function (m) { if (PREVIEW) mock.mute = m; else safe(function () { tz.tvaudiocontrol.setMute(m); }); },
        outputMode: function () {
            var m = PREVIEW ? "PCM" : safe(function () { return tz.tvaudiocontrol.getOutputMode(); }, "—");
            return { PCM: "PCM", DOLBY: "Dolby Digital", DTS: "DTS", AAC: "AAC", DOLBY_DIGITAL_PLUS: "Dolby Digital+" }[m] || m;
        }
    };

    /* ---------- network ---------- */
    function network() {
        if (PREVIEW) return { connected: true, type: "Wi-Fi", ssid: APL.t("Livebox-(preview)"), signal: 4, ip: "192.168.1.50", mac: "XX:XX:XX:XX:XX:XX", gateway: "192.168.1.1", dns: "192.168.1.1" };
        var n = wa && wa.network;
        var t = safe(function () { return n.getActiveConnectionType(); }, -1);
        var type = { 0: APL.t("Disconnected"), 1: "Wi-Fi", 2: "Ethernet", 3: "Mobile" }[t] || APL.t("Unknown");
        return {
            connected: t > 0,
            type: type,
            ssid: t === 1 ? safe(function () { return n.getWiFiSsid(); }, "—") : "—",
            signal: t === 1 ? safe(function () { return n.getWiFiSignalStrengthLevel(); }, 0) : 0,
            ip: safe(function () { return n.getIp(); }, "—"),
            mac: safe(function () { return n.getMac(); }, "—"),
            gateway: safe(function () { return n.getGateway(); }, "—"),
            dns: safe(function () { return n.getDns(); }, "—")
        };
    }

    /* ---------- device ---------- */
    function product() {
        if (PREVIEW) return { model: "LS32CM801UUXEN", name: APL.t("Smart Monitor M8 (preview)"), firmware: "T-PTMLCWWC-0090", tizen: "9.0" };
        var p = wa && wa.productinfo;
        return {
            model: safe(function () { return p.getRealModel(); }, safe(function () { return p.getModel(); }, "—")),
            name: safe(function () { return p.getModel(); }, APL.t("Samsung screen")),
            firmware: safe(function () { return p.getFirmware(); }, "—"),
            tizen: safe(function () { return tz.systeminfo.getCapability("http://tizen.org/feature/platform.version"); }, "—")
        };
    }

    /* Apps are drawn in 1920 × 1080 (the screen offers them no other mode), while the panel and
       the videos can be 4K or 8K: both are shown. */
    function display() {
        return new Promise(function (resolve) {
            if (PREVIEW) return resolve(APL.t("3840 × 2160 (preview)"));
            var p = wa && wa.productinfo;
            var panel = safe(function () { return p.is8KPanelSupported() ? "7680 × 4320" : ""; }, "") ||
                        safe(function () { return p.isUdPanelSupported() ? "3840 × 2160" : ""; }, "");
            try {
                tz.systeminfo.getPropertyValue("DISPLAY", function (d) {
                    var ui = d.resolutionWidth + " × " + d.resolutionHeight;
                    resolve(panel && panel !== ui ? APL.t("{panel} (interface {ui})", { panel: panel, ui: ui }) : ui);
                }, function () { resolve(panel || "—"); });
            } catch (e) { resolve(panel || "—"); }
        });
    }

    function gb(bytes) { var n = (bytes / 1e9).toFixed(1); return APL.t("{n} GB", { n: APL.lang === "fr" ? n.replace(".", ",") : n }); }
    function storage() {
        return new Promise(function (resolve) {
            if (PREVIEW) return resolve(APL.t("4.1 GB free of 8.0 GB (preview)"));
            try {
                tz.systeminfo.getPropertyValue("STORAGE", function (s) {
                    var u = (s.units || [])[0];
                    resolve(u ? APL.t("{free} free of {total}", { free: gb(u.availableCapacity), total: gb(u.capacity) }) : "—");
                }, function () { resolve("—"); });
            } catch (e) { resolve("—"); }
        });
    }

    function hdr() {
        if (PREVIEW) return APL.t("Supported");
        return safe(function () { return wa.avinfo.isHdrTvSupport() ? APL.t("Supported") : APL.t("Not supported"); }, "—");
    }

    /* ---------- remote keys ----------
       Simulated by Vetro, as root (/usr/bin/input_keyevent, like Vetro's
       launcher). Samsung's network remote (WebSocket 8001/8002) does not answer
       on every screen: it is now only a fallback, without Vetro. */
    var XKEYS = { KEY_MENU: "XF86Menu", KEY_POWER: "XF86PowerOff", KEY_SOURCE: "XF86Display", KEY_HOME: "XF86Home",
                  KEY_RETURN: "XF86Back", KEY_EXIT: "XF86Exit", KEY_INFO: "XF86Info" };
    function remoteKey(key) {
        if (PREVIEW) return Promise.reject(new Error(APL.t("PC preview: {key} not sent", { key: key })));
        var x = XKEYS[key] || key;
        if (!/^[A-Za-z0-9]+$/.test(x)) return Promise.reject(new Error(APL.t("Unknown key: {key}", { key: key })));
        return vetroAlive().then(function (ok) {
            if (!ok) return wsRemoteKey(key);
            return vetroPost("/exec", { cmd: "/usr/bin/input_keyevent " + x + " 2>&1" }).then(function (r) {
                if (r && r.ok === false) throw new Error(APL.t("The screen refused the key ({key})", { key: x }));
            });
        });
    }

    /* Fallback without Vetro: Samsung's network remote. */
    var TOKEN_KEY = "apl.remoteToken";
    function wsRemoteKey(key) {
        return new Promise(function (resolve, reject) {
            var name = global.btoa("APL Launcher");
            var token = "";
            try { token = global.localStorage.getItem(TOKEN_KEY) || ""; } catch (e) {}
            var urls = [
                "ws://127.0.0.1:8001/api/v2/channels/samsung.remote.control?name=" + name,
                "wss://127.0.0.1:8002/api/v2/channels/samsung.remote.control?name=" + name + (token ? "&token=" + token : "")
            ];
            (function attempt(i) {
                if (i >= urls.length) { reject(new Error(APL.t("Vetro is not responding (open Vetro once on the screen)"))); return; }
                var done = false, ws;
                var timer = setTimeout(function () { if (!done) { done = true; try { ws.close(); } catch (e) {} attempt(i + 1); } }, 5000);
                try { ws = new global.WebSocket(urls[i]); } catch (e) { clearTimeout(timer); attempt(i + 1); return; }
                ws.onmessage = function (m) {
                    var d = {};
                    try { d = JSON.parse(m.data); } catch (e) {}
                    if (d.event === "ms.channel.connect") {
                        if (d.data && d.data.token) { try { global.localStorage.setItem(TOKEN_KEY, d.data.token); } catch (e) {} }
                        ws.send(JSON.stringify({ method: "ms.remote.control", params: {
                            Cmd: "Click", DataOfCmd: key, Option: "false", TypeOfRemote: "SendRemoteKey" } }));
                        done = true; clearTimeout(timer);
                        setTimeout(function () { try { ws.close(); } catch (e) {} resolve(); }, 400);
                    } else if (d.event === "ms.channel.unauthorized") {
                        done = true; clearTimeout(timer); reject(new Error(APL.t("Access denied on the screen")));
                    }
                };
                ws.onerror = function () { if (!done) { done = true; clearTimeout(timer); attempt(i + 1); } };
            })(0);
        });
    }

    /* Opens Samsung's Settings menu, for the settings the launcher does not handle itself. */
    function openSamsungSettings(path) {
        return tvExec("app_launcher -s org.tizen.menu >/dev/null 2>&1; true").then(function () { return path; });
    }
    function sleepNow() { return remoteKey("KEY_POWER"); }

    /* Switch to an input, like Samsung's Source tile (and Vetro's launcher):
       tv-viewer is asked to show input number `type` (TV 0, HDMI 1 to 4 = 13 to 16;
       on the Smart Monitor M8, number 14 would be the USB-C input, not yet checked with a device plugged in).
       First directly from the app, otherwise through Vetro. */
    function switchSource(type, label) {
        if (PREVIEW) return Promise.reject(new Error(APL.t("PC preview: input change not sent")));
        var n = String(type);
        var icon = "/usr/apps/com.samsung.tv.theme-resource/shared/res/org.tizen.menu/Settings_Popup/device_icon/" +
                   (type >= 13 && type <= 16 ? "r_icon_device_s_hdmi" + (type - 12) : "r_icon_device_s_tv") + ".webp";
        var extra = [["change_source", n], ["sourceType", n], ["sourceName", String(label || "HDMI " + (type - 12)).replace(/[^A-Za-z0-9 +-]/g, "")],
                     ["sourceIcon", icon]];
        function viaVetro() {
            // No mbrIndex here: app_launcher takes "-2" for an option and rejects the command
            var args = extra.concat([["__K_EX_LAUNCH_REQUESTOR", "user"]]).map(function (kv) { return kv[0] + " '" + kv[1] + "'"; }).join(" ");
            return tvExec("app_launcher -s org.tizen.tv-viewer " + args + " 2>&1").then(function (r) {
                if (r.ok === false) throw new Error(APL.t("The screen refused the input change"));
            });
        }
        return game.applyOnInput().then(function () {
            return new Promise(function (resolve, reject) {
                try {
                    var data = extra.concat([["mbrIndex", "-2"]]).map(function (kv) { return new tz.ApplicationControlData(kv[0], [kv[1]]); });
                    var ctl = new tz.ApplicationControl("http://tizen.org/appcontrol/operation/default", null, null, null, data);
                    tz.application.launchAppControl(ctl, "org.tizen.tv-viewer", resolve, function () { viaVetro().then(resolve, reject); });
                } catch (e) { viaVetro().then(resolve, reject); }
            });
        });
    }

    /* Apps running right now (ids), without going through Vetro. */
    function runningApps() {
        return new Promise(function (resolve, reject) {
            if (!tz || !tz.application || !tz.application.getAppsContext) { reject(new Error(APL.t("unavailable"))); return; }
            tz.application.getAppsContext(function (list) {
                resolve(list.map(function (c) { return c.appId; }));
            }, reject);
        });
    }

    /* ---------- remote keys ---------- */
    function registerKeys() {
        if (!tz || !tz.tvinputdevice) return;
        ["MediaPlayPause", "MediaPlay", "ColorF0Red", "ColorF1Green", "ColorF2Yellow", "ColorF3Blue", "Info"].forEach(function (k) {
            try { tz.tvinputdevice.registerKey(k); } catch (e) {}
        });
    }

    /* ---------- sleep timer ----------
       The screen does the counting (background command): the launcher stops as soon as an app
       is in front, which is exactly when the timer is needed. The file is shared with overlay/. */
    var SLEEP_FILE = "/tmp/apl-sleep-at";
    function armSleepTimer(minutes) {
        var at = minutes ? Date.now() + minutes * 60000 : 0;
        setPref("sleepTimer", minutes);
        setPref("sleepAt", at);
        if (PREVIEW) return;
        var secs = Math.round(at / 1000);
        tvExec(minutes ? "echo " + secs + " > " + SLEEP_FILE + "; (sleep " + (minutes * 60) + "; if [ \"$(cat " + SLEEP_FILE + " 2>/dev/null)\" = \"" + secs + "\" ]; then rm -f " + SLEEP_FILE +
                         "; /usr/bin/input_keyevent XF86PowerOff; fi) >/dev/null 2>&1 &"
                       : "rm -f " + SLEEP_FILE).catch(function () {});
    }
    /* Timer set from the native Control Center: the launcher picks it up. */
    function readSleepTimer() {
        if (PREVIEW) return Promise.resolve();
        return tvExec("cat " + SLEEP_FILE + " 2>/dev/null").then(function (r) {
            var secs = parseInt(String(r.output || "").trim(), 10), at = secs ? secs * 1000 : 0;
            if (at < Date.now()) at = 0;
            setPref("sleepAt", at);
            if (!at) setPref("sleepTimer", 0);
        }, function () {});
    }

    /* ---------- Vetro (root service already installed on the screen) ----------
       Used for the REAL picture settings (backlight, contrast, sharpness,
       color…) and to close the Samsung home. Body sent as text/plain: no
       preflight request, Vetro reads the JSON whatever the type. */
    var VETRO = "http://127.0.0.1:8099";
    /* Vetro only lets the screen's apps read its answers for /status, /probe and
       /screen. The launcher's private bridge (bridge/service.js, a service in this package) makes
       the other requests and sends the answer back through a trusted Tizen message port
       (reserved for apps signed with the same certificate; no network port is opened). */
    var BRIDGE_ID = "APLauncher.Bridge", BRIDGE_PORT = "APL_BRIDGE";
    var replyPort = null, pending = {}, seq = 0, bridgeDownUntil = 0, bridgeStarting = null;
    /* The service takes a few seconds to open its port after it starts: wait until it is there. */
    function waitBridge(until) {
        return new Promise(function (resolve, reject) {
            (function poll() {
                try { tz.messageport.requestTrustedRemoteMessagePort(BRIDGE_ID, BRIDGE_PORT); resolve(); }
                catch (e) { if (Date.now() >= until) reject(e); else setTimeout(poll, 250); }
            })();
        });
    }
    function startBridge() {
        if (bridgeStarting) return bridgeStarting;
        function done() { bridgeStarting = null; }
        bridgeStarting = new Promise(function (resolve) {
            function plain() { try { tz.application.launch(BRIDGE_ID, resolve, resolve); } catch (e) { resolve(); } }
            try {
                tz.application.launchAppControl(new tz.ApplicationControl("http://tizen.org/appcontrol/operation/service"),
                                                BRIDGE_ID, resolve, plain);
            } catch (e) { plain(); }
        }).then(function () { return waitBridge(Date.now() + 12000); });
        bridgeStarting.then(done, done);
        return bridgeStarting;
    }
    function ensureReplyPort() {
        if (replyPort) return replyPort;
        replyPort = tz.messageport.requestTrustedLocalMessagePort("APL_BRIDGE_REPLY");
        replyPort.addMessagePortListener(function (data) {
            var m = {};
            for (var i = 0; i < data.length; i++) m[data[i].key] = data[i].value;
            var p = pending[m.id];
            if (!p) return;
            // Large answers arrive in several pieces
            p.chunks[parseInt(m.part, 10) || 0] = m.body || "";
            p.got++;
            if (p.got < (parseInt(m.parts, 10) || 1)) return;
            delete pending[m.id]; clearTimeout(p.timer);
            p.resolve({ status: parseInt(m.status, 10) || 0, body: p.chunks.join("") });
        });
        return replyPort;
    }
    function bridgeRequest(method, path, body, waitMs) {
        if (PREVIEW || !tz || !tz.messageport || Date.now() < bridgeDownUntil) return Promise.reject(new Error("bridge unavailable"));
        function send() {
            return new Promise(function (resolve, reject) {
                var remote = tz.messageport.requestTrustedRemoteMessagePort(BRIDGE_ID, BRIDGE_PORT);   // throws if not started
                ensureReplyPort();
                var id = String(++seq);
                pending[id] = { resolve: resolve, chunks: [], got: 0, timer: setTimeout(function () { delete pending[id]; reject(new Error("timeout")); }, waitMs || 60000) };
                // No port attached: the service answers through its own trusted port (see bridge/service.js)
                remote.sendMessage([{ key: "id", value: id }, { key: "method", value: method },
                                    { key: "path", value: path }, { key: "body", value: body || "" }]);
            });
        }
        return send().catch(function (e) {
            if (e && e.message === "timeout") throw e;
            return startBridge().then(send);                 // bridge not started yet: start it
        }).catch(function (e) {
            bridgeDownUntil = Date.now() + 5000;              // bridge missing: try again 5 s later
            throw e;
        });
    }
    /* Tells the bridge whether the launcher is in front: if the screen goes to sleep on it, the
       bridge brings it back at wake-up on screens that come back on the TV input (bridge/service.js). */
    function bridgeFront(visible) {
        if (PREVIEW || !tz || !tz.messageport) return;
        function send() {
            tz.messageport.requestTrustedRemoteMessagePort(BRIDGE_ID, BRIDGE_PORT).sendMessage([{ key: "front", value: visible ? "1" : "0" }]);
        }
        try { send(); } catch (e) { if (visible) startBridge().then(send).catch(function () {}); }
    }
    if (!PREVIEW && global.document) {
        document.addEventListener("visibilitychange", function () { bridgeFront(!document.hidden); });
        setTimeout(function () { if (!document.hidden) bridgeFront(true); }, 5000);
    }
    function vetroGet(path) {
        return bridgeRequest("GET", path, "").then(function (r) {
            if (r.status >= 400) throw new Error("Vetro " + r.status);
            return JSON.parse(r.body);
        }, function () {
            return global.fetch(VETRO + path).then(function (r) { if (!r.ok) throw new Error("Vetro " + r.status); return r.json(); },
                function () { throw new Error(APL.t("Vetro is not responding")); });
        });
    }
    function vetroPost(path, body) {
        var text = JSON.stringify(body);
        return bridgeRequest("POST", path, text).then(function (r) {
            try { return JSON.parse(r.body); } catch (e) { return {}; }
        }, function () {
            // Without the bridge: the order still goes to Vetro, with no readable answer
            return global.fetch(VETRO + path, { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: text })
                .then(function () { return { sent: true }; });
        });
    }
    /* Is Vetro answering? (cached for 30 s) */
    var aliveAt = 0, alive = false;
    function vetroAlive() {
        if (PREVIEW) return Promise.resolve(false);
        if (Date.now() - aliveAt < 30000) return Promise.resolve(alive);
        return vetroGet("/status").then(function (s) { return !!s && !(s.agent && s.agent.connected === false); },
                                        function () { return false; })
            .then(function (ok) { alive = ok; aliveAt = Date.now(); return ok; });
    }
    // Bridge started early: Control Center and Settings respond right away
    if (!PREVIEW) setTimeout(function () { vetroAlive(); }, 4000);

    /* Settings › Support › About This Screen: how the launcher reaches Vetro. Through the bridge it reads the
       answers; without it orders still go out (Bluetooth connects) but nothing can be read back, so the
       picture settings say Unavailable. For reports (issue #21, Tizen 6.5). */
    function vetroLink() {
        if (PREVIEW) return Promise.resolve(APL.t("Preview"));
        // 1. Does the bridge get the request and answer at all? The web bridge answers this one itself,
        //    without Vetro (bridge/service.js); the .NET bridge says "not relayed", which is an answer too.
        var t0 = Date.now(), info = null;
        return bridgeRequest("GET", "/bridge-info", "", 10000).then(function (r) {
            try { info = JSON.parse(r.body); } catch (e) {}
            // 2. Then a command through Vetro
            t0 = Date.now();
            return bridgeRequest("POST", "/exec", JSON.stringify({ cmd: "true" }), 20000).then(function (x) {
                var ok = false;
                try { ok = JSON.parse(x.body).ok !== false; } catch (e) {}
                return (ok ? APL.t("Through the bridge") : APL.t("Bridge: Vetro refused")) + " (" + (Date.now() - t0) + " ms" +
                       (info && info.reached ? ", " + info.reached : "") + ")";
            }, function () {
                // The bridge answers but Vetro doesn't: the addresses it tried and how they failed
                var tried = [];
                if (info && info.errors) Object.keys(info.errors).forEach(function (h) { tried.push(h + " " + info.errors[h]); });
                return APL.t("Bridge works, Vetro unreachable") + (tried.length ? ": " + tried.join(" · ") : "");
            });
        }, function (e) {
            return APL.t("Bridge: {error}", { error: e && e.message === "timeout" ? APL.t("no answer at all") : ((e && e.message) || "?") });
        });
    }

    /* Root command on the screen, through Vetro and the bridge. No backslashes in commands: Vetro doubles them. */
    function tvExec(cmd) {
        return vetroPost("/exec", { cmd: cmd }).then(function (r) {
            if (!r || r.sent) throw new Error(APL.t("Vetro is not responding (open Vetro once on the screen)"));
            return r;
        });
    }

    /* ---------- picture and Game Mode: the screen's AV service (D-Bus) ----------
       Answers look like "ii <value> <code>", with code 0 when all is well. */
    var AVOC = "busctl --system call org.tizen.tv.avoc /org/tizen/tv/avoc org.tizen.tv.avoc.AvOutputControl ";
    var PICTURE = [
        { id: "backlight", get: "GetBacklight i 0", set: "SetBacklight ii", min: 0, max: 50 },
        { id: "contrast", get: "GetContrast i 0", set: "SetContrast yi", min: 0, max: 50 },
        { id: "sharpness", get: "GetSharpness i 0", set: "SetSharpness yi", min: 0, max: 20 },
        { id: "color", get: "GetColorStrength i 0", set: "SetColorStrength yi", min: 0, max: 50 },
        { id: "pictureMode", get: "GetPictureMode i 0", set: "SetPictureMode ii", coded: true }
    ];
    /* Modes in this screen's Samsung list, noted on the M8 (Game Mode forces another one). */
    var PICTURE_MODES = [[65536, APL.t("Dynamic")], [65537, "Standard"], [65552, APL.t("Eco")], [65538, APL.t("Movie")]];
    var GAME_PICTURE = 458769;
    function pictureModeName(v) {
        if (v === GAME_PICTURE) return APL.t("Game");
        for (var i = 0; i < PICTURE_MODES.length; i++) if (PICTURE_MODES[i][0] === v) return PICTURE_MODES[i][1];
        return APL.t("Automatic");
    }
    function answerValue(line) { return parseInt(String(line || "").trim().split(/\s+/)[1], 10); }

    var MOCK_TV = [
        { id: "backlight", writable: true, value: 32, min: 0, max: 50 },
        { id: "contrast", writable: true, value: 45, min: 0, max: 50 },
        { id: "sharpness", writable: true, value: 10, min: 0, max: 20 },
        { id: "color", writable: true, value: 25, min: 0, max: 50 },
        { id: "pictureMode", writable: true, value: 65537, coded: true }
    ];
    var tvCache = null, tvAt = 0, tvPending = null;
    function tvSettings(force) {
        if (PREVIEW) return Promise.resolve(MOCK_TV);
        if (!force && tvCache && Date.now() - tvAt < 8000) return Promise.resolve(tvCache);
        if (tvPending) return tvPending;
        // Everything is read at once: a single command, much faster than Vetro's /tv-settings
        var cmd = PICTURE.map(function (p) { return "echo " + p.id + " $(" + AVOC + p.get + " 2>/dev/null)"; }).join("; ");
        tvPending = tvExec(cmd).then(function (r) {
            var byId = {};
            String(r.output || "").split("\n").forEach(function (l) {
                var w = l.trim().split(/\s+/);
                if (w.length >= 4) byId[w[0]] = { value: parseInt(w[2], 10), code: parseInt(w[3], 10) };
            });
            tvCache = PICTURE.filter(function (p) { return byId[p.id] && byId[p.id].code === 0; }).map(function (p) {
                return { id: p.id, writable: true, value: byId[p.id].value, min: p.min, max: p.max, coded: !!p.coded, def: p };
            });
            tvAt = Date.now(); tvPending = null;
            return tvCache;
        }, function (e) { tvPending = null; throw e; });
        return tvPending;
    }
    /* Writes a value and reads it back: the value read back is what counts. The last argument is 1:
       the screen saves the value (with 0, it applies but the screen forgets it in under a second). */
    function tvWrite(it, want) {
        var p = it.def;
        return tvExec(AVOC + p.set + " " + want + " 1 2>&1; " + AVOC + p.get + " 2>&1").then(function (r) {
            var lines = String(r.output || "").trim().split("\n");
            var back = answerValue(lines[lines.length - 1]);
            if (isNaN(back)) throw new Error(APL.t("The screen did not respond"));
            it.value = back;
            if (back !== want) throw new Error(APL.t("The screen refused this setting for now"));
            return back;
        });
    }
    /* On the M8, Standard has its backlight and contrast at 0 (black picture, unreadable menus):
       in that case a mode takes over the values of the mode being left. */
    function setPictureMode(v) {
        if (PREVIEW) { MOCK_TV[MOCK_TV.length - 1].value = v; return Promise.resolve(v); }
        return tvSettings(true).then(function (before) {
            var old = {};
            before.forEach(function (it) { old[it.id] = it; });
            if (!old.pictureMode) throw new Error(APL.t("Picture Mode unavailable"));
            return tvWrite(old.pictureMode, v).then(function (back) {
                return tvSettings(true).then(function (now) {
                    var next = Promise.resolve();
                    now.forEach(function (it) {
                        if ((it.id === "backlight" || it.id === "contrast") && it.value === 0 && old[it.id] && old[it.id].value > 0) {
                            next = next.then(function () { return tvWrite(it, old[it.id].value); });
                        }
                    });
                    return next.then(function () { tvCache = null; return back; });
                });
            });
        });
    }

    /* Game Mode: the screen accepts it once an input (HDMI, USB-C) has been shown since
       power-on. Before that, the request is held (gameWanted) and sent when switching to an input. */
    var game = {
        get: function () {
            if (PREVIEW) return Promise.resolve({ available: true, on: !!pref("gameWanted") });
            return tvExec(AVOC + "CheckGameMode 2>&1; " + AVOC + "GetGameMode i 0 2>&1").then(function (r) {
                var lines = String(r.output || "").trim().split("\n");
                var available = answerValue(lines[0]) === 1;
                if (available && pref("gameWanted")) setPref("gameWanted", false);
                return { available: available, on: available ? answerValue(lines[1]) === 1 : !!pref("gameWanted"),
                         pending: !available && !!pref("gameWanted") };
            });
        },
        set: function (on) {
            if (PREVIEW) { setPref("gameWanted", !!on); return Promise.resolve({ available: true, on: !!on }); }
            return game.get().then(function (g) {
                if (!g.available) {
                    setPref("gameWanted", !!on);
                    return { available: false, on: !!on, pending: !!on };
                }
                return tvExec(AVOC + "SetGameMode ii 1 " + (on ? 1 : 0) + " 2>&1; sleep 1; " + AVOC + "GetGameMode i 0 2>&1").then(function (r) {
                    var lines = String(r.output || "").trim().split("\n");
                    var now = answerValue(lines[lines.length - 1]) === 1;
                    tvCache = null;
                    if (now !== !!on) throw new Error(APL.t("The screen refused Game Mode for now"));
                    return { available: true, on: now };
                });
            });
        },
        /* As soon as the input shows, the launcher goes to the background and does nothing more:
           the command is handed to the screen before leaving, and it waits for the input to be ready. */
        applyOnInput: function () {
            if (PREVIEW || !pref("gameWanted")) return Promise.resolve();
            var sent = tvExec("(for i in 1 2 3 4 5 6 7 8 9 10; do sleep 2; if [ \"$(" + AVOC + "CheckGameMode)\" = \"i 1\" ]; then " +
                              AVOC + "SetGameMode ii 1 1; break; fi; done) >/dev/null 2>&1 &").catch(function () {});
            return Promise.race([sent, new Promise(function (resolve) { setTimeout(resolve, 1500); })]);
        }
    };
    /* The screen's other settings: AV service (D-Bus) or vconf, read and written directly, as
       above. All tried on the M8: write, read back, restore. "--": negative values.
       V = the value. No backslashes: Vetro doubles them. */
    var NATIVE = {
        tint:       { get: "GetColorTint i 0", set: "SetColorTint yi -- V 1", min: 0, max: 30 },
        shadow:     { get: "GetBrightness i 0", set: "SetBrightness ii -- V 1", min: -5, max: 5 },
        gamma:      { get: "GetGamma i 0", set: "SetGamma ii -- V 1", min: -3, max: 3 },
        blur:       { get: "GetBlurReduction i 0", set: "SetBlurReduction iy -- 1 V", min: 0, max: 10 },
        judder:     { get: "GetJuddlerReduction i 0", set: "SetJuddlerReduction iy -- 1 V", min: 0, max: 10 },
        balance:    { get: "GetBalance u 0", set: "SetBalance uu -- V 1", min: 0, max: 20 },
        delay:      { get: "GetDelay u 0", set: "SetDelay uu -- V 1", min: 0, max: 250, step: 10 },
        eq0:        { get: "GetEqualizer uu 0 0", set: "SetEqualizer iii -- 0 V 1", min: 0, max: 100, step: 10 },
        eq1:        { get: "GetEqualizer uu 1 0", set: "SetEqualizer iii -- 1 V 1", min: 0, max: 100, step: 10 },
        eq2:        { get: "GetEqualizer uu 2 0", set: "SetEqualizer iii -- 2 V 1", min: 0, max: 100, step: 10 },
        eq3:        { get: "GetEqualizer uu 3 0", set: "SetEqualizer iii -- 3 V 1", min: 0, max: 100, step: 10 },
        eq4:        { get: "GetEqualizer uu 4 0", set: "SetEqualizer iii -- 4 V 1", min: 0, max: 100, step: 10 },
        contrastUp: { get: "GetDynamicContrast i 0", set: "SetDynamicContrast ii -- V 1" },
        colorTone:  { get: "GetColorToneMode i 0", set: "SetColorToneMode ii -- V 1" },
        colorSpace: { get: "GetColorSpace i 0", set: "SetColorSpace ii -- V 1" },
        clarity:    { get: "GetAutoMotionPlus i 0", set: "SetAutoMotionPlus ii -- V 1" },
        eyeSaver:   { get: "GetEyeSaverMode i 0", set: "SetEyeSaverMode ii -- V 1" },
        adaptive:   { get: "GetAdaptivePicture", set: "SetAdaptivePicture i -- V" },
        energy:     { get: "GetEnergySaving i 0", set: "SetEnergySaving ii -- 1 V" },
        ecoSensor:  { get: "GetEcoSensor i 0", set: "SetEcoSensor ii -- 1 V" },
        hdmiBlack:  { get: "GetHdmiBlackLevel i 0", set: "SetHdmiBlackLevel ii -- V 1" },
        earc:       { get: "GetEarcEnable", set: "SetEarcEnable i -- V" },
        soundMode:  { get: "GetSoundMode u 0", set: "SetSoundMode uu -- V 1" },
        autoVolume: { get: "GetAutoVolume u 0", set: "SetAutoVolume uu -- V 1" },
        feedback:   { get: "GetSoundFeedback i 0", set: "SetSoundFeedback ii -- 1 V" },
        /* The screen's home app (db/appfw/home_appid). At power-on the screen puts either the TV input or the
           home app in front, and Autorun Smart Hub chooses the home app: with the launcher as home app, it is
           on screen about a second after power-on instead of after the start-up service (~1 min). Autorun
           also opened Samsung's home at every wake: APL Overlay turns it off while the screen sleeps and
           on again once it is awake (overlay/Autorun.cs). Off: the screen's own home app again, as the
           firmware records it in db/first_screen/type. */
        homeApp:    { home: true }
    };
    var HOME_KEY = "db/appfw/home_appid", AUTOSTART_KEY = "db/menu/smart_hub/ontvsetting/auto_start";
    var MOCK_NATIVE = {};
    function nativeGet(id) {
        var d = NATIVE[id];
        if (PREVIEW) return Promise.resolve(MOCK_NATIVE[id] || (d.min !== undefined ? Math.round((d.min + d.max) / 2) : 0));
        if (d.home) {
            // On only if both took: with Autorun off the screen still starts on the TV input
            return homeAppRead().then(function (s) { return s.home === "APLauncher.Home" && s.autostart === 1 ? 1 : 0; });
        }
        if (d.vconf) {
            return tvExec("vconftool get " + d.vconf + " 2>&1").then(function (r) {
                var m = /value = (-?[0-9]+)/.exec(String(r.output || ""));
                if (!m) throw new Error(APL.t("Unavailable"));
                return parseInt(m[1], 10);
            });
        }
        return tvExec(AVOC + d.get + " 2>&1").then(function (r) {
            var w = String(r.output || "").trim().split(/\s+/);
            if (w.length < 3 || w[w.length - 1] !== "0") throw new Error(APL.t("Unavailable"));
            return parseInt(w[1], 10);
        });
    }
    /* Writes then reads back: the value read back is what counts. */
    function nativeSet(id, value) {
        var d = NATIVE[id];
        if (PREVIEW) { MOCK_NATIVE[id] = value; return Promise.resolve(value); }
        var write = d.vconf ? "vconftool set -f -t int " + d.vconf + " " + value + " 2>&1" : AVOC + d.set.replace("V", value) + " 2>&1";
        return (d.home ? homeAppSet(value) : tvExec(write)).then(function () { return nativeGet(id); }).then(function (back) {
            if (back !== value) throw new Error(APL.t("The screen refused this setting for now"));
            return back;
        });
    }
    function homeAppRead() {
        return tvExec("vconftool get " + HOME_KEY + " 2>&1; vconftool get " + AUTOSTART_KEY + " 2>&1").then(function (r) {
            var out = String(r.output || ""), h = /home_appid, value = (\S+)/.exec(out), a = /auto_start, value = (-?[0-9]+)/.exec(out);
            if (!h || !a) throw new Error(APL.t("Unavailable"));
            return { home: h[1], autostart: parseInt(a[1], 10) };
        });
    }
    /* On: saves the screen's home app and Autorun as they are, then makes the launcher the home app and
       turns Autorun on. Off: puts back exactly what was saved; without a saved value, the home app the
       firmware records in db/first_screen/type, then Samsung's home, and Autorun off. */
    var APP_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
    function homeAppSet(value) {
        return homeAppRead().then(function (cur) {
            if (value === 1) {
                if (cur.home !== "APLauncher.Home") setPref("homeAppSaved", { home: cur.home, autostart: cur.autostart });
                return tvExec("vconftool set -f -t string " + HOME_KEY + " APLauncher.Home 2>&1; vconftool set -f -t int " + AUTOSTART_KEY + " 1 2>&1");
            }
            var saved = pref("homeAppSaved") || {};
            var home = saved.home && saved.home !== "APLauncher.Home" && APP_ID_RE.test(saved.home) ? saved.home : null;
            var autostart = saved.autostart === 1 ? 1 : 0;
            var setHome = home ? "vconftool set -f -t string " + HOME_KEY + " " + home + " 2>&1"
                : "h=$(vconftool get db/first_screen/type 2>/dev/null | awk '{print $4}'); " +
                  "if [ -z \"$h\" ] || [ \"$h\" = APLauncher.Home ]; then h=com.samsung.tv.csfs; fi; " +
                  "vconftool set -f -t string " + HOME_KEY + " \"$h\" 2>&1";
            return tvExec(setHome + "; vconftool set -f -t int " + AUTOSTART_KEY + " " + autostart + " 2>&1").then(function (r) {
                setPref("homeAppSaved", null);
                return r;
            });
        });
    }
    function nativeReset(method) { return PREVIEW ? Promise.resolve() : tvExec(AVOC + method + " 2>&1"); }

    function tvItem(id) {
        return tvSettings().then(function (items) {
            for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
            return null;
        });
    }
    /* Gradual adjustment (◀ ▶): the displayed value changes right away, the write
       goes out 350 ms after the last key press, one at a time. */
    var tvTimers = {}, tvWriting = {};
    function tvAdjust(id, delta, onChange) {
        return tvItem(id).then(function (it) {
            if (!it || !it.writable) throw new Error(APL.t("Setting unavailable for now"));
            if (it.target === undefined) it.target = it.value;
            it.target = Math.max(it.min, Math.min(it.max, it.target + delta));
            if (onChange) onChange(it.target, it);
            clearTimeout(tvTimers[id]);
            tvTimers[id] = setTimeout(function flush() {
                if (tvWriting[id]) { tvTimers[id] = setTimeout(flush, 150); return; }
                if (it.target === it.value) return;
                if (PREVIEW) { it.value = it.target; return; }
                tvWriting[id] = true;
                tvWrite(it, it.target).then(function () {
                    tvWriting[id] = false;
                }, function (e) {
                    tvWriting[id] = false;
                    it.target = it.value;
                    tvCache = null;
                    if (onChange) onChange(it.value, it);
                    if (global.APL && global.APL.toast) global.APL.toast(e.message);
                });
            }, 350);
            return it.target;
        });
    }
    function tvValue(id) {
        return tvItem(id).then(function (it) { return it ? (it.target !== undefined ? it.target : it.value) : null; });
    }

    /* ---------- navigation sounds (synthesized, no file) ---------- */
    var actx = null;
    function blip(freq, dur, vol) {
        if (!pref("uiSounds")) return;
        try {
            if (!actx) { var AC = global.AudioContext || global.webkitAudioContext; if (!AC) return; actx = new AC(); }
            var t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
            o.type = "sine"; o.frequency.setValueAtTime(freq, t);
            g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
        } catch (e) {}
    }
    /* Interface sounds: the files launcher/sounds/navigate.wav, click.wav and
       back.wav if they are there (your real sounds), decoded once into memory and played
       through WebAudio (almost no latency). Otherwise, small synthesized clicks. */
    var buffers = {}, players = {}, FILES = { navigate: "sounds/navigate.wav", click: "sounds/click.wav", back: "sounds/back.wav" };
    // Fallback if the file cannot be read into memory (e.g. page opened from disk)
    function loadPlayer(k) {
        try {
            var a = new global.Audio(FILES[k]);
            a.preload = "auto";
            a.addEventListener("canplaythrough", function () { if (!buffers[k]) players[k] = a; });
        } catch (e) {}
    }
    function loadSounds() {
        var AC = global.AudioContext || global.webkitAudioContext;
        Object.keys(FILES).forEach(function (k) {
            if (!AC || !global.XMLHttpRequest) { loadPlayer(k); return; }
            try {
                var x = new XMLHttpRequest();
                x.open("GET", FILES[k], true);
                x.responseType = "arraybuffer";
                x.onload = function () {
                    if (!x.response || (x.status && x.status !== 200 && x.status !== 0)) return;
                    try {
                        if (!actx) actx = new AC();
                        var done = function (buf) { buffers[k] = buf; };
                        var pr = actx.decodeAudioData(x.response, done, function () {});
                        if (pr && pr.then) pr.then(done, function () {});
                    } catch (e) {}
                };
                x.onerror = function () { loadPlayer(k); };
                x.send();
            } catch (e) { loadPlayer(k); }
        });
    }
    function play(k, rate, vol) {
        if (!pref("uiSounds")) return !!(buffers[k] || players[k]);
        var buf = buffers[k];
        if (!buf && players[k]) {
            try {
                var a = players[k];
                a.volume = vol || 1;
                a.playbackRate = rate || 1;
                a.currentTime = 0;
                var pr = a.play();
                if (pr && pr.catch) pr.catch(function () {});
            } catch (e) {}
            return true;
        }
        if (!buf) return false;
        try {
            if (actx.state === "suspended" && actx.resume) actx.resume();
            var src = actx.createBufferSource(), g = actx.createGain();
            src.buffer = buf;
            if (rate) src.playbackRate.value = rate;
            g.gain.value = vol || 1;
            src.connect(g); g.connect(actx.destination);
            src.start(0);
        } catch (e) {}
        return true;
    }
    var sound = {
        tick: function () { if (!play("navigate")) blip(2100, 0.022, 0.045); },
        select: function () { if (!play("click")) blip(1250, 0.06, 0.07); },
        back: function () { if (!play("back")) blip(900, 0.05, 0.06); },
        // Edge of the grid: the navigation sound, lower and softer
        edge: function () { if (!play("navigate", 0.72, 0.6)) blip(420, 0.05, 0.05); }
    };
    if (global.document && document.readyState !== "loading") setTimeout(loadSounds, 300);
    else if (global.document) document.addEventListener("DOMContentLoaded", function () { setTimeout(loadSounds, 300); });

    global.APL = global.APL || {};
    global.APL.sound = sound;
    global.APL.sys = {
        PREVIEW: PREVIEW,
        pref: pref, setPref: setPref, onPref: onPref, profiles: profiles,
        audio: audio, network: network, product: product, display: display, storage: storage, hdr: hdr,
        remoteKey: remoteKey, openSamsungSettings: openSamsungSettings, sleepNow: sleepNow,
        switchSource: switchSource, vetroAlive: vetroAlive, vetroLink: vetroLink,
        registerKeys: registerKeys, armSleepTimer: armSleepTimer, readSleepTimer: readSleepTimer,
        vetroGet: vetroGet, vetroPost: vetroPost, exec: tvExec, game: game, runningApps: runningApps,
        native: { get: nativeGet, set: nativeSet, reset: nativeReset, info: function (id) { return NATIVE[id]; } },
        PICTURE_MODES: PICTURE_MODES, pictureModeName: pictureModeName, setPictureMode: setPictureMode,
        tvSettings: tvSettings, tvItem: tvItem, tvAdjust: tvAdjust, tvValue: tvValue,
        version: (global.APL_UPDATE && global.APL_UPDATE.running) || "1.0.0"
    };
})(window);
