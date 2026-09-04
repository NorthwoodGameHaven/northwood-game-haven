package guru.gamehaven.tv

// NGH TV kiosk shell — NGH-BUILD 2026-09-04a
// Relaunches the display after a reboot / power blip so morning opening
// is plug-and-forget. Note: Android 10+ restricts background activity
// starts; on Google TV this works once the app has been opened normally
// at least once. If a unit ever boots to the home screen instead, one
// click on the NGH TV tile brings it back.

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            val i = Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try { context.startActivity(i) } catch (_: Exception) {}
        }
    }
}
