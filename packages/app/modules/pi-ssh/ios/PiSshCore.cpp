#include "PiSshCore.hpp"
#include <libssh2.h>
// PiSsh: choose CocoaPod framework or portable OpenSSL headers.
#include "PiSshOpenSSL.h"
#include PISSH_OPENSSL_HEADER(crypto.h)
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#ifdef PISSH_TEST_DIAGNOSTICS
#include <cstdio>
#endif
#include <cstring>
#include <deque>
#include <fcntl.h>
#include <future>
#include <map>
#include <mutex>
#include <netdb.h>
#include <poll.h>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace pissh {
namespace {
using Clock = std::chrono::steady_clock;
using Time = Clock::time_point;
Time after(int ms) { return Clock::now() + std::chrono::milliseconds(ms); }
constexpr size_t maxOutput = 32 * 1024 * 1024;
constexpr int again = LIBSSH2_ERROR_EAGAIN;
std::atomic<uint64_t> nextRequest{0};
std::atomic<int> resolving{0};
void wipe(std::optional<std::string> &secret) {
  if (secret && !secret->empty()) OPENSSL_cleanse(secret->data(), secret->size());
  secret.reset();
}
template <typename F> void deliver(F &&fn) noexcept { try { fn(); } catch (...) {} }
struct Address { sockaddr_storage address{}; socklen_t length; int family, type, protocol; };
// getaddrinfo cannot be cancelled portably. It owns no connection/socket/credentials.
// Bound outstanding OS resolutions and abandon the result on timeout/cancellation.
std::future<std::vector<Address>> resolve(const std::string &host, int port) {
  if (resolving.fetch_add(1) >= 8) {
    --resolving;
    throw Error("CONNECT_FAILED", "DNS resolver busy");
  }
  std::promise<std::vector<Address>> promise;
  auto future = promise.get_future();
  try {
    std::thread([host, port, promise = std::move(promise)]() mutable {
      try {
        addrinfo hints{};
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_family = AF_UNSPEC;
        addrinfo *raw = nullptr;
        int rc = getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &raw);
        std::unique_ptr<addrinfo, decltype(&freeaddrinfo)> result(raw, freeaddrinfo);
        if (rc) throw Error("CONNECT_FAILED", "Host resolution failed");
        std::vector<Address> addresses;
        for (auto p = raw; p; p = p->ai_next) {
          if (p->ai_addrlen > sizeof(sockaddr_storage)) continue;
          Address a;
          memcpy(&a.address, p->ai_addr, p->ai_addrlen);
          a.length = static_cast<socklen_t>(p->ai_addrlen);
          a.family = p->ai_family; a.type = p->ai_socktype; a.protocol = p->ai_protocol;
          addresses.push_back(a);
        }
        promise.set_value(std::move(addresses));
      } catch (...) { promise.set_exception(std::current_exception()); }
      --resolving;
    }).detach();
  } catch (...) { --resolving; throw; }
  return future;
}
struct Task {
  std::string command, input;
  Time deadline, startDeadline;
  Executed complete;
  LIBSSH2_CHANNEL *channel = nullptr;
  enum Phase { open, start, io, close, waitClose, free } phase = open;
  size_t written = 0;
  bool eofSent = false, heartbeat = false, completed = false;
  Result result;
};
struct Connection : std::enable_shared_from_this<Connection> {
  Options options;
  Emit emit;
  Connected connected;
  std::function<void()> finished;
  std::atomic<bool> cancelled{false}, ready{false};
  std::atomic<size_t> taskCount{0};
  std::mutex mutex;
  std::condition_variable condition;
  std::deque<std::shared_ptr<Task>> queued;
  bool waiting = false;
  Time gateDeadline;
  std::optional<bool> decision;
  const std::string requestId = "ios-hostkey-" + std::to_string(++nextRequest);
  // Everything below is used ONLY by this connection's worker thread.
  int socket = -1;
  LIBSSH2_SESSION *session = nullptr;
  std::string pinned;
  bool changedKey = false, tearingDown = false, keyboardOffered = false;
  std::vector<std::shared_ptr<Task>> active;
  std::shared_ptr<Task> opening;
  Time nextHeartbeat;
  bool heartbeatPending = false;

