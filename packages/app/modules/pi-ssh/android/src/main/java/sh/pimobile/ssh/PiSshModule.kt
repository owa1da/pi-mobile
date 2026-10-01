package sh.pimobile.ssh

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.RejectedExecutionException

/**
 * Expo binding for [SshCore]. Blocking work runs on the core's worker pool; promises are settled
 * from there. Events: onHostKey, onShellData, onShellClose, onConnectionClose.
 */
class PiSshModule : Module() {
  private var coreInstance: SshCore? = null

  private val core: SshCore
    get() = synchronized(this) {
      coreInstance ?: SshCore { name, body ->
        sendEvent(name, body)
      }.also { coreInstance = it }
    }

  private fun run(promise: Promise, block: () -> Any?) {
    val c = core
    try {
      c.pool.execute {
        try {
          promise.resolve(block())
        } catch (e: SshError) {
          promise.reject(e.code, e.message, e)
        } catch (t: Throwable) {
          promise.reject("ERR_SSH_INTERNAL", t.message ?: t.javaClass.name, t)
        }
      }
    } catch (e: RejectedExecutionException) {
      promise.reject("ERR_SSH_INTERNAL", "SSH worker pool is shut down", e)
    }
  }

  private fun optString(map: Map<String, Any?>, key: String): String? =
    (map[key] as? String)?.takeIf { it.isNotEmpty() }

  private fun optInt(map: Map<String, Any?>, key: String, def: Int): Int =
    (map[key] as? Number)?.toInt() ?: def

  override fun definition() = ModuleDefinition {
    Name("PiSsh")

    Events("onHostKey", "onShellData", "onShellClose", "onConnectionClose")

    // options: { connectionId, host, port, username, password?, privateKey?, passphrase?,
    //            timeoutMs?, hostKeyTimeoutMs?, keepaliveIntervalMs? }
    AsyncFunction("connect") { options: Map<String, Any?>, promise: Promise ->
      run(promise) {
        val id = optString(options, "connectionId")
          ?: throw SshError(SshErrorCodes.INVALID_ARGUMENT, "connectionId is required")
        core.connect(
          id = id,
          host = (options["host"] as? String) ?: "",
          port = optInt(options, "port", 22),
          username = (options["username"] as? String) ?: "",
          password = options["password"] as? String,
          privateKey = optString(options, "privateKey"),
          passphrase = optString(options, "passphrase"),
          timeoutMs = optInt(options, "timeoutMs", 20_000),
          hostKeyTimeoutMs = optInt(options, "hostKeyTimeoutMs", 120_000),
          keepaliveMs = optInt(options, "keepaliveIntervalMs", 15_000),
        )
      }
    }

    Function("respondHostKey") { requestId: String, accept: Boolean ->
      core.respondHostKey(requestId, accept)
    }

    AsyncFunction("exec") { connectionId: String, command: String, stdin: String?, timeoutMs: Double?, promise: Promise ->
      run(promise) { core.exec(connectionId, command, stdin, timeoutMs?.toInt()) }
    }

    // options: { connectionId, shellId, cols, rows, term?, command? }
    AsyncFunction("openShell") { options: Map<String, Any?>, promise: Promise ->
      run(promise) {
        val connId = optString(options, "connectionId")
          ?: throw SshError(SshErrorCodes.INVALID_ARGUMENT, "connectionId is required")
        val shellId = optString(options, "shellId")
          ?: throw SshError(SshErrorCodes.INVALID_ARGUMENT, "shellId is required")
        core.openShell(
          connId = connId,
          shellId = shellId,
          cols = optInt(options, "cols", 80),
          rows = optInt(options, "rows", 24),
          term = optString(options, "term") ?: "xterm-256color",
          command = optString(options, "command"),
        )
      }
    }

    Function("write") { shellId: String, base64: String ->
      core.write(shellId, base64)
    }

    Function("resize") { shellId: String, cols: Int, rows: Int ->
      core.resize(shellId, cols, rows)
    }

    Function("closeShell") { shellId: String ->
      core.closeShell(shellId)
    }

    Function("isConnected") { connectionId: String ->
      core.isConnected(connectionId)
    }

    Function("disconnect") { connectionId: String ->
      core.disconnect(connectionId)
    }

    AsyncFunction("generateKeyPair") { comment: String, promise: Promise ->
      run(promise) { core.generateKeyPair(comment) }
    }

    OnDestroy {
      synchronized(this@PiSshModule) {
        coreInstance?.destroy()
        coreInstance = null
      }
    }
  }
}
