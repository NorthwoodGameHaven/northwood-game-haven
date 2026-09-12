#!/usr/bin/env node
// patches/patch-app-2026-09-11a.cjs — NGH-BUILD 2026-09-11a
// Surgical patches for the two big pages this build touches (never full-file
// deliveries): site/booking.html (Guru Console + approval emails: Lightspeed
// "pay on account") and site/events.html (My registrations: on-account label).
//
// Usage (repo root):   node patches\patch-app-2026-09-11a.cjs
//   - every anchor must occur exactly once or the file is left untouched
//   - re-run safe: files already carrying the build marker are skipped
//   - CRLF preserved; patched inline <script> blocks are compiled with vm.Script
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.argv[2] || process.cwd();
const MARK = 'NGH-BUILD 2026-09-11a';
let failed = false;

function validateHtml(src, file) {
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi; let m, n = 0;
  while ((m = re.exec(src))) { if (/ld\+json|application\/json/i.test(m[1])) continue; n++; new vm.Script(m[2], { filename: file + '#script' + n }); }
  return n;
}
function patchFile(rel, edits) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { console.error('✗ missing', rel); failed = true; return; }
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.indexOf(MARK) >= 0) { console.log('• already patched (skipped):', rel); return; }
  const crlf = raw.indexOf('\r\n') >= 0;
  let src = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  for (const [label, anchor, replacement] of edits) {
    const count = src.split(anchor).length - 1;
    if (count !== 1) { console.error('✗ ' + rel + ': anchor "' + label + '" found ' + count + '× (need exactly 1) — file left untouched'); failed = true; return; }
    src = src.replace(anchor, function () { return replacement; });
  }
  try { const n = validateHtml(src, rel); console.log('  vm.Script ok on', n, 'inline scripts'); }
  catch (e) { console.error('✗ ' + rel + ': patched script failed to compile — file left untouched:', e.message); failed = true; return; }
  const out = crlf ? src.replace(/\n/g, '\r\n') : src;
  fs.writeFileSync(file, out, 'utf8');
  console.log('✓ patched', rel, '(' + raw.length + ' → ' + out.length + ' bytes, ' + (out.length - raw.length >= 0 ? '+' : '') + (out.length - raw.length) + ')');
}

