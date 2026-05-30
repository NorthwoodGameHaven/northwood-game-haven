/* =====================================================================
   NORTHWOOD GAME HAVEN — front-end config
   ---------------------------------------------------------------------
   This single file decides whether booking.html runs in:

     • DEMO MODE  (default)  — everything is stored in the visitor's own
       browser via localStorage. No server needed. Great for previewing
       the design, but each device has its own separate data and emails
       are only logged to the browser console.

     • LIVE SERVER MODE      — set NGH_API_BASE to your Netlify Functions
       path ("/.netlify/functions"). All staff devices then share one
       database, double-booking is enforced server-side, real emails are
       sent, and the admin login is checked on the server.

   To go live: uncomment the NGH_API_BASE line below and deploy
   (see DEPLOY.md). That's the only front-end change required.
   ===================================================================== */

/* ---- LIVE SERVER MODE: uncomment the next line after deploying ---- */
// window.NGH_API_BASE = "/.netlify/functions";

/* ---- Shown on emails / the success screen ---- */
window.NGH_ADMIN_EMAIL = "stash@northwoodgamehaven.com";

/* ---- DEMO-ONLY staff gate code. Ignored in live server mode, where
        the real password lives in a Netlify environment variable. ---- */
window.NGH_ADMIN_CODE = "stash2026";
