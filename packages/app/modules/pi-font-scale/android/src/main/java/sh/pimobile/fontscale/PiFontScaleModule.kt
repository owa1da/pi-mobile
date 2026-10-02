package sh.pimobile.fontscale

import com.facebook.react.ReactApplication
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * React Native keeps text measured at the old font scale when the system font size changes while
 * the app runs (labels clip, rows overlap); a cold start measures correctly. Reloading the React
 * host re-measures everything at the new scale.
 */
class PiFontScaleModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PiFontScale")

    Function("reloadForFontScale") {
      val app = appContext.reactContext?.applicationContext as? ReactApplication
        ?: return@Function false
      val activity = appContext.currentActivity ?: return@Function false
      activity.runOnUiThread { app.reactHost?.reload("system font scale changed") }
      true
    }
  }
}