// ------------------------------------------------------------------ booking.html
const BK_HELPERS = String.raw`<!-- NGH-BUILD 2026-09-11a · Lightspeed pay-on-account -->
<script>
/* NGH-BUILD 2026-09-11a — Lightspeed X-Series "pay on account".
   Buttons appear only when window.NGH_LIGHTSPEED_ONACCOUNT === true (ngh-config.js).
   The server writes an ON-ACCOUNT sale to Lightspeed; a Guru then sends the
   Lightspeed Payments pay link from Sell → Sales history, or the guest pays at the counter. */
(function(){
  function on(){ return window.NGH_LIGHTSPEED_ONACCOUNT === true; }
  window.lsOnAcctBadge = function(r){
    if(!r || !(r.feeOnAccount || r.depositOnAccount)) return '';
    var parts=[]; if(r.feeOnAccount) parts.push('fee'); if(r.depositOnAccount) parts.push('deposit');
    return '<span class="badge" style="background:#e8f2f6;color:#1f6f8b;border:1px solid #bcd9e4" title="Lightspeed on-account sale — send the pay link from Lightspeed Sell → Sales history">🧾 On account: '+parts.join(' + ')+'</span>';
  };
  window.lsOnAcctActions = function(r){
    if(!on() || !r || r.status!=="approved") return '';
    var feeOpen = !feeIsPaid(r) && !r.feeOnAccount;
    var depOpen = !depIsPaid(r) && !r.depositOnAccount && Number(r.deposit)!==0;
    var part = (feeOpen && depOpen) ? 'both' : (feeOpen ? 'fee' : (depOpen ? 'deposit' : ''));
    if(!part) return '';
    var lbl = part==='both' ? '🧾 Fee + deposit on account' : (part==='fee' ? '🧾 Fee on account' : '🧾 Deposit on account');
    return '<button class="btn btn-sm btn-ghost" onclick="lsPutOnAccount(\'booking\',\''+r.id+'\',\''+part+'\')">'+lbl+'</button>';
  };
  window.lsRegOnAcctBtn = function(r, eventId){
    if(!on() || !r || r.__manual || r.status==="canceled" || !(Number(r.cost)>0) || r.feePaid || r.payment==="onaccount") return '';
    return '<button class="btn btn-sm btn-ghost" onclick="lsPutOnAccount(\'registration\',\''+r.id+'\',\'\',\''+(eventId||'')+'\')">🧾 Put on account</button>';
  };
  window.lsPutOnAccount = async function(kind, id, part, eventId){
    if(!confirm("Write this to Lightspeed as an ON-ACCOUNT sale on the customer's account?\n\nThey'll be emailed that a pay link (or counter payment) will follow. Card pay links for this item stop working.")) return;
    try{
      var res = await fetch(API_BASE + "/create-checkout", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ kind:kind, id:id, part:part||undefined, method:"onaccount" }) });
      var j = await res.json().catch(function(){ return {}; });
      if(!res.ok){ alert("Couldn't put it on account: " + (j.error || res.status)); return; }
      alert("On account ✓ — $" + (Number(j.amountCents||0)/100).toFixed(2) + " written to Lightspeed.\n\nNext: Lightspeed → Sell → Sales history → open the sale → \"Email receipt with pay link\".");
      if(kind === 'registration' && eventId && typeof viewRegistrants === 'function'){ try{ await viewRegistrants(eventId); }catch(e){} }
      else { try{ await refreshCache(); renderAdmin(adminFilter); }catch(e){} }
    }catch(e){ alert("Couldn't put it on account: " + e.message); }
  };
  try{
    var qs = new URLSearchParams(location.search), oa = qs.get("onaccount");
    if(oa){
      var d = document.createElement("div"); d.setAttribute("role","status");
      d.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:99999;background:#fff;border:2px solid #2d5a3d;border-radius:14px;padding:14px 18px;max-width:92vw;box-shadow:0 10px 30px rgba(0,0,0,.2);font-family:Georgia,serif;color:#23351f;text-align:center";
      var what = oa==="both" ? "Your booking fee and deposit" : (oa==="deposit" ? "Your refundable deposit" : "Your booking fee");
      d.innerHTML = "<b>🧾 It's on your Haven account</b><div style='font-size:.9rem;margin-top:4px'>" + what + " for " + String(qs.get("id")||"your booking").replace(/[<>&"]/g,"") + " is on your Northwood Game Haven account. Pay at the counter or with the secure Lightspeed pay link we email you.</div><button style='margin-top:8px;border:0;background:#2d5a3d;color:#fff;border-radius:40px;padding:6px 16px;cursor:pointer'>OK</button>";
      d.querySelector("button").onclick = function(){ d.remove(); };
      (document.body || document.documentElement).appendChild(d);
    }
  }catch(e){}
})();
</script>
<!-- NGH-BUILD 2026-08-06v · Guru Console naming -->
</html>`;

