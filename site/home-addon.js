/* =================================================================
   NGH HOME ADD-ON  (site/home-addon.js)
   Loaded into index.html AND ngh.html via Netlify snippet injection
   (mirror rule satisfied automatically — same script, both pages).

   Collapses the Game Guru cards (Guru details + Foraging Focus areas)
   behind a tap-to-expand panel using the page's OWN .guru-cov
   pattern — identical look/behavior to the existing "Guru Coverage
   by Category" collapsible. Section title, intro, Stash quote, and
   the Become-a-Guru recruiting CTA stay visible.
   ================================================================= */
(function () {
  "use strict";
  function ready(fn) { if (document.readyState !== "loading") fn(); else document.addEventListener("DOMContentLoaded", fn); }
  ready(function () {
    var sec = document.getElementById("game-gurus");
    if (!sec) return;
    var grid = sec.querySelector(".guru-grid");
    if (!grid || grid.closest("details")) return; // already wrapped (e.g. future source-level fix)

    var det = document.createElement("details");
    det.className = "guru-cov";
    det.id = "guru-cards-cov";
    det.style.marginTop = "44px";
    det.innerHTML =
      '<summary class="guru-cov-sum">' +
        '<span>\uD83E\uDDA6 Meet Our Game Gurus &amp; Foraging Focuses</span>' +
        '<span class="guru-cov-hint"><span class="hint-open">tap to expand \u25BE</span><span class="hint-close">tap to collapse \u25B4</span></span>' +
      '</summary>';

    grid.parentNode.insertBefore(det, grid);
    det.appendChild(grid);                 // moves the card grid inside the panel
    grid.style.margin = "8px 24px 26px";   // match .guru-cov inner spacing

    // The cards use the page's scroll-reveal (.reveal -> .visible). When the
    // panel opens, force-reveal so nothing sits invisible inside.
    det.addEventListener("toggle", function () {
      if (det.open) {
        grid.querySelectorAll(".reveal").forEach(function (el) { el.classList.add("visible"); });
      }
    });
  });
})();
