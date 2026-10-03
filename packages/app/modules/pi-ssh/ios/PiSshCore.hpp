#pragma once
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>

namespace pissh {
struct Error : std::runtime_error {
  std::string code;
  Error(std::string suffix, const std::string &message)
      : std::runtime_error(message), code("ERR_SSH_" + suffix) {}
};
struct Options {
  std::string id, host, username;
  int port = 22, timeoutMs = 20000, hostKeyTimeoutMs = 120000, keepaliveMs = 15000;
  std::optional<std::string> password, privateKey, passphrase;
};
struct Result {
  std::string out, err;
  std::optional<int> status;
};
struct Event {
  std::string name, connectionId, requestId, algorithm, fingerprint, reason;
};
using Emit = std::function<void(const Event &)>;
using Connected = std::function<void(std::optional<Error>)>;
using Executed = std::function<void(Result, std::optional<Error>)>;
struct KeyPair { std::string privateKey, publicKey; };
KeyPair generateKeyPair(const std::string &comment);
// Exposed for portable regression tests as well as the connection implementation.
std::string fingerprint(const std::string &wireKey);
bool sameHostKey(const std::string &pinned, const char *current, size_t length);
class Core {
public:
  explicit Core(Emit emit);
  ~Core();
  void connect(Options options, Connected complete);
  bool respondHostKey(const std::string &requestId, bool accept);
  void exec(const std::string &id, std::string command, std::string input,
            int timeoutMs, Executed complete);
  bool isConnected(const std::string &id);
  void disconnect(const std::string &id);
  void destroy();
private:
  struct State;
  std::shared_ptr<State> state;
};
} // namespace pissh