patchFile('site/booking.html', [
  ['pay badges',
    String.raw`'<span class="badge '+(depIsPaid(r)?"pay-paid":"pay-due")+'">Deposit: '+(depIsPaid(r)?"Paid":"Due")+'</span>';`,
    String.raw`'<span class="badge '+(depIsPaid(r)?"pay-paid":"pay-due")+'">Deposit: '+(depIsPaid(r)?"Paid":"Due")+'</span>'+(window.lsOnAcctBadge?lsOnAcctBadge(r):''); /* NGH-BUILD 2026-09-11a */`],
  ['console actions',
    String.raw`if(!depIsPaid(r)) actions+='<button class="btn btn-sm btn-ghost" onclick="genPayLink(\''+r.id+'\',\'deposit\')">🔗 Deposit pay-link</button>';`,
    String.raw`if(!depIsPaid(r)) actions+='<button class="btn btn-sm btn-ghost" onclick="genPayLink(\''+r.id+'\',\'deposit\')">🔗 Deposit pay-link</button>';
    if(window.lsOnAcctActions) actions+=lsOnAcctActions(r); /* NGH-BUILD 2026-09-11a */`],
  ['auto-cancel guard',
    String.raw`if(r.status==="approved" && !feeIsPaid(r) && !depIsPaid(r)){ /* NGH-BUILD 2026-09-10c`,
    String.raw`if(r.status==="approved" && !feeIsPaid(r) && !depIsPaid(r) && !r.feeOnAccount && !r.depositOnAccount && r.payment!=="onaccount"){ /* NGH-BUILD 2026-09-11a: + on-account; NGH-BUILD 2026-09-10c`],
  ['approval email buttons',
    String.raw`if(!depIsPaid(r)) buttons.push({label:"Pay Refundable Deposit Now", url:payLinkUrl("booking", id, "deposit"), primary:false});`,
    String.raw`if(!depIsPaid(r)) buttons.push({label:"Pay Refundable Deposit Now", url:payLinkUrl("booking", id, "deposit"), primary:false});
  if(window.NGH_LIGHTSPEED_ONACCOUNT===true && (!feeIsPaid(r) || !depIsPaid(r))) buttons.push({label:"Put it on my Haven account (pay in store)", url:payLinkUrl("booking", id, (!feeIsPaid(r) && !depIsPaid(r)) ? "both" : (!feeIsPaid(r) ? "fee" : "deposit"))+"&method=onaccount", primary:false}); /* NGH-BUILD 2026-09-11a */`],
  ['registrant paid/due label',
    String.raw`(r.feePaid?' <span style="color:#2e7d32;">paid</span>':' <span style="color:#9a6310;">due</span>')`,
    String.raw`(r.feePaid?' <span style="color:#2e7d32;">paid</span>':(r.payment==="onaccount"?' <span style="color:#1f6f8b;">🧾 on account</span>':' <span style="color:#9a6310;">due</span>'))`],
  ['registrant can-email-pay',
    String.raw`var canEmailPay = (!canceled && Number(r.cost)>0 && !r.feePaid && r.email);`,
    String.raw`var canEmailPay = (!canceled && Number(r.cost)>0 && !r.feePaid && r.payment!=="onaccount" && r.email); /* NGH-BUILD 2026-09-11a: + on-account */`],
  ['registrant on-account button',
    String.raw`((!canceled && Number(r.cost)>0 && !r.feePaid && !r.email)?('<button class="btn btn-sm btn-ghost" onclick="copyRegPaymentLink(\''+r.id+'\')">🔗 Copy payment link</button>'):'')+`,
    String.raw`((!canceled && Number(r.cost)>0 && !r.feePaid && !r.email)?('<button class="btn btn-sm btn-ghost" onclick="copyRegPaymentLink(\''+r.id+'\')">🔗 Copy payment link</button>'):'')+
          (window.lsRegOnAcctBtn?lsRegOnAcctBtn(r, eventId):'')+ /* NGH-BUILD 2026-09-11a */`],
  ['helpers before </html>',
    '<!-- NGH-BUILD 2026-08-06v · Guru Console naming -->\n</html>',
    BK_HELPERS],
]);

// ------------------------------------------------------------------ events.html
patchFile('site/events.html', [
  ['my-registrations status',
    String.raw`(rg.feePaid?" (paid)":" (due)")`,
    String.raw`(rg.feePaid?" (paid)":(rg.payment==="onaccount"?" (on your Haven account)":" (due)"))/* NGH-BUILD 2026-09-11a */`],
  ['my-registrations pay button',
    String.raw`(rg.status!=="canceled" && rg.cost>0 && !rg.feePaid?'<button onclick="CAL.payreg(`,
    String.raw`(rg.status!=="canceled" && rg.cost>0 && !rg.feePaid && rg.payment!=="onaccount"?'<button onclick="CAL.payreg(`],
]);

if (failed) { console.error('\nPATCH INCOMPLETE — fix the anchors above (fresh repo pull?) and re-run.'); process.exit(1); }
console.log('\nAll patches applied. Verify with: findstr /M /C:"' + MARK + '" site\\booking.html site\\events.html');
