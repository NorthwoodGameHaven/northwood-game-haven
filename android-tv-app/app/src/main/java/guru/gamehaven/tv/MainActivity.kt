package guru.gamehaven.tv

// NGH TV kiosk shell — NGH-BUILD 2026-09-04a (recovered from 2026-08-24c)
// Fullscreen WebView locked to the NGH TV Network display client.
// - First run: on-screen dialog asks for the device name (holt/den/…),
//   stored in SharedPreferences; the page URL becomes
//   https://gamehaven.guru/tv?d=<name>&app=1
// - Immersive, keep-screen-on, landscape; survives config changes.
// - Network/HTTP errors show a branded retry screen and auto-reload
//   every 8 s (and immediately when connectivity returns).
// - Remote: MENU opens settings; pressing BACK 3× within 2 s also opens
//   settings (single BACK presses are swallowed so guests can't exit).

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    companion object {
        const val BASE = "https://gamehaven.guru/tv"
        const val PREFS = "ngh_tv"
        const val KEY_NAME = "device_name"
    }

    private lateinit var web: WebView
    private val handler = Handler(Looper.getMainLooper())
    private var inError = false
    private var backPresses = mutableListOf<Long>()
    private val retry = object : Runnable {
        override fun run() {
            if (inError) { loadHome(); handler.postDelayed(this, 8000) }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web = WebView(this)
        setContentView(web, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        web.setBackgroundColor(0xFF132A1D.toInt())
        web.isFocusable = false          // page needs no D-pad focus; keep keys with us
        web.isFocusableInTouchMode = false

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // stay inside the site; anything else is ignored on a kiosk
                return request.url.host?.endsWith("gamehaven.guru") != true
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showErrorPage()
            }
            override fun onPageFinished(view: WebView, url: String?) {
                if (url != null && url.startsWith("data:") == false) inError = false
            }
        }

        watchConnectivity()

        val name = prefs().getString(KEY_NAME, null)
        if (name.isNullOrBlank()) showSetupDialog(first = true) else loadHome()
    }

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun deviceName(): String = prefs().getString(KEY_NAME, "") ?: ""

    private fun loadHome() {
        val n = deviceName()
        if (n.isBlank()) { showSetupDialog(first = true); return }
        web.loadUrl("$BASE?d=$n&app=1")
    }

    private fun showErrorPage() {
        inError = true
        val html = """
            <html><body style="margin:0;height:100vh;display:flex;flex-direction:column;
              align-items:center;justify-content:center;background:#132a1d;color:#f6efdd;
              font-family:sans-serif;text-align:center">
              <div style="font-size:6vmin;color:#e8b84b;font-weight:800">NGH TV</div>
              <div style="font-size:3.2vmin;margin-top:2vmin">Reconnecting to the Haven…</div>
              <div style="font-size:2.4vmin;opacity:.7;margin-top:1vmin">retrying automatically</div>
            </body></html>""".trimIndent()
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
        handler.removeCallbacks(retry)
        handler.postDelayed(retry, 8000)
    }

    private fun watchConnectivity() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                runOnUiThread { if (inError) loadHome() }
            }
        })
    }

    private fun showSetupDialog(first: Boolean) {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            hint = "holt · den · depths · raft · deck · lodge · rest"
            setText(deviceName())
        }
        val b = AlertDialog.Builder(this)
            .setTitle("NGH TV — display name")
            .setMessage("Which TV is this? Lowercase, dashes ok.")
            .setView(input)
            .setCancelable(!first)
            .setPositiveButton("Save") { _, _ ->
                val clean = input.text.toString().lowercase()
                    .replace(Regex("[^a-z0-9-]+"), "-").trim('-').take(40)
                if (clean.isNotBlank()) {
                    prefs().edit().putString(KEY_NAME, clean).apply()
                    loadHome()
                } else if (first) showSetupDialog(true)
            }
        if (!first) {
            b.setNeutralButton("Reload") { _, _ -> loadHome() }
            b.setNegativeButton("Exit app") { _, _ -> finishAffinity() }
        }
        b.show()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_MENU -> { showSetupDialog(first = false); return true }
            KeyEvent.KEYCODE_BACK -> {
                val now = System.currentTimeMillis()
                backPresses.add(now)
                backPresses = backPresses.filter { now - it < 2000 }.toMutableList()
                if (backPresses.size >= 3) { backPresses.clear(); showSetupDialog(first = false) }
                return true // swallow BACK: guests can't exit the kiosk
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                if (inError) loadHome()
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onResume() {
        super.onResume()
        hideSystemUi()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
    }
}
