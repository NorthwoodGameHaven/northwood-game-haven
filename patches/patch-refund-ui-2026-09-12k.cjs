// patches/patch-refund-ui-2026-09-12k.cjs — NGH-BUILD 2026-09-12k
// Adds the Guru Console refund UI to site/booking.html.
//
// Why: POST /bookings/:id/refund has existed since 2026-09-12c but nothing in
// the console called it, so the only way to refund a booking was the API. And
// "Cancel / Reject" on a PAID booking still set status=rejected and emailed
// "we're unable to confirm your request" while keeping the customer's money.
//
// Design (Dustin's choice, 2026-09-12): cancelling PROMPTS the Guru to pick
// what comes back rather than auto-refunding everything — so a late-cancellation
// policy stays a human decision and nothing is given away by accident.
//
// Run from the repo root:  node patches/patch-refund-ui-2026-09-12k.cjs
// Idempotent, CRLF-preserving, and validates the result parses before writing.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join('site', 'booking.html');
const MARK = 'NGH-BUILD 2026-09-12k';

if (!fs.existsSync(FILE)) { console.error('[X] run this from the repo root — ' + FILE + ' not found'); process.exit(1); }
let src = fs.readFileSync(FILE, 'utf8');
if (src.includes(MARK)) { console.log('[=] booking.html already patched (' + MARK + ')'); process.exit(0); }

const crlf = src.indexOf('\r\n') !== -1;
if (crlf) src = src.replace(/\r\n/g, '\n');

let edits = 0;
function replaceOnce(needle, replacement, label) {
  const n = src.split(needle).length - 1;
  if (n !== 1) { console.error('[X] anchor ' + (n === 0 ? 'not found' : 'matched ' + n + ' times') + ': ' + label); process.exit(1); }
  src = src.replace(needle, replacement);
  edits++;
  console.log('    [' + edits + '] ' + label);
}

// ---- 1. Refund button on approved bookings that actually took money ---------
replaceOnce(
  `    actions+='<button class="btn btn-sm btn-danger" onclick="reject(\\''+r.id+'\\')">Cancel / Reject</button>';`,
  `    if(refundablePartsOf(r).length) actions+='<button class="btn btn-sm btn-danger" onclick="refundToggle(\\''+r.id+'\\')">💸 Refund / cancel</button>';   /* ${MARK} */
    actions+='<button class="btn btn-sm btn-danger" onclick="reject(\\''+r.id+'\\')">Cancel / Reject</button>';`,
  'refund button on the approved-booking action row');

// ---- 2. Render the panel inside the card ------------------------------------
replaceOnce(
  `    ((r.status==="pending"||r.status==="hold"||r.status==="approved")?depositAdjustBox(r):"")+`,
  `    ((r.status==="pending"||r.status==="hold"||r.status==="approved")?depositAdjustBox(r):"")+
    refundBox(r)+   /* ${MARK} */`,
  'refund panel in the card template');

