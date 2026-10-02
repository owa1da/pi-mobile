package sh.pimobile.ssh

import android.util.Base64
import com.jcraft.jsch.Channel
import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchChangedHostKeyException
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.JSchUnknownHostKeyException
import com.jcraft.jsch.KeyPair
import com.jcraft.jsch.Session
import com.jcraft.jsch.UIKeyboardInteractive
import com.jcraft.jsch.UserInfo
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Error codes surfaced to JS as `error.code`. Keep in sync with src/ssh/errors.ts. */
object SshErrorCodes {
  const val HOST_KEY_REJECTED = "ERR_SSH_HOST_KEY_REJECTED"
  const val HOST_KEY_TIMEOUT = "ERR_SSH_HOST_KEY_TIMEOUT"
  const val AUTH_FAILED = "ERR_SSH_AUTH_FAILED"
  const val INVALID_KEY = "ERR_SSH_INVALID_KEY"
  const val CONNECT_FAILED = "ERR_SSH_CONNECT_FAILED"
  const val TIMEOUT = "ERR_SSH_TIMEOUT"
  const val NOT_CONNECTED = "ERR_SSH_NOT_CONNECTED"
  const val CONNECTION_CLOSED = "ERR_SSH_CONNECTION_CLOSED"
  const val EXEC_FAILED = "ERR_SSH_EXEC_FAILED"
  const val OUTPUT_TOO_LARGE = "ERR_SSH_OUTPUT_TOO_LARGE"
  const val KEYGEN_FAILED = "ERR_SSH_KEYGEN_FAILED"
  const val INVALID_ARGUMENT = "ERR_SSH_INVALID_ARGUMENT"
}

class SshError(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause)

typealias SshEmit = (name: String, body: Map<String, Any?>) -> Unit

private fun daemonFactory(prefix: String): ThreadFactory {
  val n = AtomicInteger(0)
  return ThreadFactory { r -> Thread(r, "$prefix-${n.incrementAndGet()}").apply { isDaemon = true } }
}

internal object HostKeyInfo {
  /** Algorithm name is the leading SSH string of the key blob, e.g. "ssh-ed25519". */
  fun algorithm(blob: ByteArray): String {
    if (blob.size < 4) return "unknown"
    val len = ((blob[0].toInt() and 0xff) shl 24) or ((blob[1].toInt() and 0xff) shl 16) or
      ((blob[2].toInt() and 0xff) shl 8) or (blob[3].toInt() and 0xff)
    if (len <= 0 || len > blob.size - 4) return "unknown"
    return String(blob, 4, len, Charsets.US_ASCII)
  }

  /** Same as `ssh-keygen -lf`: "SHA256:" + unpadded base64 of SHA-256(blob). */
  fun fingerprint(blob: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(blob)
    return "SHA256:" + Base64.encodeToString(digest, Base64.NO_WRAP or Base64.NO_PADDING)
  }
}

/**
 * Two-phase host key check. JSch calls [check] during KEX, after the server's signature over the
 * exchange hash was verified and before NEWKEYS/userauth, so no credential has been sent yet.
 * We emit an event and block (on the connect worker thread) until JS answers or we time out.
 */
