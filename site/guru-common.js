/* =====================================================================
   NGH GURU COMMON — shared admin auth (single sign-on) + Guru nav bar
   ---------------------------------------------------------------------
   Include on every staff page BEFORE the page's own script:
     <script src="guru-common.js"></script>

   What it does:
   1) SINGLE SIGN-ON. The admin token (a stateless "<expiryMs>.<hmac>"
      issued by /admin-login) now lives in localStorage under ONE key,
      "ngh_admin_token", shared by every staff page: the booking console,
      Guru Schedule, Guru Radar, Check-In, and the Guru Hub. Logging in
      anywhere logs you in everywhere (and survives new tabs); logging
      out anywhere logs you out everywhere.
      For back-compat with page code that still reads sessionStorage
      ("ngh_admin_token" / checkin's legacy "ngh_checkin_token"), the
      token is mirrored into those keys on load and on login.
   2) GURU NAV. When a valid token is present on a staff page, a slim
      navigation bar is injected so every staff tool is one tap away.
   ===================================================================== */
(function () {
  var KEY = "ngh_admin_token";
  var LEGACY_SESSION_KEYS = ["ngh_admin_token", "ngh_checkin_token"];

  function expOf(t) { var e = Number(String(t || "").split(".")[0]); return isFinite(e) ? e : 0; }
  function valid(t) { return !!t && expOf(t) > Date.now() + 30 * 1000; }

  function mirror(t) {
    for (var i = 0; i < LEGACY_SESSION_KEYS.length; i++) {
      try { sessionStorage.setItem(LEGACY_SESSION_KEYS[i], t); } catch (e) {}
    }
  }
  function unmirror() {
    for (var i = 0; i < LEGACY_SESSION_KEYS.length; i++) {
      try { sessionStorage.removeItem(LEGACY_SESSION_KEYS[i]); } catch (e) {}
    }
  }

  var GuruAuth = {
    get: function () {
      var t = null;
      try { t = localStorage.getItem(KEY); } catch (e) {}
      if (!valid(t)) {
        // migrate a still-valid legacy sessionStorage token into the shared slot
        for (var i = 0; i < LEGACY_SESSION_KEYS.length && !valid(t); i++) {
          try { var s = sessionStorage.getItem(LEGACY_SESSION_KEYS[i]); if (valid(s)) t = s; } catch (e) {}
        }
        if (valid(t)) { try { localStorage.setItem(KEY, t); } catch (e) {} }
      }
      if (!valid(t)) { try { localStorage.removeItem(KEY); } catch (e) {} unmirror(); return ""; }
      mirror(t);
      return t;
    },
    set: function (t) {
      try { localStorage.setItem(KEY, t); } catch (e) {}
      mirror(t);
      injectNav();
    },
    clear: function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      unmirror();
      var bar = document.getElementById("guru-nav-bar");
      if (bar) bar.remove();
      document.documentElement.style.removeProperty("--guru-nav-pad");
      document.body && (document.body.style.paddingTop = "");
    },
    valid: valid,
    headers: function () { var t = this.get(); return t ? { Authorization: "Bearer " + t } : {}; },
    // Log out of every staff tool and land on the Hub.
    logoutEverywhere: function () { this.clear(); location.href = "guru.html"; }
  };
  window.GuruAuth = GuruAuth;

  /* ------------------------- Guru nav bar ------------------------- */
  var LINKS = [
    { href: "guru.html",                          label: "🦦 Hub" },
    { href: "booking.html?admin=1&view=list",     label: "📥 Requests" },
    { href: "booking.html?admin=1&view=calendar", label: "📅 Calendar" },
    { href: "booking.html?admin=1&view=events",   label: "🎉 Events" },
    { href: "guru-draft.html",                    label: "📝 Drafts" },
    { href: "guru-promo.html",                    label: "📣 Promotion" },
    { href: "guru-schedule.html",                 label: "🦦 Schedule" },
    { href: "guru-radar.html",                    label: "🎯 Radar" },
    { href: "guru.html#birthdays",                label: "🎂 Birthdays" },
    { href: "checkin.html",                       label: "🎟️ Check-In" },
    { href: "events.html",                        label: "🗓️ Public Cal" }
  ];

  // NGH-BUILD 2026-08-06v
  function pageFile() {
    // Netlify pretty URLs serve /booking for booking.html — normalize so the
    // staff-page checks and active-highlighting work on both forms.
    var f = (location.pathname.split("/").pop() || "index.html").toLowerCase();
    if (f && f.indexOf(".") < 0) f += ".html";
    return f;
  }

  function isStaffContext() {
    var f = pageFile();
    if (f === "guru.html" || f === "guru-schedule.html" || f === "guru-radar.html" || f === "checkin.html" || f === "guru-promo.html" || f === "guru-draft.html") return true;
    // booking.html: the bar shows whenever a valid staff token exists (the
    // injectNav token gate already keeps it off public visitors' screens) —
    // requiring ?admin=1 hid it from every SSO entry path.
    if (f === "booking.html") return true;
    return false;
  }

  function injectNav() {
    if (!document.body) return;
    if (!isStaffContext()) return;
    if (!valid(GuruAuth.get())) return;
    if (document.getElementById("guru-nav-bar")) return;

    var f = pageFile();
    var bar = document.createElement("div");
    bar.id = "guru-nav-bar";
    bar.setAttribute("style",
      "position:fixed;top:0;left:0;right:0;z-index:99999;display:flex;align-items:center;gap:2px;" +
      "overflow-x:auto;-webkit-overflow-scrolling:touch;background:#1c3a26;border-bottom:2px solid #c79a3b;" +
      "padding:6px 10px;font-family:Georgia,serif;font-size:13px;line-height:1;box-shadow:0 2px 8px rgba(0,0,0,.25);");

    function mk(href, label, active) {
      var a = document.createElement("a");
      a.href = href; a.textContent = label;
      a.setAttribute("style",
        "white-space:nowrap;text-decoration:none;padding:7px 11px;border-radius:20px;" +
        (active ? "background:#c79a3b;color:#1a1a12;font-weight:bold;"
                : "color:#e9e4d2;") );
      return a;
    }
    var curView = "";
    try { curView = new URLSearchParams(location.search).get("view") || "list"; } catch (e) { curView = "list"; }
    for (var i = 0; i < LINKS.length; i++) {
      var l = LINKS[i];
      var lf = l.href.split(/[?#]/)[0].toLowerCase();
      var active = (lf === f) && !(f === "guru.html" && l.href.indexOf("#birthdays") >= 0 && location.hash !== "#birthdays");
      if (f === "guru.html" && location.hash === "#birthdays") active = l.href.indexOf("#birthdays") >= 0;
      if (active && lf === "booking.html") {
        // three links share booking.html — highlight the one matching ?view=
        var lv = (l.href.match(/[?&]view=(\w+)/) || [])[1] || "list";
        active = (lv === curView);
      }
      bar.appendChild(mk(l.href, l.label, active));
    }
    var spacer = document.createElement("div");
    spacer.setAttribute("style", "flex:1 0 8px;");
    bar.appendChild(spacer);
    var out = document.createElement("a");
    out.href = "#"; out.textContent = "⎋ Log out";
    out.setAttribute("style", "white-space:nowrap;text-decoration:none;color:#e0b4a8;padding:7px 11px;");
    out.onclick = function (ev) { ev.preventDefault(); GuruAuth.logoutEverywhere(); };
    bar.appendChild(out);

    document.body.appendChild(bar);
    // push page content down so the fixed bar doesn't cover it
    var h = bar.offsetHeight || 40;
    var cur = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
    document.body.style.paddingTop = (cur + h) + "px";
  }

  // token migration runs immediately (so legacy page code that reads
  // sessionStorage at parse time finds the token); nav waits for the DOM.
  GuruAuth.get();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectNav);
  } else {
    injectNav();
  }
  // stay in sync across tabs: login/logout elsewhere applies here on focus
  window.addEventListener("focus", function () {
    var bar = document.getElementById("guru-nav-bar");
    if (!valid(GuruAuth.get()) && bar) location.reload();
  });
})();