// ---- 3. The panel + the call ------------------------------------------------
replaceOnce(
  `function depositAdjustBox(r){`,
  `/* ===== ${MARK}: refund / cancel =========================================
   Only the parts that were actually PAID BY CARD can be refunded here — a
   booking marked paid in person has no Stripe payment intent, so the money has
   to go back at the register. The server enforces that too; this just avoids
   offering a button that cannot work. */
function refundablePartsOf(r){
  var out=[];
  var done=(r.refunds||[]).map(function(x){ return x.part; });
  if(feeIsPaid(r) && r.feePI && done.indexOf("fee")<0) out.push({ part:"fee", label:"Booking fee", cents:(r.feePaidCents!=null?r.feePaidCents:Math.round((r.costBooking||0)*100)) });
  if(depIsPaid(r) && r.depositPI && done.indexOf("deposit")<0) out.push({ part:"deposit", label:"Refundable deposit", cents:(r.depositPaidCents!=null?r.depositPaidCents:Math.round((r.deposit||0)*100)) });
  return out;
}
function refundBox(r){
  var parts=refundablePartsOf(r);
  var prior=(r.refunds||[]);
  if(!parts.length && !prior.length) return "";
  var h='<details class="adv" id="refbox-'+r.id+'">'+
    '<summary>Refund / cancel'+(prior.length?(' · <span style="color:#2e7d32;">'+prior.length+' already refunded</span>'):'')+'</summary>'+
    '<div style="padding:10px 0;font-size:0.86rem;">';
  prior.forEach(function(x){
    h+='<div class="kv" style="color:#2e7d32;">✓ '+esc(x.part)+' — '+fmtMoney((x.amountCents||0)/100)+' refunded '+esc(String(x.at||"").slice(0,10))+
       (x.lightspeedError?(' <b style="color:#c0392b;">· Lightspeed NOT reversed: '+esc(x.lightspeedError)+'</b> <button class="btn btn-sm btn-ghost" onclick="doRefund(\\''+r.id+'\\',true)">Retry books only</button>'):'')+'</div>';
  });
  if(parts.length){
    h+='<div style="margin:8px 0 4px;">Choose what to send back to the card:</div>';
    parts.forEach(function(p){
      h+='<label style="display:block;margin:4px 0;"><input type="checkbox" id="ref-'+r.id+'-'+p.part+'" checked> '+p.label+' — <b>'+fmtMoney(p.cents/100)+'</b></label>';
    });
    h+='<label style="display:block;margin:8px 0 4px;"><input type="checkbox" id="ref-'+r.id+'-cancel" checked> Cancel the booking as well (frees the room and emails the guest)</label>'+
       '<input type="text" id="ref-'+r.id+'-reason" placeholder="Reason (optional — included in the email)" style="width:100%;margin:6px 0;">'+
       '<button class="btn btn-sm btn-danger" onclick="doRefund(\\''+r.id+'\\')">💸 Refund now</button>'+
       '<div style="margin-top:6px;color:#777;">Stripe keeps its processing fee on a refund. The matching Lightspeed sale is reversed too, so revenue, tax and the customer\\u2019s loyalty points all come back off.</div>';
  }
  h+='</div></details>';
  return h;
}
function refundToggle(id){ var d=document.getElementById("refbox-"+id); if(d){ d.open=true; d.scrollIntoView({block:"center"}); } }
async function doRefund(id, lightspeedOnly){
  var r=getReq(id); if(!r) return;
  var body={};
  if(lightspeedOnly){ body={ parts:["fee","deposit"], lightspeedOnly:true }; }
  else{
    var parts=[];
    refundablePartsOf(r).forEach(function(p){ var el=document.getElementById("ref-"+id+"-"+p.part); if(el&&el.checked) parts.push(p.part); });
    if(!parts.length){ alert("Tick at least one thing to refund."); return; }
    var cancelEl=document.getElementById("ref-"+id+"-cancel");
    var reasonEl=document.getElementById("ref-"+id+"-reason");
    var total=0; refundablePartsOf(r).forEach(function(p){ if(parts.indexOf(p.part)>=0) total+=p.cents; });
    if(!confirm("Refund "+fmtMoney(total/100)+" to "+(r.name||"the guest")+" for "+id+"?\\n\\n"+parts.join(" + ")+(cancelEl&&cancelEl.checked?"\\n\\nThe booking will also be canceled.":"")+"\\n\\nThis cannot be undone.")) return;
    body={ parts:parts, cancel:!!(cancelEl&&cancelEl.checked), reason:(reasonEl?reasonEl.value.trim():"") };
  }
  try{
    var res=await Store._api("/bookings/"+encodeURIComponent(id)+"/refund", { method:"POST", body:JSON.stringify(body) });
    var lines=(res.results||[]).map(function(x){
      if(x.skipped) return "• "+x.part+": skipped ("+x.reason+")";
      if(x.ok===false) return "• "+x.part+": FAILED — "+x.error;
      return "• "+x.part+": "+fmtMoney((x.amountCents||0)/100)+" refunded · Lightspeed "+x.lightspeed;
    }).join("\\n");
    alert("Refund processed for "+id+"\\n\\n"+lines);
    await refreshCache(); renderAdmin(adminFilter);
  }catch(e){ alert("Refund failed: "+(e&&e.message?e.message:e)); }
}

function depositAdjustBox(r){`,
  'refundBox / refundablePartsOf / doRefund');

// ---- 4. Stop "Cancel / Reject" silently keeping a paid booking's money ------
replaceOnce(
  `async function reject(id){
  var r=getReq(id); if(!r) return;
  if(!confirm("Reject/cancel this booking for "+r.name+"?")) return;`,
  `async function reject(id){
  var r=getReq(id); if(!r) return;
  /* ${MARK}: this route sets status=rejected and sends the "unable to confirm
     your request" email. On a PAID booking that is the wrong message AND keeps
     the guest's money — send them to the refund panel instead. */
  if(refundablePartsOf(r).length){
    alert("This booking has been paid.\\n\\nUse \\u201c\\uD83D\\uDCB8 Refund / cancel\\u201d instead so the money goes back and the guest gets a cancellation email rather than a rejection.");
    refundToggle(id); return;
  }
  if(!confirm("Reject/cancel this booking for "+r.name+"?")) return;`,
  'guard reject() on paid bookings');

// ---- validate + write -------------------------------------------------------
const scripts = src.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
let checked = 0;
for (const block of scripts) {
  const body = block.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '');
  // Only executable JS. A type attribute that isn't a JS mime (ld+json,
  // importmap, text/template…) is data, not code — booking.html carries an
  // application/ld+json block that will never parse as a script.
  const type = (block.match(/type\s*=\s*["']([^"']+)["']/i) || [])[1];
  const isJs = !type || /^(module|text\/javascript|application\/javascript)$/i.test(type.trim());
  if (!body.trim() || !isJs) continue;
  try { new vm.Script(body); checked++; }
  catch (e) { console.error('[X] patched JS does not parse: ' + e.message); process.exit(1); }
}

if (crlf) src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(FILE, src);
console.log('[ok] ' + edits + ' edits applied to ' + FILE + ' (' + checked + ' script blocks parse)');
