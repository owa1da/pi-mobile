#include "PiSshCore.hpp"
#include <chrono>
#include <fstream>
#include <future>
#include <iostream>
#include <sstream>
#include <thread>
#include <vector>

using namespace pissh;
static void require(bool ok, const char *what) { if (!ok) throw std::runtime_error(what); }
static std::string read(const char *path) { std::ifstream f(path); std::ostringstream s; s << f.rdbuf(); return s.str(); }
template <typename T> static T wait(std::future<T> &f) {
  require(f.wait_for(std::chrono::seconds(30)) == std::future_status::ready, "Future timed out");
  return f.get();
}
static std::future<Result> exec(Core &core, const std::string &command, const std::string &input = "", int timeout = 10000) {
  auto promise = std::make_shared<std::promise<Result>>();
  auto f = promise->get_future();
  core.exec("test", command, input, timeout, [promise](Result r, std::optional<Error> e) {
    if (e) promise->set_exception(std::make_exception_ptr(*e)); else promise->set_value(std::move(r));
  });
  return f;
}
int main(int argc, char **argv) {
  try {
    require(argc >= 2, "Usage: harness keygen path | mode port user key fingerprint [passphrase]");
    std::string mode = argv[1];
    if (mode == "keygen") {
      require(argc == 3, "keygen path");
      auto pair = generateKeyPair("pi-ios-test");
      std::ofstream(argv[2]) << pair.privateKey;
      std::ofstream(std::string(argv[2]) + ".pub") << pair.publicKey << "\n";
      require(sameHostKey("abc", "abc", 3), "Pin equality");
      require(!sameHostKey("abc", "abd", 3), "Changed pin");
      require(!sameHostKey("abc", nullptr, 0), "Missing pin");
      std::cout << "PASS keygen and pin helper\n";
      return 0;
    }
    require(argc >= 6, "mode port user key fingerprint");
    auto closePromise = std::make_shared<std::promise<Event>>();
    auto closed = closePromise->get_future();
    Core *pointer = nullptr;
    int prompts = 0;
    std::string lastRequest;
    Core core([&, closePromise](const Event &event) {
      if (event.name == "onConnectionClose") { closePromise->set_value(event); return; }
      ++prompts;
      lastRequest = event.requestId;
      require(event.algorithm == "ssh-ed25519", "Wrong algorithm");
      require(event.fingerprint == argv[5], "Wrong wire fingerprint");
      if (mode == "cancel") { pointer->disconnect("test"); return; }
      if (mode == "destroy-gate") { pointer->destroy(); return; }
      if (mode == "delayed-gate") std::this_thread::sleep_for(std::chrono::milliseconds(300));
      if (mode == "gate-timeout") return;
      require(pointer->respondHostKey(event.requestId, mode != "reject"), "Gate response failed");
      require(!pointer->respondHostKey(event.requestId, true), "Duplicate gate response succeeded");
    });
    pointer = &core;
    Options o;
    o.id = "test"; o.host = "127.0.0.1"; o.port = std::stoi(argv[2]); o.username = argv[3];
    o.privateKey = read(argv[4]);
    if (argc > 6) o.passphrase = argv[6];
    o.hostKeyTimeoutMs = 200; o.keepaliveMs = 200; o.timeoutMs = 5000;
    if (mode == "delayed-gate") { o.hostKeyTimeoutMs = 1000; o.timeoutMs = 200; }
    if (mode == "password" || mode == "bad-password") { o.privateKey.reset(); o.password = mode == "password" ? "test-password" : "wrong"; }
    std::promise<std::optional<Error>> promise;
    auto connected = promise.get_future();
    core.connect(o, [&](std::optional<Error> e) { promise.set_value(e); });
    auto error = wait(connected);
    require(prompts == 1, "Expected one host-key prompt");
    require(!core.respondHostKey(lastRequest, true), "Expired gate response succeeded");
    if (mode == "reject" || mode == "gate-timeout" || mode == "cancel" || mode == "destroy-gate" || mode == "bad-key" || mode == "bad-password" || mode == "invalid-key") {
      std::string expected = mode == "reject" ? "HOST_KEY_REJECTED" : mode == "gate-timeout" ? "HOST_KEY_TIMEOUT" : (mode == "cancel" || mode == "destroy-gate") ? "CONNECT_FAILED" : mode == "invalid-key" ? "INVALID_KEY" : "AUTH_FAILED";
      require(error && error->code == "ERR_SSH_" + expected, error ? error->code.c_str() : "Expected connect rejection");
      require(!core.isConnected("test"), "Failed connection still ready");
    } else {
      if (error) throw *error;
      require(core.isConnected("test"), "Not connected");
      if (mode == "timeout") {
        auto f = exec(core, "sleep 10", "", 100);
        try { wait(f); throw std::runtime_error("Expected timeout"); }
        catch (const Error &e) { require(e.code == "ERR_SSH_TIMEOUT", "Wrong timeout error"); }
        require(wait(closed).reason == "lost", "Timeout did not close transport");
      } else if (mode == "overflow") {
        auto f = exec(core, "head -c 33554433 /dev/zero", "", 30000);
        try { wait(f); throw std::runtime_error("Expected output limit"); }
        catch (const Error &e) { require(e.code == "ERR_SSH_OUTPUT_TOO_LARGE", "Wrong output limit error"); }
        require(wait(closed).reason == "lost", "Output limit did not close transport");
      } else if (mode == "cancel-exec") {
        std::vector<std::future<Result>> futures;
        for (int i = 0; i < 64; ++i) futures.push_back(exec(core, "sleep 10"));
        core.disconnect("test");
        for (auto &f : futures) {
          try { wait(f); throw std::runtime_error("Cancelled exec resolved"); }
          catch (const Error &e) { require(e.code == "ERR_SSH_CONNECTION_CLOSED", "Wrong cancel error"); }
        }
        require(wait(closed).reason == "closed", "Cancellation did not close transport");
      } else if (mode == "loss" || mode == "changed-rekey") {
        std::cout << "READY" << std::endl;
        require(wait(closed).reason == "lost", "Loss event missing");
        require(!core.isConnected("test"), "Dead transport still connected");
      } else if (mode == "no-status") {
        auto f = exec(core, "no-status"); require(!wait(f).status, "Missing status became zero"); core.disconnect("test"); wait(closed);
      } else {
        std::cout << "  streams/status" << std::endl;
        auto f = exec(core, "printf 'out-ü'; printf 'err-€' >&2; exit 7");
        auto r = wait(f);
        require(r.out == "out-ü" && r.err == "err-€" && r.status == 7, "Streams/status mismatch");
        std::cout << "  concurrent stdin" << std::endl;
        auto a = exec(core, "sleep 0.2; printf slow");
        auto b = exec(core, "cat; printf done", "héllo\n");
        auto rb = wait(b); require(rb.out == "héllo\ndone" && rb.status == 0, "Stdin mismatch");
        require(wait(a).out == "slow", "Concurrent exec mismatch");
        std::cout << "  large output / rekey" << std::endl;
        auto large = exec(core, "head -c 4194304 /dev/zero");
        require(wait(large).out.size() == 4194304, "Large output mismatch");
        std::cout << "  duplex / rekey" << std::endl;
        auto duplex = exec(core, "cat", std::string(2 * 1024 * 1024, 'x'));
        require(wait(duplex).out == std::string(2 * 1024 * 1024, 'x'), "Duplex deadlock/truncation");
        std::this_thread::sleep_for(std::chrono::milliseconds(600));
        require(core.isConnected("test"), "Heartbeat disconnected healthy server");
        core.disconnect("test");
        require(wait(closed).reason == "closed", "Wrong explicit-close reason");
      }
    }
    require(prompts == 1, "Rekey must not emit another trust prompt");
    std::cout << "PASS " << mode << "\n";
    return 0;
  } catch (const Error &e) { std::cerr << e.code << ": " << e.what() << "\n"; return 1; }
    catch (const std::exception &e) { std::cerr << e.what() << "\n"; return 1; }
}
