#include "PiSshCore.hpp"
#include "send_faults.hpp"
#include <chrono>
#include <fstream>
#include <future>
#include <iostream>
#include <sstream>
#include <thread>
#include <vector>

using namespace pissh;
using namespace std::chrono_literals;
static void require(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }
template <typename T> static T wait(std::future<T> &f) {
  require(f.wait_for(30s) == std::future_status::ready, "Future timed out");
  return f.get();
}
static std::future<Result> exec(Core &core, std::string command, std::string input = "", int timeout = 10000) {
  auto p = std::make_shared<std::promise<Result>>();
  auto f = p->get_future();
  const auto label = command.substr(0, 64);
  core.exec("test", std::move(command), std::move(input), timeout, [p, label](Result r, std::optional<Error> e) {
    if (e) {
      std::cerr << "fixture exec [" << label << "]: " << e->code << ": " << e->what() << "\n";
      p->set_exception(std::make_exception_ptr(*e));
    } else p->set_value(std::move(r));
  });
  return f;
}
static void rejected(std::future<Result> &f, const char *code) {
  try { wait(f); throw std::runtime_error("Cancelled/timed-out exec resolved"); }
  catch (const Error &e) { require(e.code == code, e.code.c_str()); }
}
int main(int argc, char **argv) {
  try {
    require(argc == 8, "fault_harness mode operation port user key fingerprint partial");
    const std::string mode = argv[1], stage = argv[2];
    const bool partial = std::string(argv[7]) == "partial";
    auto closePromise = std::make_shared<std::promise<Event>>();
    auto closed = closePromise->get_future();
    Core *pointer = nullptr;
    int prompts = 0;
    Core core([&](const Event &e) {
      if (e.name == "onConnectionClose") { closePromise->set_value(e); return; }
      ++prompts;
      require(e.algorithm == "ssh-ed25519" && e.fingerprint == argv[6], "Host pin mismatch");
      require(pointer->respondHostKey(e.requestId, true), "Trust response failed");
    });
    pointer = &core;
    Options options;
    options.id = "test"; options.host = "127.0.0.1"; options.port = std::stoi(argv[3]);
    options.username = argv[4];
    // Command cases use the production keepalive default. Dedicated heartbeat
    // cases below deliberately exceed a 600ms liveness budget under backpressure.
    if (mode.find("heartbeat-") == 0) options.keepaliveMs = 200;
    std::ifstream key(argv[5]); std::ostringstream content; content << key.rdbuf();
    options.privateKey = content.str();
    std::promise<std::optional<Error>> connection;
    auto connected = connection.get_future();
    const bool connecting = mode.find("connect-") == 0;
    if (connecting) {
      options.timeoutMs = 1000;
      faults::arm(stage, 60000, 1, 0, partial);
    }
    core.connect(options, [&](std::optional<Error> e) { connection.set_value(e); });
    if (connecting) {
      faults::waitBlocked();
      if (mode == "connect-cancel") core.disconnect("test");
      else if (mode == "connect-destroy") core.destroy();
      else require(mode == "connect-timeout", "Unknown connect mode");
      auto error = wait(connected); // connect rejection follows cleanup
      require(error && error->code == (mode == "connect-timeout" ? "ERR_SSH_TIMEOUT" : "ERR_SSH_CONNECT_FAILED"),
              error ? error->code.c_str() : "Interrupted connection unexpectedly succeeded");
      require(prompts == (stage == "handshake" ? 0 : 1), "Authentication preceded trust");
      require(!core.isConnected("test") && faults::bursts() == 1 && faults::failures() > 0 &&
              faults::ownershipViolations() == 0, "Connect cleanup/injection failed");
      faults::disarm();
      std::cout << "PASS fault " << mode << " " << stage << " " << argv[7] << "\n";
      return 0;
    }
    auto error = wait(connected); if (error) throw *error;

    // A fast command must finish while a separately started process is sleeping.
    // This rejects "fixes" which serialize whole commands, even if bytes match.
    auto slow = exec(core, "sleep 2; printf slow");
    auto fast = exec(core, "printf fast");
    require(wait(fast).out == "fast", "Concurrent output mismatch");
    require(slow.wait_for(0ms) != std::future_status::ready, "Commands serialized");
    require(wait(slow).out == "slow", "Slow command mismatch");

    if (mode == "global-reply") {
      faults::arm("write", 250, 1, 0, partial);
      faults::coordinateWrite();
      std::string input(256 * 1024, 'g');
      auto echoed = exec(core, "cat", input);
      auto result = wait(echoed);
      require(result.out == input && result.err.empty() && result.status == 0,
              "Global-request reply stalled or corrupted stdin");
      require(faults::bursts() == 1 && faults::failures() > 0 && faults::ownershipViolations() == 0,
              "Global-reply backpressure was not exercised");
      faults::disarm();
      core.disconnect("test");
      require(wait(closed).reason == "closed", "Disconnect event missing");
    } else if (mode.find("heartbeat-") == 0) {
      faults::arm(stage, 60000, 1, 0, partial);
      faults::waitBlocked(); // idle channel open/close, no remote process
      auto queued = exec(core, "printf queued");
      if (mode == "heartbeat-cancel") core.disconnect("test");
      else if (mode == "heartbeat-destroy") core.destroy();
      else require(mode == "heartbeat-timeout", "Unknown heartbeat mode");
      rejected(queued, "ERR_SSH_CONNECTION_CLOSED");
      require(wait(closed).reason == (mode == "heartbeat-timeout" ? "lost" : "closed"), "Heartbeat cleanup failed");
      require(faults::bursts() == 1 && faults::failures() > 0 && faults::ownershipViolations() == 0,
              "Heartbeat injection/ownership missing");
      faults::disarm();
    } else if (mode == "duplex") {
      int totalBursts = 0;
      for (int round = 0; round < 3; ++round) {
        const int count = stage == "write" ? 6 : 3;
        faults::arm(stage, 250, count, stage == "write" ? 16 : 0, partial);
        std::string input(2 * 1024 * 1024, static_cast<char>('a' + round));
        auto bulk = exec(core, "head -c 4194304 /dev/zero; cat", input);
        auto other = exec(core, "cat; printf err >&2", std::string(256 * 1024, 'q'));
        std::vector<std::future<Result>> small;
        for (int i = 0; i < 6; ++i) small.push_back(exec(core, "printf small; printf error >&2; exit 7"));
        auto result = wait(bulk);
        require(result.status == 0 && result.err.empty(), "Bulk status/stderr mismatch");
        require(result.out == std::string(4194304, '\0') + input, "Full-duplex output corruption/deadlock");
        result = wait(other);
        require(result.out == std::string(256 * 1024, 'q') && result.err == "err" && result.status == 0, "Other channel corruption");
        for (auto &f : small) {
          result = wait(f);
          require(result.out == "small" && result.err == "error" && result.status == 7, "Interleaved result mismatch");
        }
        require(faults::bursts() == count && faults::failures() > 0, "Injection coverage missing");
        require(faults::ownershipViolations() == 0, "Competing API entered during pending send");
        totalBursts += faults::bursts();
        faults::disarm();
      }
      std::cout << "  injected bursts=" << totalBursts << " rounds=3 commands=24\n";
      core.disconnect("test");
      require(wait(closed).reason == "closed", "Disconnect event missing");
    } else {
      auto sleeper = exec(core, "sleep 10");
      auto barrier = exec(core, "printf started");
      require(wait(barrier).out == "started", "Live channel setup failed");
      faults::arm(stage, 60000, 1, 0, partial);
      const bool closing = stage == "eof" || stage == "close";
      auto blocked = exec(core, closing ? "printf before-close" : "head -c 4194304 /dev/zero; cat",
                          closing ? "" : std::string(2 * 1024 * 1024, 'x'),
                          mode == "timeout" ? 1000 : 10000);
      faults::waitBlocked();
      auto queued = exec(core, "printf queued", "", mode == "queued-timeout" ? 100 : 10000);
      const auto start = std::chrono::steady_clock::now();
      if (mode == "cancel") core.disconnect("test");
      else if (mode == "destroy") core.destroy();
      else require(mode == "timeout" || mode == "queued-timeout", "Unknown mode");
      rejected(blocked, mode == "timeout" ? "ERR_SSH_TIMEOUT" : "ERR_SSH_CONNECTION_CLOSED");
      rejected(queued, mode == "queued-timeout" ? "ERR_SSH_TIMEOUT" : "ERR_SSH_CONNECTION_CLOSED");
      rejected(sleeper, "ERR_SSH_CONNECTION_CLOSED");
      const auto event = wait(closed); // emitted AFTER production cleanup, before LSan
      require(event.reason == ((mode == "timeout" || mode == "queued-timeout") ? "lost" : "closed"), "Wrong close reason");
      require(std::chrono::steady_clock::now() - start < 2s, "Blocked teardown stalled");
      require(faults::bursts() == 1 && faults::failures() > 0, "Blocked send was not exercised");
      require(faults::ownershipViolations() == 0, "Competing API entered during pending send");
      faults::disarm();
    }
    require(prompts == 1 && !core.isConnected("test"), "Trust or lifecycle regression");
    std::cout << "PASS fault " << mode << " " << stage << " " << argv[7] << "\n";
    return 0;
  } catch (const Error &e) { std::cerr << e.code << ": " << e.what() << "\n"; return 1; }
    catch (const std::exception &e) { std::cerr << e.what() << "\n"; return 1; }
}
