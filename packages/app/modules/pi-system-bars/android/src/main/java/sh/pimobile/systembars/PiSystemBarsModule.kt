package sh.pimobile.systembars

import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import com.facebook.react.ReactApplication
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Immersive mode for the collapsed landscape terminal: hides the status and navigation bars; an
 * edge swipe shows them transiently. Platform APIs only (no androidx dependency).
 */
class PiSystemBarsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PiSystemBars")

    // React Native keeps text measured at the old font scale when the system font size changes
    // while the app runs (labels clip, rows overlap); a cold start measures correctly. Reloading
    // the React host re-measures everything at the new scale.
    Function("reloadForFontScale") {
      val app = appContext.reactContext?.applicationContext as? ReactApplication
        ?: return@Function false
      val activity = appContext.currentActivity ?: return@Function false
      activity.runOnUiThread { app.reactHost?.reload("system font scale changed") }
      true
    }

    Function("setImmersive") { immersive: Boolean ->
      val activity = appContext.currentActivity ?: return@Function false
      activity.runOnUiThread {
        val window = activity.window
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          val controller = window.insetsController ?: return@runOnUiThread
          if (immersive) {
            controller.systemBarsBehavior =
              WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsets.Type.systemBars())
          } else {
            controller.show(WindowInsets.Type.systemBars())
          }
        } else {
          @Suppress("DEPRECATION")
          window.decorView.systemUiVisibility =
            if (immersive) {
              View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            } else {
              View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            }
        }
      }
      true
    }
  }
}
