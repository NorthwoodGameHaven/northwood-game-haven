/* =================================================================
   NGH GURU ADD-ON v1.4  (site/guru-addon.js)
   Loaded into booking.html via Netlify snippet injection — the 2.4 MB
   booking.html itself is never edited. This add-on:
     1. Adds a "🦦 Guru Schedule" link to the admin toolbar.
     2. Injects a Guru picker (Dustin/Mike/Chad/Jen/Sarah/Kyle + Other
        + None, multi-select) into the event create/edit form and saves
        the assignment to /gurus when the event saves.
     3. Runs conflict checks at event save time: overlap / tight-spacing
        / store-shift warnings with proceed-anyway confirm; a Guru with
        an Unavailable entry HARD-BLOCKS the save (event not created).
     4. Removes the "⚡ Quick Bulk Import" card from the events view.
   Assignments stay admin-only insight — nothing public changes.
   ================================================================= */
(function () {
  "use strict";
  function ready(fn) { if (document.readyState !== "loading") fn(); else document.addEventListener("DOMContentLoaded", fn); }

  ready(function () {
    try { console.log("NGH guru-addon v1.4"); } catch(_) {}
    // Only activate inside the booking/admin app.
    if (!document.getElementById("events-view-wrap")) return;
    if (typeof window.renderEventsAdmin !== "function" || typeof window.saveEvent !== "function" || !window.Store) return;

    var GURUS = ["Dustin", "Mike", "Chad", "Jen", "Sarah", "Kyle", "Zach"];
    var TIGHT_MIN = 15;
    var API = window.NGH_API_BASE || "/.netlify/functions";
    var gd = { assignments: [], shifts: [], unavail: [] };
    var savedDuringCall = [];

    function tok() { return sessionStorage.getItem("ngh_admin_token") || ""; }
    function gid(x) { return document.getElementById(x); }
    async function gapi(path, opts) {
      opts = opts || {}; opts.headers = opts.headers || {};
      opts.headers["Content-Type"] = "application/json";
      if (tok()) opts.headers["Authorization"] = "Bearer " + tok();
      var r = await fetch(API + path, opts);
      if (r.status === 204) return null;
      var body = null; try { body = await r.json(); } catch (e) {}
      if (!r.ok) { var err = new Error((body && body.error) || ("HTTP " + r.status)); err.status = r.status; err.body = body; throw err; }
      return body;
    }
    async function loadGd() { try { var r = await gapi("/gurus"); if (r) gd = r; } catch (e) {} }

    var t2m = window.timeToMins || function (t) { if (!t) return 0; var p = String(t).split(":"); return (+p[0]) * 60 + (+p[1] || 0); };
    function evDatesOf(e) { try { return (typeof window.eventDates === "function") ? window.eventDates(e) : [e.date]; } catch (_) { return [e.date]; } }
    function recDates(d, f, c, mode) { try { return (typeof window.recurrenceDates === "function") ? window.recurrenceDates(d, f, c, mode) : [d]; } catch (_) { return [d]; } }
    function shiftDatesOf(s) { return s.recurrence ? recDates(s.date, s.recurrence.freq, s.recurrence.count) : [s.date]; }
    function overlap(a, b, c, d) { return a < d && c < b; }
    function inSpan(d, from, to) { return d >= from && d <= (to || from); }

    function gurusOf(eventId, date) {
      var ov = null, base = null;
      gd.assignments.forEach(function (a) {
        if (a.eventId !== eventId) return;
        if (a.date === date) ov = a; else if (a.date == null) base = a;
      });
      var a = ov || base;
      return (a && !a.none && a.gurus) ? a.gurus : [];
    }
    function baseRecId(eventId) {
      var r = null;
      gd.assignments.forEach(function (a) { if (a.eventId === eventId && a.date == null) r = a; });
      return r ? r.id : undefined;
    }

    /* ---------- 1. toolbar link ---------- */
    var promoBtn = gid("view-promos-btn");
    if (promoBtn && !gid("guru-sched-link")) {
      var a = document.createElement("a");
      a.id = "guru-sched-link"; a.className = "btn btn-sm btn-ghost";
      a.href = "guru-schedule.html"; a.textContent = "🦦 Guru Schedule";
      a.style.textDecoration = "none"; a.style.display = "inline-flex"; a.style.alignItems = "center";
      promoBtn.parentNode.insertBefore(a, promoBtn.nextSibling);
    }

    /* ---------- 2. Guru picker ---------- */
    function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    function pickerHTML() {
      var h = '<div id="ga-picker" style="margin-top:14px;padding:12px 14px;background:#f4f8f2;border:1px solid #cfe0cb;border-radius:9px;">' +
        '<div style="font-family:\'Cinzel\',serif;color:var(--forest,#2e5d3b);font-size:0.86rem;margin-bottom:6px;">🦦 Game Guru(s) running this event <span style="font-family:Georgia,serif;font-size:0.72rem;color:#7a7a5a;">(admin-only — never shown publicly)</span></div>';
      GURUS.forEach(function (g) {
        h += '<label style="display:inline-flex;align-items:center;gap:5px;border:1.5px solid #d8d4c2;border-radius:50px;padding:5px 11px;margin:3px 4px 3px 0;font-size:0.8rem;cursor:pointer;background:#fff;"><input type="checkbox" class="ga-g" value="' + esc(g) + '" onchange="if(this.checked&&document.getElementById(\'ga-none\'))document.getElementById(\'ga-none\').checked=false;"> ' + esc(g) + '</label>';
      });
      h += '<label style="display:inline-flex;align-items:center;gap:5px;border:1.5px solid #d8d4c2;border-radius:50px;padding:5px 11px;margin:3px 4px 3px 0;font-size:0.8rem;cursor:pointer;background:#fff;"><input type="checkbox" id="ga-other" onchange="document.getElementById(\'ga-other-name\').style.display=this.checked?\'inline-block\':\'none\';if(this.checked&&document.getElementById(\'ga-none\'))document.getElementById(\'ga-none\').checked=false;"> Other</label>' +
        '<input type="text" id="ga-other-name" placeholder="Other name(s), comma-separated" style="display:none;width:230px;">' +
        '<label style="display:inline-flex;align-items:center;gap:5px;border:1.5px dashed #b8b4a2;border-radius:50px;padding:5px 11px;margin:3px 4px 3px 0;font-size:0.8rem;cursor:pointer;background:#fff;"><input type="checkbox" id="ga-none" onchange="if(this.checked){document.querySelectorAll(\'.ga-g\').forEach(function(c){c.checked=false;});var o=document.getElementById(\'ga-other\');if(o){o.checked=false;}document.getElementById(\'ga-other-name\').style.display=\'none\';}"> None — no active Guru management required</label>' +
        '<div style="font-size:0.72rem;color:#7a7a5a;margin-top:4px;">Saving checks the Guru schedule: overlaps &amp; store shifts warn (you can proceed); an <b>Unavailable</b> Guru blocks the save. Full calendar, store shifts &amp; exports: <a href="guru-schedule.html">Guru Schedule console</a>.</div></div>';
      return h;
    }
    function injectPicker() {
      if (gid("ga-picker")) return;
      var sb = gid("ev-save-btn"); if (!sb) return;
      var row = sb.parentNode;
      var holder = document.createElement("div");
      holder.innerHTML = pickerHTML();
      row.parentNode.insertBefore(holder.firstChild, row);
    }
    function clearPicker() {
      document.querySelectorAll(".ga-g").forEach(function (c) { c.checked = false; });
      if (gid("ga-other")) gid("ga-other").checked = false;
      if (gid("ga-other-name")) { gid("ga-other-name").value = ""; gid("ga-other-name").style.display = "none"; }
      if (gid("ga-none")) gid("ga-none").checked = false;
    }
    function fillPicker(eventId) {
      if (!gid("ga-picker")) injectPicker();
      clearPicker();
      var rec = null;
      gd.assignments.forEach(function (x) { if (x.eventId === eventId && x.date == null) rec = x; });
      if (!rec) return;
      if (rec.none) { if (gid("ga-none")) gid("ga-none").checked = true; return; }
      var others = [];
      (rec.gurus || []).forEach(function (g) {
        var hit = false;
        document.querySelectorAll(".ga-g").forEach(function (c) { if (c.value === g) { c.checked = true; hit = true; } });
        if (!hit) others.push(g);
      });
      if (others.length) { gid("ga-other").checked = true; gid("ga-other-name").value = others.join(", "); gid("ga-other-name").style.display = "inline-block"; }
    }
    function collectPicker() {
      if (!gid("ga-picker")) return null;
      if (gid("ga-none") && gid("ga-none").checked) return { none: true, gurus: [] };
      var out = [];
      document.querySelectorAll(".ga-g").forEach(function (c) { if (c.checked) out.push(c.value); });
      if (gid("ga-other") && gid("ga-other").checked) {
        (gid("ga-other-name").value || "").split(",").forEach(function (n) { n = n.trim(); if (n && out.indexOf(n) < 0) out.push(n); });
      }
      return { none: false, gurus: out };
    }

    /* ---------- 3. conflict check at save time ---------- */
    function fmtT(m) { var h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? "pm" : "am"; var hh = h % 12 || 12; return hh + (mm ? ":" + (mm < 10 ? "0" : "") + mm : "") + ap; }
    function checkConflicts(gurus, dates, s, en, skipEventId) {
      var warns = [], blocks = [];
      gurus.forEach(function (g) {
        dates.forEach(function (d) {
          // unavailability -> hard block
          gd.unavail.forEach(function (u) {
            if (u.guru !== g || !inSpan(d, u.date, u.endDate || u.date)) return;
            if (u.allDay || overlap(t2m(u.start), t2m(u.end), s, en))
              blocks.push("⛔ " + g + " is UNAVAILABLE " + d + " " + (u.allDay ? "(all day)" : (fmtT(t2m(u.start)) + "–" + fmtT(t2m(u.end)))) + (u.notes ? (" — " + u.notes) : ""));
          });
          // other events same guru
          (window.cache && window.cache.events || []).forEach(function (e2) {
            if (!e2 || e2.id === skipEventId) return;
            if (gurusOf(e2.id, d).indexOf(g) < 0) return;
            if (evDatesOf(e2).indexOf(d) < 0) return;
            var s2 = e2.allDay ? 0 : t2m(e2.start), en2 = e2.allDay ? 1440 : t2m(e2.end || e2.start);
            var lbl = (e2.title || "NGH Event") + " " + (e2.allDay ? "(all day)" : (fmtT(s2) + "–" + fmtT(en2)));
            if (overlap(s, en, s2, en2)) warns.push("🔴 " + g + " " + d + ": overlaps \"" + lbl + "\"");
            else { var gap = Math.max(s, s2) - Math.min(en, en2); if (gap >= 0 && gap < TIGHT_MIN) warns.push("🟡 " + g + " " + d + ": only " + gap + " min from \"" + lbl + "\""); }
          });
          // store shifts
          gd.shifts.forEach(function (sh) {
            if (sh.guru !== g) return;
            if (shiftDatesOf(sh).indexOf(d) < 0) return;
            if (overlap(s, en, t2m(sh.open), t2m(sh.close)))
              warns.push("🏪 " + g + " " + d + ": also running the retail store " + fmtT(t2m(sh.open)) + "–" + fmtT(t2m(sh.close)) + " (allowed)");
          });
        });
      });
      return { warns: warns, blocks: blocks };
    }

    /* ---------- 4. wrap app functions ---------- */
    var _rEA = window.renderEventsAdmin;
    window.renderEventsAdmin = function () {
      _rEA.apply(this, arguments);
      // remove the Quick Bulk Import card
      var bt = gid("bulk-text");
      if (bt) { var card = bt.closest(".card"); if (card) card.remove(); }
      injectPicker();
      if (window.editingEventId) fillPicker(window.editingEventId); else clearPicker();
    };

    var _edit = window.editEvent;
    window.editEvent = function (id) { _edit.apply(this, arguments); fillPicker(id); };
    var _dup = window.duplicateEvent;
    if (typeof _dup === "function") window.duplicateEvent = function (id) { _dup.apply(this, arguments); fillPicker(id); };
    var _reset = window.resetEventForm;
    window.resetEventForm = function () { _reset.apply(this, arguments); clearPicker(); };

    var _storeSave = window.Store.saveEvent;
    window.Store.saveEvent = async function (ev) {
      var r = await _storeSave.apply(window.Store, arguments);
      savedDuringCall.push(r || ev);
      return r;
    };

    function pickTarget(list, date) {
      for (var i = list.length - 1; i >= 0; i--) {
        var e = list[i]; if (!e || !e.id) continue;
        if (evDatesOf(e).indexOf(date) >= 0) return e;
      }
      for (var j = list.length - 1; j >= 0; j--) { if (list[j] && list[j].id) return list[j]; }
      return null;
    }

    var _save = window.saveEvent;
    window.saveEvent = async function () {
      var sel = collectPicker();
      var capDate = gid("ev-date") ? gid("ev-date").value : "";
      var allDay = gid("ev-allday") && gid("ev-allday").checked;
      var s = allDay ? 0 : t2m(gid("ev-start") ? gid("ev-start").value : "");
      var en = allDay ? 1440 : t2m(gid("ev-end") ? gid("ev-end").value : "");
      var skipId = window.editingEventId || null;

      if (sel && !sel.none && sel.gurus.length && capDate) {
        await loadGd();
        var dates = [capDate];
        if (gid("ev-recurring") && gid("ev-recurring").checked) {
          var f = gid("ev-rec-freq") ? gid("ev-rec-freq").value : "weekly";
          var c = Math.max(2, Math.min(52, parseInt(gid("ev-rec-count") ? gid("ev-rec-count").value : "2", 10) || 2));
          dates = recDates(capDate, f, c);
        }
        var res = checkConflicts(sel.gurus, dates, s, en, skipId);
        if (res.blocks.length) {
          alert("⛔ Event NOT saved — a selected Guru is marked Unavailable:\n\n" + res.blocks.join("\n") + "\n\nRemove that Guru, pick someone else, or delete the unavailability entry in the Guru Schedule console.");
          return;
        }
        if (res.warns.length) {
          if (!confirm("⚠️ Guru schedule conflicts found:\n\n" + res.warns.join("\n") + "\n\nOne Guru can run multiple things at once when it makes sense.\n\nProceed anyway?")) return;
        }
      }

      savedDuringCall = [];
      await _save.apply(this, arguments);

      if (sel && (sel.none || sel.gurus.length) && savedDuringCall.length) {
        var target = pickTarget(savedDuringCall, capDate);
        if (target) {
          try {
            await gapi("/gurus", { method: "POST", body: JSON.stringify({ action: "save-assignment", item: { id: baseRecId(target.id), eventId: target.id, date: null, gurus: sel.none ? [] : sel.gurus, none: sel.none } }) });
            await loadGd();
          } catch (err) {
            if (err.status === 409 && err.body && err.body.conflicts) {
              alert("⛔ The event was saved, but the Guru assignment was rejected — Guru marked Unavailable:\n\n" + err.body.conflicts.map(function (v) { return v.guru + " on " + v.date + (v.allDay ? " (all day)" : ""); }).join("\n") + "\n\nAssign a different Guru from the Guru Schedule console.");
            } else {
              alert("The event was saved, but the Guru assignment could not be stored (" + err.message + "). You can set it in the Guru Schedule console.");
            }
          }
        }
      }
      savedDuringCall = [];
    };

    // initial data load (needs admin token; retries after login via first save/edit)
    loadGd();

    /* ---------- 5. v1.2 — Guru chips on event cards + per-instance editor ---------- */
    var GURU_COLORS = { "Dustin": "#2e5d3b", "Mike": "#134b57", "Chad": "#9a6310", "Jen": "#7a2b6e", "Sarah": "#b23b3b", "Kyle": "#3b5bb2", "Zach": "#b2622b" };
    var EXTRA_COLORS = ["#4a6d8c", "#8c5a2b", "#2b8c6e", "#8c2b5a", "#5a8c2b", "#6e4a8c"];
    function guruColor(g) {
      if (GURU_COLORS[g]) return GURU_COLORS[g];
      var h = 0; for (var i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) >>> 0;
      return EXTRA_COLORS[h % EXTRA_COLORS.length];
    }
    function guruState(eventId, date) {
      var ov = null, base = null;
      gd.assignments.forEach(function (a) {
        if (a.eventId !== eventId) return;
        if (date != null && a.date === date) ov = a; else if (a.date == null) base = a;
      });
      var a = ov || base;
      if (!a) return { state: "unassigned", gurus: [], rec: a, override: !!ov };
      if (a.none) return { state: "none", gurus: [], rec: a, override: !!ov };
      return { state: "assigned", gurus: a.gurus || [], rec: a, override: !!ov };
    }
    function chipsHTML(st, small) {
      var pad = small ? "1px 8px" : "2px 9px", fs = small ? "0.66rem" : "0.7rem";
      if (st.state === "assigned") {
        return st.gurus.map(function (g) {
          return '<span style="display:inline-block;background:' + guruColor(g) + ';color:#fff;border-radius:50px;padding:' + pad + ';font-size:' + fs + ';font-family:Georgia,serif;margin-left:4px;vertical-align:middle;">🦦 ' + esc(g) + '</span>';
        }).join("") + (st.override ? '<span style="font-size:0.62rem;color:#7a5a14;margin-left:3px;vertical-align:middle;">(this date)</span>' : "");
      }
      if (st.state === "none") return '<span style="display:inline-block;background:#eee;color:#666;border:1px solid #ddd;border-radius:50px;padding:' + pad + ';font-size:' + fs + ';margin-left:4px;vertical-align:middle;">🦦 No Guru needed</span>';
      return '<span style="display:inline-block;background:#fff4dc;color:#9a6310;border:1px solid #e8cf9a;border-radius:50px;padding:' + pad + ';font-size:' + fs + ';margin-left:4px;vertical-align:middle;">🦦 unassigned</span>';
    }
    function decorateEventCards() {
      (window.cache && window.cache.events || []).forEach(function (e) {
        var box = gid("instwrap-" + e.id); if (!box || !box.parentNode) return;
        var h2 = box.parentNode.querySelector("h2"); if (!h2) return;
        var st = guruState(e.id, null);
        var mark = gid("ga-chips-" + e.id);
        if (!mark) {
          mark = document.createElement("span");
          mark.id = "ga-chips-" + e.id;
          h2.appendChild(mark);
        }
        var html = chipsHTML(st, false);
        if (mark.innerHTML !== html) mark.innerHTML = html;
      });
    }
    function decorateInstances() {
      (window.cache && window.cache.events || []).forEach(function (e) {
        if (!e.recurrence) return;
        evDatesOf(e).forEach(function (ds) {
          var span = gid("occtw-" + e.id + "-" + ds); if (!span) return;
          var st = guruState(e.id, ds);
          var mark = gid("ga-occ-" + e.id + "-" + ds);
          if (!mark) {
            mark = document.createElement("span");
            mark.id = "ga-occ-" + e.id + "-" + ds;
            mark.style.display = "inline-flex"; mark.style.alignItems = "center"; mark.style.flexWrap = "wrap";
            span.insertBefore(mark, span.firstChild);
            var btn = document.createElement("button");
            btn.className = "btn btn-sm btn-ghost";
            btn.textContent = "🦦 Gurus";
            btn.addEventListener("click", function () { openOccEditor(e.id, ds); });
            span.insertBefore(btn, mark.nextSibling);
          }
          var html = chipsHTML(st, true);
          if (mark.innerHTML !== html) mark.innerHTML = html;
        });
      });
    }

    /* per-date Guru override editor (small overlay) */
    var occBg = null;
    function closeOccEditor() { if (occBg) { occBg.remove(); occBg = null; } }
    function openOccEditor(eventId, ds) {
      closeOccEditor();
      var e = null; (window.cache.events || []).forEach(function (x) { if (x.id === eventId) e = x; });
      if (!e) return;
      var st = guruState(eventId, ds);           // resolved (override or series)
      var seriesSt = guruState(eventId, null);   // series default, for reference
      var others = st.state === "assigned" ? st.gurus.filter(function (g) { return GURUS.indexOf(g) < 0; }) : [];

      occBg = document.createElement("div");
      occBg.style.cssText = "position:fixed;inset:0;background:rgba(20,30,20,0.55);z-index:9500;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;";
      occBg.addEventListener("click", function (ev) { if (ev.target === occBg) closeOccEditor(); });

      var box = document.createElement("div");
      box.style.cssText = "background:#fff;border-radius:14px;padding:18px 20px;max-width:480px;width:100%;box-shadow:0 18px 50px rgba(0,0,0,0.3);font-family:Georgia,serif;";
      var head = '<div style="font-family:\'Cinzel\',serif;color:var(--forest,#2e5d3b);font-size:0.95rem;margin-bottom:2px;">🦦 Gurus for ' + esc(ds) + '</div>' +
        '<div style="font-size:0.74rem;color:#7a7a5a;margin-bottom:10px;">' + esc(e.title || "NGH Event") + ' — this date only. Series default: ' +
        (seriesSt.state === "assigned" ? esc(seriesSt.gurus.join(" + ")) : seriesSt.state === "none" ? "No Guru needed" : "unassigned") + '.</div>';
      var body = "";
      GURUS.forEach(function (g) {
        var on = st.state === "assigned" && st.gurus.indexOf(g) >= 0;
        body += '<label style="display:inline-flex;align-items:center;gap:5px;border:1.5px solid ' + (on ? "#2e5d3b" : "#d8d4c2") + ';border-radius:50px;padding:5px 11px;margin:3px 4px 3px 0;font-size:0.8rem;cursor:pointer;background:' + (on ? "#eef7f0" : "#fff") + ';"><input type="checkbox" class="gaocc-g" value="' + esc(g) + '" ' + (on ? "checked" : "") + '> ' + esc(g) + '</label>';
      });
      body += '<label style="display:inline-flex;align-items:center;gap:5px;border:1.5px solid #d8d4c2;border-radius:50px;padding:5px 11px;margin:3px 4px 3px 0;font-size:0.8rem;cursor:pointer;background:#fff;"><input type="checkbox" id="gaocc-other" ' + (others.length ? "checked" : "") + '> Other</label>' +
        '<input type="text" id="gaocc-other-name" placeholder="Other name(s), comma-separated" value="' + esc(others.join(", ")) + '" style="display:' + (others.length ? "inline-block" : "none") + ';width:210px;padding:6px 9px;border:1.5px solid #d8d4c2;border-radius:9px;">' +
        '<label style="display:inline-flex;align-items:center;gap:5px;border:1.5px dashed #b8b4a2;border-radius:50px;padding:5px 11px;margin:3px 4px 3px 0;font-size:0.8rem;cursor:pointer;background:#fff;"><input type="checkbox" id="gaocc-none" ' + (st.state === "none" ? "checked" : "") + '> None needed</label>';
      var foot = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">' +
        '<button id="gaocc-save" class="btn btn-sm">💾 Save for this date</button>' +
        (st.override ? '<button id="gaocc-clear" class="btn btn-sm btn-ghost">↩ Use series default</button>' : "") +
        '<button id="gaocc-cancel" class="btn btn-sm btn-ghost">Cancel</button></div>';
      box.innerHTML = head + body + foot;
      occBg.appendChild(box); document.body.appendChild(occBg);

      gid("gaocc-other").addEventListener("change", function () {
        gid("gaocc-other-name").style.display = this.checked ? "inline-block" : "none";
        if (this.checked) gid("gaocc-none").checked = false;
      });
      box.querySelectorAll(".gaocc-g").forEach(function (c) {
        c.addEventListener("change", function () { if (this.checked) gid("gaocc-none").checked = false; });
      });
      gid("gaocc-none").addEventListener("change", function () {
        if (this.checked) {
          box.querySelectorAll(".gaocc-g").forEach(function (c) { c.checked = false; });
          gid("gaocc-other").checked = false; gid("gaocc-other-name").style.display = "none";
        }
      });
      gid("gaocc-cancel").addEventListener("click", closeOccEditor);
      var clearBtn = gid("gaocc-clear");
      if (clearBtn) clearBtn.addEventListener("click", async function () {
        try { await gapi("/gurus", { method: "POST", body: JSON.stringify({ action: "delete-assignment", item: { id: st.rec.id } }) }); } catch (err) { alert("Couldn't clear: " + err.message); return; }
        await loadGd(); closeOccEditor(); decorateInstances(); decorateEventCards();
      });
      gid("gaocc-save").addEventListener("click", async function () {
        var none = gid("gaocc-none").checked;
        var gurus = [];
        box.querySelectorAll(".gaocc-g").forEach(function (c) { if (c.checked) gurus.push(c.value); });
        if (gid("gaocc-other").checked) (gid("gaocc-other-name").value || "").split(",").forEach(function (n) { n = n.trim(); if (n && gurus.indexOf(n) < 0) gurus.push(n); });
        if (!none && !gurus.length) { alert("Pick at least one Guru, or choose None."); return; }
        if (!none && gurus.length) {
          var s = e.allDay ? 0 : t2m(e.start), en = e.allDay ? 1440 : t2m(e.end || e.start);
          var res = checkConflicts(gurus, [ds], s, en, e.id);
          if (res.blocks.length) { alert("⛔ Not saved — Guru marked Unavailable:\n\n" + res.blocks.join("\n")); return; }
          if (res.warns.length && !confirm("⚠️ Conflicts on " + ds + ":\n\n" + res.warns.join("\n") + "\n\nProceed anyway?")) return;
        }
        var existingId = (st.override && st.rec) ? st.rec.id : undefined;
        try {
          await gapi("/gurus", { method: "POST", body: JSON.stringify({ action: "save-assignment", item: { id: existingId, eventId: e.id, date: ds, gurus: none ? [] : gurus, none: none } }) });
        } catch (err) {
          if (err.status === 409) { alert("⛔ Rejected — a selected Guru is marked Unavailable on " + ds + "."); return; }
          alert("Save failed: " + err.message); return;
        }
        await loadGd(); closeOccEditor(); decorateInstances(); decorateEventCards();
      });
    }

    /* ---------- 5b. v1.3 — link detached ("moved") occurrences <-> their series ----------
       Changing one date/time of a recurring event cancels that occurrence and creates a
       standalone event tagged detachedFrom=<seriesId>. Same-date detachments already show
       as "✎ Modified" rows; ones moved to a NEW date vanish from the panel. Surface both
       directions: a "moved off pattern" list inside the instances panel, and a backlink
       on each detached event's own card. */
    function seriesPatternDates(e) {
      if (!e || !e.recurrence) return [];
      return recDates(e.date, e.recurrence.freq, e.recurrence.count, e.recurrence.mode);
    }
    function flashCard(card) {
      if (!card) return;
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      var old = card.style.boxShadow;
      card.style.boxShadow = "0 0 0 4px #c9973a";
      setTimeout(function () { card.style.boxShadow = old; }, 2200);
    }
    function cardOf(eventId) { var b = gid("instwrap-" + eventId); return b ? b.parentNode : null; }
    function jumpToSeries(parentId) {
      var box = gid("instwrap-" + parentId);
      if (!box) { alert("The series card isn't currently in the list — check the event search/filters (or Past events)."); return; }
      if (!box.innerHTML && typeof window.reviewInstances === "function") window.reviewInstances(parentId);
      flashCard(box.parentNode);
    }
    function jumpToEvent(eventId) {
      var card = cardOf(eventId);
      if (!card) { alert("That event's card isn't currently in the list — check the event search/filters (or Past events)."); return; }
      flashCard(card);
    }
    function fmtEvTime(d) { return d.allDay ? "All day" : (fmtT(t2m(d.start)) + "–" + fmtT(t2m(d.end || d.start))); }
    function decorateDetached() {
      var evs = (window.cache && window.cache.events) || [];
      // (a) inside each OPEN instances panel: list detachments moved off the pattern
      evs.forEach(function (e) {
        if (!e.recurrence) return;
        var box = gid("instwrap-" + e.id);
        if (!box || !box.innerHTML) { var stale = gid("ga-det-" + e.id); if (stale) stale.remove(); return; }
        var pattern = seriesPatternDates(e);
        var moved = evs.filter(function (x) { return x.detachedFrom === e.id && pattern.indexOf(x.date) < 0; });
        var mark = gid("ga-det-" + e.id);
        if (!moved.length) { if (mark) mark.remove(); return; }
        if (!mark) {
          mark = document.createElement("div");
          mark.id = "ga-det-" + e.id;
          mark.style.cssText = "margin:8px 0;padding:8px 10px;border:1px dashed #c9b3ea;border-radius:9px;background:#faf6ff;";
          var panel = box.firstElementChild;
          if (panel) {
            var hdr = panel.firstElementChild; // "All instances (N) / Close" row
            panel.insertBefore(mark, hdr ? hdr.nextSibling : panel.firstChild);
          } else box.appendChild(mark);
        }
        var key = moved.map(function (x) { return x.id + x.date + (x.start || ""); }).join("|");
        if (mark.getAttribute("data-key") === key) return;
        mark.setAttribute("data-key", key);
        mark.innerHTML = '<b style="font-size:0.8rem;color:#5b3a8a;">🔗 Moved off the series pattern (' + moved.length + ')</b>';
        moved.sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (d) {
          var row = document.createElement("div");
          row.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:5px 0;font-size:0.8rem;";
          row.innerHTML = '<b>' + esc(d.date) + '</b><span style="color:#4a4a35;">' + esc(fmtEvTime(d)) + '</span><span style="color:#5b3a8a;">' + esc(d.title || "") + '</span><span style="flex:1;"></span>';
          var eb = document.createElement("button"); eb.className = "btn btn-sm btn-ghost"; eb.textContent = "✎ Edit";
          eb.addEventListener("click", function () { if (typeof window.editEvent === "function") window.editEvent(d.id); });
          var sb = document.createElement("button"); sb.className = "btn btn-sm btn-ghost"; sb.textContent = "🧭 Show card";
          sb.addEventListener("click", function () { jumpToEvent(d.id); });
          row.appendChild(eb); row.appendChild(sb);
          mark.appendChild(row);
        });
      });
      // (b) on each detached event's own card: backlink to its series
      evs.forEach(function (d) {
        if (!d.detachedFrom) return;
        var card = cardOf(d.id); if (!card) return;
        if (gid("ga-detline-" + d.id)) return;
        var parent = null; evs.forEach(function (x) { if (x.id === d.detachedFrom) parent = x; });
        var line = document.createElement("div");
        line.id = "ga-detline-" + d.id;
        line.style.cssText = "margin:4px 0;font-size:0.8rem;color:#5b3a8a;display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
        line.innerHTML = '🔁 Detached from recurring series' + (parent ? (': <b>' + esc(parent.title || parent.id) + '</b>') : ' (series no longer exists)');
        if (parent) {
          var vb = document.createElement("button"); vb.className = "btn btn-sm btn-ghost"; vb.textContent = "🔗 View series & instances";
          vb.addEventListener("click", function () { jumpToSeries(parent.id); });
          line.appendChild(vb);
        }
        var header = card.firstElementChild;
        if (header && header.nextSibling) card.insertBefore(line, header.nextSibling); else card.appendChild(line);
      });
    }

    /* ---------- 6. self-healing watchdog ----------
       The add-on loads async, so the events view may already be rendered
       (or get re-rendered by code paths we haven't wrapped). Every second,
       make sure our UI is in place. Cheap no-op when everything's present. */
    function applyNow() {
      var pb = gid("view-promos-btn");
      if (pb && !gid("guru-sched-link")) {
        var a2 = document.createElement("a");
        a2.id = "guru-sched-link"; a2.className = "btn btn-sm btn-ghost";
        a2.href = "guru-schedule.html"; a2.textContent = "🦦 Guru Schedule";
        a2.style.textDecoration = "none"; a2.style.display = "inline-flex"; a2.style.alignItems = "center";
        pb.parentNode.insertBefore(a2, pb.nextSibling);
      }
      var bt = gid("bulk-text");
      if (bt) { var card = bt.closest(".card"); if (card) card.remove(); }
      if (gid("ev-save-btn") && !gid("ga-picker")) {
        injectPicker();
        if (window.editingEventId) fillPicker(window.editingEventId);
      }
      decorateEventCards();
      decorateInstances();
      decorateDetached();
    }
    applyNow();
    setInterval(applyNow, 1000);
    loadGd().then(function () { decorateEventCards(); decorateInstances(); });
  });
})();