  ~Connection() { clearCredentials(); }
  void clearCredentials() { wipe(options.password); wipe(options.privateKey); wipe(options.passphrase); }
  void cancel() {
    // Use the condition's mutex so cancellation cannot be lost between the
    // trust wait's predicate check and its atomic unlock-and-sleep.
    std::lock_guard<std::mutex> lock(mutex);
    cancelled = true; ready = false; condition.notify_all();
  }
  void check(Time deadline) {
    if (cancelled) throw Error("CONNECTION_CLOSED", "Connection cancelled");
    if (changedKey) throw Error("HOST_KEY_REJECTED", "Host key changed during rekey");
    if (Clock::now() >= deadline) throw Error("TIMEOUT", "SSH operation timed out");
  }
  bool checkKey() {
    if (pinned.empty()) return true;
    size_t length = 0; int type = 0;
    const char *key = libssh2_session_hostkey(session, &length, &type);
    // libssh2 can temporarily clear the pointer while parsing KEX, but never sends
    // NEWKEYS until it has installed the replacement and verified its signature.
    if (!key) return true;
    if (!sameHostKey(pinned, key, length)) changedKey = true;
    return !changedKey;
  }
  static ssize_t sendCallback(libssh2_socket_t fd, const void *data, size_t size, int flags, void **abstract) {
    auto c = static_cast<Connection *>(*abstract);
    // Enforce the pin INSIDE libssh2, before any send during a server-initiated
    // rekey. Checking only after a public API returns would be too late.
    if (c->tearingDown || c->cancelled || !c->checkKey()) return -ECONNRESET;
#ifdef MSG_NOSIGNAL
    flags |= MSG_NOSIGNAL;
#endif
    ssize_t n = ::send(fd, data, size, flags);
    return n < 0 ? -errno : n; // libssh2 callbacks return negative errno, not -1.
  }
  static ssize_t recvCallback(libssh2_socket_t fd, void *data, size_t size, int flags, void **abstract) {
    auto c = static_cast<Connection *>(*abstract);
    if (c->tearingDown || c->cancelled || c->changedKey) return -ECONNRESET;
    ssize_t n = ::recv(fd, data, size, flags);
    return n < 0 ? -errno : n;
  }
  void pause(Time deadline) {
    check(deadline);
    pollfd descriptor{socket, POLLIN, 0};
    if (session && (libssh2_session_block_directions(session) & LIBSSH2_SESSION_BLOCK_OUTBOUND))
      descriptor.events |= POLLOUT;
    int rc = ::poll(&descriptor, 1, 10);
    if (rc < 0 && errno != EINTR) throw Error("CONNECTION_CLOSED", "Socket polling failed");
    check(deadline);
  }
  template <typename F> int retry(F &&fn, Time deadline) {
    for (;;) {
      check(deadline);
      int rc = fn();
      if (!checkKey()) throw Error("HOST_KEY_REJECTED", "Host key changed during rekey");
      // A cancellation inside libssh2 can return a socket/auth error instead of
      // EAGAIN. Keep the caller's cancellation/timeout outcome authoritative.
      check(deadline);
      if (rc != again) return rc;
      pause(deadline);
    }
  }
  void tcp(Time deadline) {
    auto resolution = resolve(options.host, options.port);
    while (resolution.wait_for(std::chrono::milliseconds(10)) != std::future_status::ready) check(deadline);
    check(deadline);
    auto addresses = resolution.get();
    for (const auto &a : addresses) {
      check(deadline);
      socket = ::socket(a.family, a.type, a.protocol);
      if (socket < 0) continue;
      if (fcntl(socket, F_SETFL, O_NONBLOCK) < 0 || fcntl(socket, F_SETFD, FD_CLOEXEC) < 0) {
        ::close(socket); socket = -1; continue;
      }
#ifdef SO_NOSIGPIPE
      int one = 1;
      setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
      int rc = ::connect(socket, reinterpret_cast<const sockaddr *>(&a.address), a.length);
      if (rc == 0) return;
      if (errno == EINPROGRESS) {
        for (;;) {
          check(deadline);
          pollfd p{socket, POLLOUT, 0};
          rc = ::poll(&p, 1, 10);
          if (rc < 0 && errno == EINTR) continue;
          if (rc == 0) continue;
          int error = 0; socklen_t length = sizeof error;
          if (rc > 0 && getsockopt(socket, SOL_SOCKET, SO_ERROR, &error, &length) == 0 && error == 0) return;
          break;
        }
      }
      ::close(socket); socket = -1;
    }
    throw Error("CONNECT_FAILED", "TCP connection failed");
  }
  static void keyboard(const char *, int, const char *, int, int count,
                       const LIBSSH2_USERAUTH_KBDINT_PROMPT *prompts,
                       LIBSSH2_USERAUTH_KBDINT_RESPONSE *responses, void **abstract) {
    auto c = static_cast<Connection *>(*abstract);
    if (count != 1 || prompts[0].echo || c->keyboardOffered || !c->options.password) return;
    c->keyboardOffered = true;
    const auto &password = *c->options.password;
    responses[0].text = static_cast<char *>(malloc(password.size() + 1));
    if (!responses[0].text) return;
    memcpy(responses[0].text, password.c_str(), password.size() + 1);
    responses[0].length = static_cast<unsigned int>(password.size());
  }
  void establish() {
    auto deadline = after(options.timeoutMs);
    tcp(deadline);
    session = libssh2_session_init_ex(nullptr, nullptr, nullptr, this);
    if (!session) throw Error("INTERNAL", "Could not allocate SSH session");
    libssh2_session_set_blocking(session, 0);
    libssh2_session_callback_set2(session, LIBSSH2_CALLBACK_SEND, reinterpret_cast<libssh2_cb_generic *>(sendCallback));
    libssh2_session_callback_set2(session, LIBSSH2_CALLBACK_RECV, reinterpret_cast<libssh2_cb_generic *>(recvCallback));
    const std::pair<int, const char *> methods[] = {
      {LIBSSH2_METHOD_HOSTKEY, "ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256"},
      {LIBSSH2_METHOD_KEX, "curve25519-sha256,curve25519-sha256@libssh.org,ecdh-sha2-nistp256,ecdh-sha2-nistp384,ecdh-sha2-nistp521,diffie-hellman-group16-sha512,diffie-hellman-group18-sha512,diffie-hellman-group14-sha256,diffie-hellman-group-exchange-sha256"},
      {LIBSSH2_METHOD_CRYPT_CS, "chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr"},
      {LIBSSH2_METHOD_CRYPT_SC, "chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr"},
      {LIBSSH2_METHOD_MAC_CS, "hmac-sha2-256-etm@openssh.com,hmac-sha2-512-etm@openssh.com,hmac-sha2-256,hmac-sha2-512"},
      {LIBSSH2_METHOD_MAC_SC, "hmac-sha2-256-etm@openssh.com,hmac-sha2-512-etm@openssh.com,hmac-sha2-256,hmac-sha2-512"},
    };
    for (const auto &[method, preference] : methods)
      if (libssh2_session_method_pref(session, method, preference) != 0)
        throw Error("CONNECT_FAILED", "No supported SSH algorithm");
    if (retry([&] { return libssh2_session_handshake(session, socket); }, deadline) != 0)
      throw Error("CONNECT_FAILED", "SSH handshake failed");
    size_t length = 0; int type = 0;
    const char *key = libssh2_session_hostkey(session, &length, &type);
    if (!key || length < 5 || length > 1024 * 1024) throw Error("CONNECT_FAILED", "Invalid host key");
    std::string wire(key, length);
    auto p = reinterpret_cast<const unsigned char *>(wire.data());
    uint32_t nameLength = (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3];
    if (nameLength == 0 || nameLength > length - 4) throw Error("CONNECT_FAILED", "Invalid host key algorithm");
    auto gateStart = Clock::now();
    {
      std::lock_guard<std::mutex> lock(mutex);
      gateDeadline = gateStart + std::chrono::milliseconds(options.hostKeyTimeoutMs);
      waiting = true;
    }
    deliver([&] { emit({"onHostKey", options.id, requestId, wire.substr(4, nameLength), fingerprint(wire), ""}); });
    {
      std::unique_lock<std::mutex> lock(mutex);
      condition.wait_until(lock, gateDeadline,
                           [&] { return decision.has_value() || cancelled; });
      waiting = false;
      if (cancelled) throw Error("CONNECT_FAILED", "Connection cancelled");
      if (!decision) throw Error("HOST_KEY_TIMEOUT", "Host key verification timed out");
      if (!*decision) throw Error("HOST_KEY_REJECTED", "Host key rejected; not authenticating");
    }
    pinned = std::move(wire);
    deadline += Clock::now() - gateStart; // User decision time is not connect time.
    // There are deliberately NO userauth calls (including method discovery) above the gate.
    int rc;
    if (options.privateKey) {
      rc = retry([&] {
        return libssh2_userauth_publickey_frommemory(session, options.username.data(), options.username.size(),
          nullptr, 0, options.privateKey->data(), options.privateKey->size(),
          options.passphrase ? options.passphrase->c_str() : nullptr);
      }, deadline);
      if (rc == LIBSSH2_ERROR_FILE || rc == LIBSSH2_ERROR_METHOD_NOT_SUPPORTED ||
          rc == LIBSSH2_ERROR_INVAL || rc == LIBSSH2_ERROR_PROTO)
        throw Error("INVALID_KEY", "Invalid or unsupported private key, or wrong passphrase");
    } else if (options.password) {
      rc = retry([&] { return libssh2_userauth_password_ex(session, options.username.data(),
          static_cast<unsigned int>(options.username.size()), options.password->data(),
          static_cast<unsigned int>(options.password->size()), nullptr); }, deadline);
      if (rc == LIBSSH2_ERROR_AUTHENTICATION_FAILED)
        rc = retry([&] { return libssh2_userauth_keyboard_interactive_ex(session, options.username.data(),
          static_cast<unsigned int>(options.username.size()), keyboard); }, deadline);
    } else throw Error("AUTH_FAILED", "No authentication credentials supplied");
    clearCredentials();
    if (rc != 0 || !libssh2_userauth_authenticated(session)) throw Error("AUTH_FAILED", "Authentication failed");
    check(deadline);
    ready = true;
    nextHeartbeat = after(options.keepaliveMs);
  }
  void require(int rc) {
    if (changedKey) throw Error("HOST_KEY_REJECTED", "Host key changed during rekey");
    if (cancelled) throw Error("CONNECTION_CLOSED", "Connection cancelled");
    if (rc == LIBSSH2_ERROR_SOCKET_SEND || rc == LIBSSH2_ERROR_SOCKET_RECV ||
        rc == LIBSSH2_ERROR_SOCKET_DISCONNECT || rc == LIBSSH2_ERROR_BAD_SOCKET)
      throw Error("CONNECTION_CLOSED", "SSH transport closed");
    if (rc < 0 && rc != again) {
#ifdef PISSH_TEST_DIAGNOSTICS
      std::fprintf(stderr, "PiSsh test: libssh2 channel error %d\n", rc);
#endif
      throw Error("EXEC_FAILED", "SSH channel operation failed");
    }
  }
  void checkTasks() {
    // A blocked send must not hide another command's deadline (including work
    // enqueued while this continuation owns the transport).
    {
      std::lock_guard<std::mutex> lock(mutex);
      while (!queued.empty()) { active.push_back(std::move(queued.front())); queued.pop_front(); }
    }
    for (auto &task : active) {
      if (task->completed) continue;
      try {
        check(task->deadline);
        if (task->phase <= Task::start) check(task->startDeadline);
      } catch (const Error &e) {
        task->completed = true;
        if (!task->heartbeat) deliver([&] { task->complete({}, e); });
        throw Error("CONNECTION_CLOSED", "SSH transport operation interrupted");
      }
    }
  }
  template <typename F> auto operation(F &&fn) -> decltype(fn()) {
    // Ownership is of a single public API continuation, never a whole command.
    // An inbound-only EAGAIN (channel reply/window/data) yields to other tasks.
    // Pending ciphertext or KEX must be resumed at this exact call site, with
    // stable arguments, before ANY channel can read, write, open, or close.
    for (;;) {
      auto rc = fn();
      if (!checkKey()) throw Error("HOST_KEY_REJECTED", "Host key changed during rekey");
      if (rc != again || !libssh2_session_pending_operation(session)) return rc;
      pause(Time::max());
      checkTasks();
    }
  }
  void step(Task &task) {
    check(task.deadline);
    if (task.phase <= Task::start) check(task.startDeadline);
    int rc;
    switch (task.phase) {
    case Task::open:
      // libssh2_session.open_state is shared: only ONE open may be in flight.
      if (opening && opening.get() != &task) return;
      rc = operation([&] {
        task.channel = libssh2_channel_open_session(session);
        return task.channel ? 0 : libssh2_session_last_errno(session);
      });
      if (!task.channel) {
        // A server-side refusal (e.g. MaxSessions reached) is still a reply and
        // proves liveness. No process is ever started for heartbeat channels.
        if (task.heartbeat && rc == LIBSSH2_ERROR_CHANNEL_FAILURE) {
          opening.reset(); task.completed = true; heartbeatPending = false;
          nextHeartbeat = after(options.keepaliveMs);
          return;
        }
        require(rc);
        if (rc != again) throw Error("EXEC_FAILED", "Could not open SSH channel");
        return;
      }
      opening.reset();
      task.phase = task.heartbeat ? Task::close : Task::start;
      return;
    case Task::start:
      rc = operation([&] { return libssh2_channel_process_startup(task.channel, "exec", 4,
          task.command.data(), static_cast<unsigned int>(task.command.size())); });
      require(rc);
      if (rc == 0) task.phase = Task::io;
      return;
    case Task::io: {
      // Drain both streams every tick, including while writing stdin: no pipe deadlock.
      char buffer[16384];
      bool drained = true;
      for (int stream = 0; stream < 2; ++stream) {
        auto &sink = stream == 0 ? task.result.out : task.result.err;
        for (int chunk = 0; chunk < 8; ++chunk) {
          auto n = operation([&] { return libssh2_channel_read_ex(task.channel, stream, buffer, sizeof buffer); });
          require(static_cast<int>(n));
          if (n <= 0) break;
          if (sink.size() + static_cast<size_t>(n) > maxOutput)
            throw Error("OUTPUT_TOO_LARGE", "Command output exceeded 32 MiB per stream");
          sink.append(buffer, static_cast<size_t>(n));
          if (chunk == 7) drained = false;
        }
      }
      if (!task.eofSent) {
        if (task.written < task.input.size()) {
          auto n = operation([&] { return libssh2_channel_write_ex(task.channel, 0,
              task.input.data() + task.written, std::min(size_t(16384), task.input.size() - task.written)); });
          if (n == LIBSSH2_ERROR_CHANNEL_CLOSED || n == LIBSSH2_ERROR_CHANNEL_EOF_SENT)
            task.eofSent = true; // A command need not consume all stdin.
          else { require(static_cast<int>(n)); if (n > 0) task.written += static_cast<size_t>(n); }
        } else {
          rc = operation([&] { return libssh2_channel_send_eof(task.channel); });
          require(rc);
          if (rc == 0) task.eofSent = true;
        }
      }
      if (drained && libssh2_channel_eof(task.channel)) task.phase = Task::close;
      return;
    }
    case Task::close:
      rc = operation([&] { return libssh2_channel_close(task.channel); });
      require(rc);
      if (rc == 0) task.phase = Task::waitClose;
      return;
    case Task::waitClose:
      // A channel opened solely as a heartbeat has not received EOF yet. close()
      // can return after processing an unrelated packet, before the close reply.
      rc = operation([&] { return libssh2_channel_wait_eof(task.channel); });
      require(rc);
      if (rc == again) return;
      rc = operation([&] { return libssh2_channel_wait_closed(task.channel); });
      require(rc);
      if (rc == 0) {
        int status = libssh2_channel_get_exit_status(task.channel);
        if (status >= 0) task.result.status = status;
        task.phase = Task::free;
      }
      return;
    case Task::free:
      rc = operation([&] { return libssh2_channel_free(task.channel); });
      require(rc);
      if (rc == 0) {
        task.channel = nullptr;
        task.completed = true;
        if (task.heartbeat) { heartbeatPending = false; nextHeartbeat = after(options.keepaliveMs); }
        else {
          --taskCount;
          deliver([&] { task.complete(std::move(task.result), std::nullopt); });
        }
      }
      return;
    }
  }
  void loop() {
    while (!cancelled) {
      {
        std::lock_guard<std::mutex> lock(mutex);
        while (!queued.empty()) { active.push_back(std::move(queued.front())); queued.pop_front(); }
      }
      if (options.keepaliveMs > 0 && !heartbeatPending && Clock::now() >= nextHeartbeat) {
        auto task = std::make_shared<Task>();
        task->heartbeat = true;
        task->deadline = after(options.keepaliveMs * 3);
        task->startDeadline = task->deadline;
        active.push_back(task);
        heartbeatPending = true;
      }
      for (size_t index = 0; index < active.size(); ++index) {
        // operation() may admit queued tasks while an outbound send is blocked.
        // Keep a shared owner, not a vector reference/iterator, across the call.
        auto task = active[index];
        if (task->phase == Task::open && !opening) opening = task;
        try {
          step(*task);
          if (!checkKey()) throw Error("HOST_KEY_REJECTED", "Host key changed during rekey");
        } catch (const Error &e) {
#ifdef PISSH_TEST_DIAGNOSTICS
          std::fprintf(stderr, "PiSsh test: failed phase %d\n", static_cast<int>(task->phase));
#endif
          if (!task->heartbeat && !task->completed) {
            task->completed = true;
            deliver([&] { task->complete({}, e); });
          }
          throw;
        }
      }
      active.erase(std::remove_if(active.begin(), active.end(), [](const auto &t) { return t->completed; }), active.end());
      // poll without asking libssh2 to read when idle; the heartbeat opens a channel
      // and waits for a real reply (keepalive_send alone does not track replies).
      if (active.empty()) {
        std::unique_lock<std::mutex> lock(mutex);
        condition.wait_for(lock, std::chrono::milliseconds(10), [&] { return cancelled || !queued.empty(); });
      } else pause(Time::max());
    }
  }
  void cleanup() {
    ready = false;
    tearingDown = true;
    if (socket >= 0) ::shutdown(socket, SHUT_RDWR);
    if (session) {
      // A normal free may yield before reaching our failing callbacks when a
      // different packet owns the transport. Abort discards that continuation
      // and deallocates without network I/O; task buffers remain alive until then.
      libssh2_session_abort(session);
      session = nullptr;
    }
    if (socket >= 0) { ::close(socket); socket = -1; }
    clearCredentials();
    {
      std::lock_guard<std::mutex> lock(mutex);
      waiting = false;
      while (!queued.empty()) { active.push_back(std::move(queued.front())); queued.pop_front(); }
    }
    for (auto &task : active) if (!task->completed && !task->heartbeat)
      deliver([&] { task->complete({}, Error("CONNECTION_CLOSED", "Connection closed")); });
    active.clear(); opening.reset();
  }
  void run() noexcept {
    bool established = false;
    std::optional<Error> failure;
    try {
      establish();
      established = true;
      deliver([&] { connected(std::nullopt); });
      connected = nullptr;
      loop();
    } catch (const Error &e) { failure = e; }
      catch (...) { failure = Error("INTERNAL", "SSH worker failed"); }
    cleanup();
    deliver(finished);
    if (!established) {
      if (failure && failure->code == "ERR_SSH_CONNECTION_CLOSED")
        failure = Error("CONNECT_FAILED", "Connection cancelled");
      deliver([&] { connected(failure.value_or(Error("CONNECT_FAILED", "Connection failed"))); });
    } else deliver([&] { emit({"onConnectionClose", options.id, "", "", "", cancelled ? "closed" : "lost"}); });
  }
};
bool invalidString(const std::string &s) { return s.empty() || s.find('\0') != std::string::npos; }
} // namespace
struct Core::State {
  std::mutex mutex;
  std::map<std::string, std::shared_ptr<Connection>> connections;
  Emit emit;
  bool destroyed = false;
};
Core::Core(Emit emit) : state(std::make_shared<State>()) {
  static const int initialized = libssh2_init(0); // process lifetime; never exit while workers exist
  if (initialized != 0) throw Error("INTERNAL", "SSH initialization failed");
  state->emit = std::move(emit);
}
Core::~Core() { destroy(); }
void Core::connect(Options options, Connected complete) {
  if (invalidString(options.id) || invalidString(options.host) || invalidString(options.username) ||
      options.port < 1 || options.port > 65535 || options.timeoutMs <= 0 || options.hostKeyTimeoutMs <= 0 ||
      options.keepaliveMs < 0 || options.keepaliveMs > 86400000 ||
      (options.passphrase && options.passphrase->find('\0') != std::string::npos)) {
    wipe(options.password); wipe(options.privateKey); wipe(options.passphrase);
    complete(Error("INVALID_ARGUMENT", "Invalid connection options")); return;
  }
  auto conn = std::make_shared<Connection>();
  conn->options = std::move(options); conn->connected = std::move(complete); conn->emit = state->emit;
  std::weak_ptr<State> weak = state;
  std::weak_ptr<Connection> weakConn = conn;
  conn->finished = [weak, weakConn] {
    auto s = weak.lock(); auto c = weakConn.lock();
    if (!s || !c) return;
    std::lock_guard<std::mutex> lock(s->mutex);
    auto it = s->connections.find(c->options.id);
    if (it != s->connections.end() && it->second == c) s->connections.erase(it);
  };
  std::optional<Error> failure;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    if (state->destroyed) failure = Error("CONNECT_FAILED", "SSH module destroyed");
    else if (state->connections.count(conn->options.id)) failure = Error("INVALID_ARGUMENT", "Duplicate connection id");
    else if (state->connections.size() >= 32) failure = Error("CONNECT_FAILED", "Too many connections");
    else state->connections.emplace(conn->options.id, conn);
  }
  if (failure) { conn->connected(failure); return; }
  try { std::thread([conn] { conn->run(); }).detach(); }
  catch (...) { conn->finished(); conn->connected(Error("INTERNAL", "Could not start SSH worker")); }
}
bool Core::respondHostKey(const std::string &requestId, bool accept) {
  std::lock_guard<std::mutex> lock(state->mutex);
  for (auto &[id, conn] : state->connections) {
    if (conn->requestId != requestId) continue;
    std::lock_guard<std::mutex> gate(conn->mutex);
    if (!conn->waiting || conn->decision || conn->cancelled || Clock::now() >= conn->gateDeadline) return false;
    conn->decision = accept;
    conn->condition.notify_all();
    return true;
  }
  return false;
}
void Core::exec(const std::string &id, std::string command, std::string input, int timeoutMs, Executed complete) {
  auto task = std::make_shared<Task>();
  task->command = std::move(command); task->input = std::move(input); task->complete = std::move(complete);
  task->deadline = timeoutMs > 0 ? after(timeoutMs) : Time::max();
  task->startDeadline = std::min(task->deadline, after(15000));
  std::optional<Error> failure;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    auto it = state->connections.find(id);
    if (it == state->connections.end() || !it->second->ready || it->second->cancelled)
      failure = Error("NOT_CONNECTED", "Not connected");
    else {
      auto &conn = it->second;
      std::lock_guard<std::mutex> queue(conn->mutex);
      // Recheck under the queue lock: cleanup may have raced the first check.
      if (!conn->ready || conn->cancelled) failure = Error("NOT_CONNECTED", "Not connected");
      else if (conn->taskCount >= 128) failure = Error("EXEC_FAILED", "Too many pending commands");
      else {
        ++conn->taskCount;
        conn->queued.push_back(task);
        conn->condition.notify_all();
      }
    }
  }
  if (failure) task->complete({}, failure);
}
bool Core::isConnected(const std::string &id) {
  std::lock_guard<std::mutex> lock(state->mutex);
  auto it = state->connections.find(id);
  return it != state->connections.end() && it->second->ready && !it->second->cancelled;
}
void Core::disconnect(const std::string &id) {
  std::lock_guard<std::mutex> lock(state->mutex);
  auto it = state->connections.find(id);
  if (it != state->connections.end()) it->second->cancel();
}
void Core::destroy() {
  std::lock_guard<std::mutex> lock(state->mutex);
  state->destroyed = true;
  for (auto &[id, conn] : state->connections) conn->cancel();
}
} // namespace pissh