internal class HostKeyGate(
  private val connectionId: String,
  private val emit: SshEmit,
  private val pending: ConcurrentHashMap<String, CompletableFuture<Boolean>>,
  private val timeoutMs: Long,
) : HostKeyRepository {
  @Volatile var acceptedKey: ByteArray? = null
  @Volatile var rejected = false
  @Volatile var timedOut = false
  @Volatile var cancelled = false
  @Volatile private var current: CompletableFuture<Boolean>? = null

  fun cancel() {
    cancelled = true
    current?.complete(false)
  }

  override fun check(host: String?, key: ByteArray?): Int {
    if (key == null) return HostKeyRepository.NOT_INCLUDED
    val accepted = acceptedKey
    if (accepted != null) {
      // Re-key on an established session: the key must not change.
      return if (accepted.contentEquals(key)) HostKeyRepository.OK else HostKeyRepository.CHANGED
    }
    if (cancelled) return HostKeyRepository.NOT_INCLUDED
    val requestId = UUID.randomUUID().toString()
    val future = CompletableFuture<Boolean>()
    pending[requestId] = future
    current = future
    try {
      emit(
        "onHostKey",
        mapOf(
          "connectionId" to connectionId,
          "requestId" to requestId,
          "algorithm" to HostKeyInfo.algorithm(key),
          "fingerprint" to HostKeyInfo.fingerprint(key),
        ),
      )
      if (cancelled) return HostKeyRepository.NOT_INCLUDED
      val ok = try {
        future.get(timeoutMs, TimeUnit.MILLISECONDS)
      } catch (e: TimeoutException) {
        timedOut = true
        false
      } catch (e: Exception) {
        false
      }
      if (ok && !cancelled) {
        acceptedKey = key.copyOf()
        return HostKeyRepository.OK
      }
      if (!timedOut) rejected = true
      return HostKeyRepository.NOT_INCLUDED
    } finally {
      pending.remove(requestId)
      current = null
    }
  }

  override fun add(hostkey: HostKey?, ui: UserInfo?) {}
  override fun remove(host: String?, type: String?) {}
  override fun remove(host: String?, type: String?, key: ByteArray?) {}
  override fun getKnownHostsRepositoryID(): String = "pi-ssh"
  override fun getHostKey(): Array<HostKey> = emptyArray()
  override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()
}

/** Supplies the password once (password or keyboard-interactive); never retries it. */
internal class PasswordUserInfo(private val password: String?) : UserInfo, UIKeyboardInteractive {
  private val passwordOffered = AtomicBoolean(false)
  private val kbdOffered = AtomicBoolean(false)

  override fun getPassphrase(): String? = null
  override fun getPassword(): String? = password
  override fun promptPassword(message: String?): Boolean =
    password != null && passwordOffered.compareAndSet(false, true)
  override fun promptPassphrase(message: String?): Boolean = false
  override fun promptYesNo(message: String?): Boolean = false
  override fun showMessage(message: String?) {}

  override fun promptKeyboardInteractive(
    destination: String?,
    name: String?,
    instruction: String?,
    prompt: Array<out String>?,
    echo: BooleanArray?,
  ): Array<String>? {
    if (password == null || prompt == null) return null
    if (prompt.isEmpty()) return emptyArray()
    if (prompt.size != 1 || (echo != null && echo.isNotEmpty() && echo[0])) return null
    if (!kbdOffered.compareAndSet(false, true)) return null
    return arrayOf(password)
  }
}

internal class Conn(val id: String) {
  @Volatile var session: Session? = null
  @Volatile var gate: HostKeyGate? = null
  @Volatile var established = false
  @Volatile var userClosed = false
  val closed = AtomicBoolean(false)
}

class SshCore(private val emitRaw: SshEmit) {
  private val connections = ConcurrentHashMap<String, Conn>()
  private val pendingHostKeys = ConcurrentHashMap<String, CompletableFuture<Boolean>>()
  private val destroyed = AtomicBoolean(false)

  /** Blocking work (connect, exec, disconnect). Unbounded: each call holds a thread while it waits. */
  val pool: ExecutorService = Executors.newCachedThreadPool(daemonFactory("pi-ssh-worker"))
  private val scheduler: ScheduledExecutorService =
    Executors.newScheduledThreadPool(1, daemonFactory("pi-ssh-timer"))

  init {
    scheduler.scheduleWithFixedDelay({ watchConnections() }, 1, 1, TimeUnit.SECONDS)
  }

