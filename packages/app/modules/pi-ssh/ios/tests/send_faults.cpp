#include "send_faults.hpp"
#include <libssh2.h>
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <poll.h>
#include <mutex>
#include <stdexcept>
#include <sys/socket.h>

namespace {
using Clock = std::chrono::steady_clock;
std::mutex mutex;
std::condition_variable condition;
std::string target;
int duration = 0, remaining = 0, spacing = 0, skip = 0, hits = 0, errors = 0;
bool shortSend = false, gateWrite = false;
int socketFd = -1;
Clock::time_point until;
thread_local const char *operation = "other";
thread_local const void *channel = nullptr;
std::string pendingOperation;
const void *pendingChannel = nullptr;
int violations = 0;
struct Scope {
  const char *previous = operation;
  const void *previousChannel = channel;
  Scope(const char *name, const void *owner) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!pendingOperation.empty() && (pendingOperation != name || pendingChannel != owner))
      ++violations;
    operation = name; channel = owner;
  }
  ~Scope() { operation = previous; channel = previousChannel; }
};
}
namespace faults {
void arm(const std::string &name, int milliseconds, int count, int gap, bool partial, int initialSkip) {
  std::lock_guard<std::mutex> lock(mutex);
  target = name; duration = milliseconds; remaining = count; spacing = gap;
  skip = initialSkip; hits = errors = violations = 0; shortSend = partial; until = {};
  pendingOperation.clear(); pendingChannel = nullptr;
}
void coordinateWrite() { std::lock_guard<std::mutex> lock(mutex); gateWrite = true; }
void waitBlocked() {
  std::unique_lock<std::mutex> lock(mutex);
  if (!condition.wait_for(lock, std::chrono::seconds(5), [] { return errors > 0; }))
    throw std::runtime_error("No injected send EAGAIN");
}
int bursts() { std::lock_guard<std::mutex> lock(mutex); return hits; }
int failures() { std::lock_guard<std::mutex> lock(mutex); return errors; }
int ownershipViolations() { std::lock_guard<std::mutex> lock(mutex); return violations; }
void disarm() {
  std::lock_guard<std::mutex> lock(mutex);
  target.clear(); until = {}; pendingOperation.clear(); pendingChannel = nullptr;
}
}
extern "C" ssize_t __real_send(int, const void *, size_t, int);
extern "C" ssize_t __wrap_send(int fd, const void *data, size_t size, int flags) {
  std::lock_guard<std::mutex> lock(mutex);
  socketFd = fd;
  if (!target.empty()) {
    if (Clock::now() < until) {
      ++errors; condition.notify_all(); errno = EAGAIN; return -1;
    }
    if (remaining && (target == "any" || target == operation)) {
      if (skip) --skip;
      else {
        --remaining; ++hits; skip = spacing;
        pendingOperation = operation; pendingChannel = channel;
        until = Clock::now() + std::chrono::milliseconds(duration);
        if (shortSend && size > 1)
          return __real_send(fd, data, std::min(size_t(7), size - 1), flags);
        ++errors; condition.notify_all(); errno = EAGAIN; return -1;
      }
    }
  }
  const auto n = __real_send(fd, data, size, flags);
  if (n == static_cast<ssize_t>(size)) { pendingOperation.clear(); pendingChannel = nullptr; }
  return n;
}

// Attribute actual socket sends, including window adjustments and rekey inside
// reads, to the public operation that owns them. Production code is unchanged.
extern "C" int __real_libssh2_session_handshake(LIBSSH2_SESSION *, libssh2_socket_t);
extern "C" int __wrap_libssh2_session_handshake(LIBSSH2_SESSION *s, libssh2_socket_t fd) {
  Scope scope("handshake", s); return __real_libssh2_session_handshake(s, fd);
}
extern "C" int __real_libssh2_userauth_publickey_frommemory(LIBSSH2_SESSION *, const char *, size_t, const char *, size_t, const char *, size_t, const char *);
extern "C" int __wrap_libssh2_userauth_publickey_frommemory(LIBSSH2_SESSION *s, const char *u, size_t un, const char *p, size_t pn, const char *k, size_t kn, const char *pass) {
  Scope scope("auth", s); return __real_libssh2_userauth_publickey_frommemory(s, u, un, p, pn, k, kn, pass);
}
extern "C" LIBSSH2_CHANNEL *__real_libssh2_channel_open_ex(LIBSSH2_SESSION *, const char *, unsigned int, unsigned int, unsigned int, const char *, unsigned int);
extern "C" LIBSSH2_CHANNEL *__wrap_libssh2_channel_open_ex(LIBSSH2_SESSION *s, const char *t, unsigned int n, unsigned int w, unsigned int p, const char *m, unsigned int l) {
  Scope scope("open", s); return __real_libssh2_channel_open_ex(s, t, n, w, p, m, l);
}
extern "C" int __real_libssh2_channel_process_startup(LIBSSH2_CHANNEL *, const char *, unsigned int, const char *, unsigned int);
extern "C" int __wrap_libssh2_channel_process_startup(LIBSSH2_CHANNEL *c, const char *r, unsigned int n, const char *m, unsigned int l) {
  Scope scope("start", c); return __real_libssh2_channel_process_startup(c, r, n, m, l);
}
extern "C" ssize_t __real_libssh2_channel_read_ex(LIBSSH2_CHANNEL *, int, char *, size_t);
extern "C" ssize_t __wrap_libssh2_channel_read_ex(LIBSSH2_CHANNEL *c, int stream, char *b, size_t n) {
  Scope scope(stream ? "stderr" : "read", c); return __real_libssh2_channel_read_ex(c, stream, b, n);
}
extern "C" ssize_t __real_libssh2_channel_write_ex(LIBSSH2_CHANNEL *, int, const char *, size_t);
extern "C" ssize_t __wrap_libssh2_channel_write_ex(LIBSSH2_CHANNEL *c, int stream, const char *b, size_t n) {
  bool coordinate;
  int fd;
  {
    std::lock_guard<std::mutex> lock(mutex);
    coordinate = gateWrite; gateWrite = false; fd = socketFd;
  }
  if (coordinate) {
    // The Python fixture sends a global request after earlier reads have
    // drained, then acknowledges it over stdin. Only this write can read it.
    std::cout << "READY_WRITE" << std::endl;
    if (std::cin.get() != 'G') throw std::runtime_error("Global request was not queued");
    pollfd ready{fd, POLLIN, 0};
    if (::poll(&ready, 1, 5000) <= 0 || !(ready.revents & POLLIN))
      throw std::runtime_error("Global request did not reach client socket");
  }
  Scope scope("write", c); return __real_libssh2_channel_write_ex(c, stream, b, n);
}
#define WRAP_CHANNEL(name, label) \
extern "C" int __real_##name(LIBSSH2_CHANNEL *); \
extern "C" int __wrap_##name(LIBSSH2_CHANNEL *c) { \
  Scope scope(label, c); return __real_##name(c); \
}
WRAP_CHANNEL(libssh2_channel_send_eof, "eof")
WRAP_CHANNEL(libssh2_channel_close, "close")
WRAP_CHANNEL(libssh2_channel_wait_eof, "wait-eof")
WRAP_CHANNEL(libssh2_channel_wait_closed, "wait-close")
WRAP_CHANNEL(libssh2_channel_free, "free")