  private fun emit(name: String, body: Map<String, Any?>) {
    try {
      emitRaw(name, body.filterValues { it != null })
    } catch (_: Throwable) {
      // The JS runtime may be gone (reload); nothing to deliver to.
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Connections

  fun connect(
    id: String,
    host: String,
    port: Int,
    username: String,
    password: String?,
    privateKey: String?,
    passphrase: String?,
    timeoutMs: Int,
    hostKeyTimeoutMs: Int,
    keepaliveMs: Int,
  ): String {
    if (destroyed.get()) throw SshError(SshErrorCodes.CONNECT_FAILED, "SSH module destroyed")
    if (host.isBlank() || username.isBlank() || port !in 1..65535) {
      throw SshError(SshErrorCodes.INVALID_ARGUMENT, "Invalid host, port or username")
    }
    val conn = Conn(id)
    if (connections.putIfAbsent(id, conn) != null) {
      throw SshError(SshErrorCodes.INVALID_ARGUMENT, "Duplicate connection id $id")
    }
    try {
      val jsch = JSch()
      if (privateKey != null) {
        try {
          jsch.addIdentity(
            "key",
            privateKey.toByteArray(Charsets.UTF_8),
            null,
            passphrase?.takeIf { it.isNotEmpty() }?.toByteArray(Charsets.UTF_8),
          )
        } catch (e: JSchException) {
          throw SshError(SshErrorCodes.INVALID_KEY, "Invalid private key or wrong passphrase: ${e.message}", e)
        }
      }
      val gate = HostKeyGate(id, ::emit, pendingHostKeys, hostKeyTimeoutMs.toLong())
      conn.gate = gate
      jsch.hostKeyRepository = gate

      val session = jsch.getSession(username, host, port)
      session.setConfig("StrictHostKeyChecking", "yes")
      session.setConfig(
        "PreferredAuthentications",
        if (privateKey != null) "publickey" else "password,keyboard-interactive",
      )
      // Plain host keys only (no certificate path) so the fingerprint is always that of the key itself.
      session.setConfig(
        "server_host_key",
        "ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256",
      )
      session.userInfo = PasswordUserInfo(if (privateKey == null) password else null)
      session.setServerAliveInterval(keepaliveMs)
      session.setServerAliveCountMax(3)
      session.setDaemonThread(true)
      conn.session = session
      if (conn.closed.get()) throw SshError(SshErrorCodes.CONNECT_FAILED, "Connection cancelled")

      session.connect(timeoutMs)

      if (conn.closed.get()) {
        session.disconnect()
        throw SshError(SshErrorCodes.CONNECT_FAILED, "Connection cancelled")
      }
      conn.established = true
      return id
    } catch (t: Throwable) {
      conn.closed.set(true)
      connections.remove(id, conn)
      try {
        conn.session?.disconnect()
      } catch (_: Throwable) {}
      throw mapConnectError(t, conn.gate)
    }
  }

  private fun mapConnectError(t: Throwable, gate: HostKeyGate?): SshError {
    if (t is SshError) return t
    if (gate != null && gate.timedOut) {
      return SshError(SshErrorCodes.HOST_KEY_TIMEOUT, "Host key verification timed out", t)
    }
    if (gate != null && gate.cancelled) {
      return SshError(SshErrorCodes.CONNECT_FAILED, "Connection cancelled", t)
    }
    if (t is JSchUnknownHostKeyException || t is JSchChangedHostKeyException ||
      (gate != null && gate.rejected)
    ) {
      return SshError(SshErrorCodes.HOST_KEY_REJECTED, "Host key rejected; not authenticating", t)
    }
    val msg = t.message ?: t.javaClass.simpleName
    // JSchAuthCancelException / JSchPartialAuthException are package-private; match by name.
    val cls = t.javaClass.simpleName
    if (cls == "JSchAuthCancelException" || cls == "JSchPartialAuthException" ||
      msg.startsWith("Auth fail") || msg.startsWith("Auth cancel") || msg.contains("USERAUTH fail")
    ) {
      return SshError(SshErrorCodes.AUTH_FAILED, "Authentication failed", t)
    }
    var c: Throwable? = t
    while (c != null) {
      if (c is SocketTimeoutException || (c.message ?: "").contains("timeout", ignoreCase = true)) {
        return SshError(SshErrorCodes.TIMEOUT, "Connection timed out: $msg", t)
      }
      c = c.cause
    }
    return SshError(SshErrorCodes.CONNECT_FAILED, msg, t)
  }

  fun respondHostKey(requestId: String, accept: Boolean): Boolean {
    val f = pendingHostKeys[requestId] ?: return false
    return f.complete(accept)
  }

  fun isConnected(id: String): Boolean {
    val c = connections[id] ?: return false
    return c.established && !c.closed.get() && c.session?.isConnected == true
  }

  fun disconnect(id: String) {
    val conn = connections[id] ?: return
    conn.userClosed = true
    conn.gate?.cancel()
    try {
      pool.execute { teardown(conn, "closed") }
    } catch (_: RejectedExecutionException) {
      teardown(conn, "closed")
    }
  }

  /** Idempotent: closes the session, then emits connection-close. */
  private fun teardown(conn: Conn, reason: String) {
    if (!conn.closed.compareAndSet(false, true)) return
    connections.remove(conn.id, conn)
    conn.gate?.cancel()
    try {
      conn.session?.disconnect()
    } catch (_: Throwable) {}
    if (conn.established) {
      emit("onConnectionClose", mapOf("connectionId" to conn.id, "reason" to reason))
    }
  }

  private fun watchConnections() {
    try {
      for (conn in connections.values) {
        if (!conn.established || conn.closed.get()) continue
        val s = conn.session
        if (s == null || !s.isConnected) {
          val reason = if (conn.userClosed) "closed" else "lost"
          try {
            pool.execute { teardown(conn, reason) }
          } catch (_: RejectedExecutionException) {}
        }
      }
    } catch (_: Throwable) {
      // Never let the periodic task die.
    }
  }

  private fun requireConn(id: String): Conn {
    val c = connections[id]
    if (c == null || !c.established || c.closed.get()) {
      throw SshError(SshErrorCodes.NOT_CONNECTED, "Not connected")
    }
    val s = c.session
    if (s == null || !s.isConnected) throw SshError(SshErrorCodes.NOT_CONNECTED, "Not connected")
    return c
  }

  // ---------------------------------------------------------------------------------------------
  // Exec

  fun exec(connId: String, command: String, stdin: String?, timeoutMs: Int?): Map<String, Any?> {
    val conn = requireConn(connId)
    val session = conn.session!!
    val channel = try {
      session.openChannel("exec") as ChannelExec
    } catch (e: JSchException) {
      throw SshError(
        if (session.isConnected) SshErrorCodes.EXEC_FAILED else SshErrorCodes.CONNECTION_CLOSED,
        "Could not open exec channel: ${e.message}",
        e,
      )
    }
    val timedOut = AtomicBoolean(false)
    var timer: ScheduledFuture<*>? = null
    try {
      channel.setCommand(command.toByteArray(Charsets.UTF_8))
      channel.setPty(false)
      val out = channel.inputStream
      val err = channel.extInputStream
      val inp = channel.outputStream
      try {
        channel.connect(15_000)
      } catch (e: JSchException) {
        throw SshError(
          if (session.isConnected) SshErrorCodes.EXEC_FAILED else SshErrorCodes.CONNECTION_CLOSED,
          "Could not start command: ${e.message}",
          e,
        )
      }
      if (timeoutMs != null && timeoutMs > 0) {
        timer = scheduler.schedule({
          timedOut.set(true)
          try {
            channel.disconnect()
          } catch (_: Throwable) {}
        }, timeoutMs.toLong(), TimeUnit.MILLISECONDS)
      }
      val stdinBytes = stdin?.toByteArray(Charsets.UTF_8)
      val writer = pool.submit {
        try {
          if (stdinBytes != null && stdinBytes.isNotEmpty()) inp.write(stdinBytes)
          inp.flush()
        } catch (_: IOException) {
        } finally {
          try {
            inp.close() // sends EOF
          } catch (_: IOException) {}
        }
      }
      val errBuf = ByteArrayOutputStream()
      val errFuture = pool.submit<Unit> { drain(err, errBuf, channel) }
      val outBuf = ByteArrayOutputStream()
      var failure: Throwable? = null
      try {
        drain(out, outBuf, channel)
      } catch (t: Throwable) {
        failure = t
      }
      try {
        errFuture.get()
      } catch (t: Throwable) {
        if (failure == null) failure = t.cause ?: t
      }
      try {
        writer.get(1, TimeUnit.SECONDS)
      } catch (_: Throwable) {}
      if (timedOut.get()) throw SshError(SshErrorCodes.TIMEOUT, "Command timed out after ${timeoutMs}ms")
      if (failure is SshError) throw failure
      // The server sends exit-status before CHANNEL_CLOSE; wait for the close to land.
      val deadline = System.currentTimeMillis() + 5_000
      while (!channel.isClosed && System.currentTimeMillis() < deadline && session.isConnected) {
        Thread.sleep(10)
      }
      if (timedOut.get()) throw SshError(SshErrorCodes.TIMEOUT, "Command timed out after ${timeoutMs}ms")
      if (!channel.isClosed && !session.isConnected) {
        throw SshError(SshErrorCodes.CONNECTION_CLOSED, "Connection closed while the command was running")
      }
      if (failure != null && !channel.isClosed) {
        throw SshError(SshErrorCodes.EXEC_FAILED, "Reading command output failed: ${failure.message}", failure)
      }
      val status = channel.exitStatus
      return mapOf(
        "stdout" to String(outBuf.toByteArray(), Charsets.UTF_8),
        "stderr" to String(errBuf.toByteArray(), Charsets.UTF_8),
        "exitCode" to if (status >= 0) status else null,
      )
    } finally {
      timer?.cancel(false)
      try {
        channel.disconnect()
      } catch (_: Throwable) {}
    }
  }

  private fun drain(input: InputStream, sink: ByteArrayOutputStream, channel: Channel) {
    val buf = ByteArray(16 * 1024)
    while (true) {
      val n = try {
        input.read(buf)
      } catch (e: IOException) {
        // Pipe closed by channel.disconnect() (timeout or connection loss).
        if (channel.isClosed || !channel.isConnected) return
        throw e
      }
      if (n < 0) return
      if (sink.size() + n > MAX_EXEC_OUTPUT) {
        try {
          channel.disconnect()
        } catch (_: Throwable) {}
        throw SshError(SshErrorCodes.OUTPUT_TOO_LARGE, "Command output exceeded ${MAX_EXEC_OUTPUT / (1024 * 1024)} MiB")
      }
      sink.write(buf, 0, n)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Keys

  fun generateKeyPair(comment: String): Map<String, Any?> {
    try {
      val kp = KeyPair.genKeyPair(JSch(), KeyPair.ED25519)
      kp.publicKeyComment = comment
      val prv = ByteArrayOutputStream()
      kp.writeOpenSSHv1PrivateKey(prv, null)
      val pub = ByteArrayOutputStream()
      kp.writePublicKey(pub, comment)
      kp.dispose()
      var privateKey = String(prv.toByteArray(), Charsets.UTF_8)
      if (!privateKey.endsWith("\n")) privateKey += "\n"
      val publicKey = String(pub.toByteArray(), Charsets.UTF_8).trim()
      return mapOf("privateKey" to privateKey, "publicKey" to publicKey)
    } catch (t: Throwable) {
      throw SshError(SshErrorCodes.KEYGEN_FAILED, "Key generation failed: ${t.message}", t)
    }
  }

  // ---------------------------------------------------------------------------------------------

  fun destroy() {
    if (!destroyed.compareAndSet(false, true)) return
    for (f in pendingHostKeys.values) f.complete(false)
    for (conn in connections.values.toList()) {
      conn.userClosed = true
      conn.gate?.cancel()
      teardown(conn, "closed")
    }
    scheduler.shutdownNow()
    pool.shutdown()
  }

  companion object {
    const val MAX_EXEC_OUTPUT = 32 * 1024 * 1024
  }
}
