# PiSsh for iOS

Native Expo module for the existing `PiSsh.types.ts` contract. No terminal, PTY,
shell channel, host installation, agent forwarding, or host filesystem registry
access is provided. Android and the shared JS API are unchanged.

## Key Decisions

- **SSH**: libssh2 `1.11.1`, vendored release source, OpenSSL backend.
- **Crypto**: OpenSSL-Universal CocoaPod `3.6.2000` (OpenSSL `3.6.2`), exact pin.
- **Trust**: asynchronous `onHostKey` / `respondHostKey`, before any userauth.
- **iOS baseline**: `15.1`, Swift `5.9`, C++17, Expo SDK 54 local-module autolinking.
- **Timeout cleanup**: a failed/timed-out exec closes the entire transport. Other
  pending commands reject with `ERR_SSH_CONNECTION_CLOSED`; JS receives `lost`.
- **Outbound ownership**: resume the exact public API while ciphertext or KEX is
  pending; yield ordinary inbound waits so exec channels remain concurrent.
- **Abort cleanup**: after socket shutdown, discard pending continuations and
  free all session resources without I/O; never rely on a blocking-free timeout.
- **Keepalive**: open/close an SSH session channel without starting any process;
  require a reply within three keepalive intervals. A channel-open refusal is
  also a liveness reply. `keepaliveIntervalMs: 0` disables idle probes.
- **Credentials**: memory only; no key files, Keychain writes, logs, or SSH config
  access. Owning credential buffers are cleared after auth or cleanup. JS and
  Foundation copies are managed by their runtimes, not guaranteed zeroized.

## Dependency selection and provenance

libssh2 is maintained, BSD-3-Clause, and exposes separate handshake, host-key,
authentication, and nonblocking channel APIs. Unlike wrappers that perform
handshake and authentication together, it allows the existing asynchronous trust
gate to be enforced before sending even a username/auth-method discovery request.
The upstream GitHub latest-release API identifies `libssh2-1.11.1` as its release.
The old CocoaPod named `libssh2` is only `1.4.3`; it is deliberately **not** used.

OpenSSL-Universal supplies maintained, CocoaPods-compatible, prebuilt device and
simulator XCFramework slices. It supports Ed25519, bcrypt-encrypted OpenSSH keys,
and the OpenSSL 3 APIs used by libssh2. The pinned artifact and its real headers
are the API reference, not an assumed system iOS OpenSSL installation. iOS does
not provide OpenSSL itself. `PiSshOpenSSL.h` selects the XCFramework's
`OpenSSL/...` namespace when the pod defines `PISSH_OPENSSL_FRAMEWORK=1`; portable
tests keep ordinary `openssl/...` includes. There are no shadowing header shims.
Private C/C++/ObjC++ sources compile with `-fno-modules` for textual C headers;
Swift still imports the public, Foundation-only bridge as a module.

Exact source URLs, archive checksums, licenses, and the small local libssh2 patches
are in [`vendor/NOTICE.txt`](vendor/NOTICE.txt). The patches preserve missing exit
status, fix three crypto memory-leak paths, expose nonblocking continuation
ownership, and provide terminal no-I/O teardown. They do not replace key exchange,
crypto, or authentication. The pod bundles the notices
and licenses as `PiSshLicenses.bundle` for binary redistribution.

API/source references for maintenance:

- [libssh2.h at the pinned tag](https://github.com/libssh2/libssh2/blob/libssh2-1.11.1/include/libssh2.h)
- [`session.c`](https://github.com/libssh2/libssh2/blob/libssh2-1.11.1/src/session.c): handshake, lifecycle, nonblocking mode.
- [`kex.c`](https://github.com/libssh2/libssh2/blob/libssh2-1.11.1/src/kex.c): host-key installation, signature verification, NEWKEYS, rekey.
- [`transport.c`](https://github.com/libssh2/libssh2/blob/libssh2-1.11.1/src/transport.c): resumable sends/reads and rekey within API calls.
- [`userauth.c`](https://github.com/libssh2/libssh2/blob/libssh2-1.11.1/src/userauth.c): `libssh2_userauth_publickey_frommemory`, password and keyboard-interactive.
- [`channel.c`](https://github.com/libssh2/libssh2/blob/libssh2-1.11.1/src/channel.c): channel-open state shared by the session, per-channel I/O, close/EOF semantics.
- [`keepalive.c`](https://github.com/libssh2/libssh2/blob/libssh2-1.11.1/src/keepalive.c): `keepalive_send` alone does **not** track unanswered requests, so it cannot provide loss detection.
- [OpenSSL-Universal podspec](https://github.com/krzyzanowskim/OpenSSL/blob/3.6.2000/OpenSSL-Universal.podspec) and [CocoaPods instructions](https://github.com/krzyzanowskim/OpenSSL/blob/3.6.2000/README.md).

## Security and concurrency model

`PiSshModule.swift` is the Expo binding; `PiSshBridge.mm` converts values and posts
all events/promise settlements to the main queue. Network I/O, DNS, handshake,
key decryption, and key generation never run on the main thread.

`PiSshCore.cpp` owns one worker per connection. Only that worker accesses its
libssh2 session or socket. Public calls use short-held registry/queue locks and
atomics; events and promise callbacks are never invoked while those locks are
held. Exec calls are multiplexed across channels, not serialized behind a slow
command. There is only one pending channel-open operation because libssh2 keeps
its open continuation in the session. stdin writes and both output streams are
serviced together, avoiding full-duplex pipe deadlock. Limits are 32 connections,
128 pending commands per connection, and 32 MiB per output stream.

Every channel operation (open, startup, both reads, write, EOF, close, waits, free,
and heartbeat) uses the same continuation owner. A socket-send EAGAIN or short
send leaves an encrypted packet that must be resumed before any other operation
can initiate rekey. Socket block-direction flags alone are insufficient: the
vendored pending-operation query also detects KEX, and channel reads preserve
that EAGAIN rather than hiding it behind buffered payload. EOF packet storage is
stable across retries. Ownership ends once the packet/KEX continuation finishes;
ordinary channel reply, stdin-window, and output waits still yield. No command
serialization, SSH window/timeout increase, or skipped output drain is used.
Queued and active command deadlines remain checked during owned continuations.

Cleanup first shuts down the socket, then invokes the local terminal abort API.
This marks libssh2 disconnected before channel destruction, bypassing pending
close sends and freeing normal channel/session/KEX resources. Merely making the
send callback fail is not enough: a different pending packet can return EAGAIN
before the callback is reached. Abort never flushes abandoned ciphertext or
reuses the transport, and checks the destructor result instead of dropping it.

After signature-verified handshake, the fingerprint is `SHA256:` plus unpadded
base64 of SHA-256 of the **SSH wire host-key blob** (not an X.509/SPKI encoding).
The algorithm is the first SSH string in that blob. JS remains responsible for
persistent TOFU pinning, exactly as on Android. Rejection, cancellation, missing
listeners, late responses, and host-key timeout all fail closed. The gate is
registered before the event is dispatched; duplicate/expired replies return
false. Human decision time is excluded from the connect deadline.

The accepted wire blob is pinned for the connection. A custom libssh2 **send
callback** checks that pin before each socket write, including writes performed
inside a server-initiated rekey. Checking only after a public libssh2 call returns
would be too late. A changed key causes the callback to refuse the write, then the
worker closes the session without asking JS again. Host certificates, SHA-1 host
signatures/KEX, CBC/legacy ciphers, and MD5/SHA-1 MACs are not advertised. libssh2
adds its strict-KEX extension to the modern algorithm preferences.

Default connect/auth budget is 20,000 ms, trust budget 120,000 ms, keepalive
interval 15,000 ms. Positive connect/trust budgets are required. Cancellation
wakes trust waits immediately and nonblocking socket waits within a 10 ms tick.
OS `getaddrinfo` is not portably cancellable: at most eight detached resolutions
can outlive their cancelled callers, own no sockets or credentials, and discard
late results. Key decryption is CPU work and cancellation takes effect when the
crypto call returns; no further send can pass the cancelled send callback.

Module destruction cancels every connection without joining workers on the main
thread. iOS suspension does not promise continuous background SSH: after resume,
deadlines/liveness probes close stale transports and the existing JS reconnect
logic can establish new ones. No background mode is requested.

`PiSshCrypto.cpp` generates a real Ed25519 key and serializes the OpenSSH v1
private envelope (random duplicate checkints, seed + public key, 8-byte padding)
and SSH wire public key. Output private keys are intentionally unencrypted, as
on Android; storage is the existing app's responsibility. Password auth and one
non-echo keyboard-interactive prompt are supported. Public-key auth takes
precedence over a password, supports OpenSSH Ed25519 and libssh2-supported
RSA/ECDSA formats, and accepts supported encrypted keys via `passphrase`.
Hardware/security-key identities and arbitrary interactive/MFA conversations are
not exposed by the JS contract.

Errors use the existing `ERR_SSH_*` codes. Invalid key/decryption is
`INVALID_KEY`, refused credentials `AUTH_FAILED`, trust refusal/expiry
`HOST_KEY_REJECTED`/`HOST_KEY_TIMEOUT`, connect failures `CONNECT_FAILED`, expired
operation budgets `TIMEOUT`, unavailable connections `NOT_CONNECTED`, transport
loss/cancellation during exec `CONNECTION_CLOSED`, channel failures `EXEC_FAILED`,
output caps `OUTPUT_TOO_LARGE`, generation failures `KEYGEN_FAILED`, invalid
inputs `INVALID_ARGUMENT`, and unexpected native failures `INTERNAL`. No raw
server diagnostics, commands, credentials, or private-key parser content are
included in errors.

## Build integration

No JS, app config, EAS config, Podfile edit, or other native module change is
required by this module. Expo's existing `nativeModulesDir` local-module discovery
finds `expo-module.config.json` and `ios/PiSsh.podspec`. From the repository root,
inspect discovery without generating a native project:

```sh
node node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js resolve \
  --platform apple --project-root packages/app --json
```

The result must include package `pi-ssh`, pod `PiSsh`, Swift module `PiSsh`, and
Expo class `PiSshModule`. The pod follows the official
[Expo SDK 54 local-module template](https://github.com/expo/expo/tree/sdk-54/packages/expo-module-template-local/ios)
and the installed `expo-secure-store/ios/ExpoSecureStore.podspec`: static framework,
ExpoModulesCore dependency, module definition, mixed Swift/ObjC++ sources, and
iOS 15.1. The official local template's `expo-module.config.json` uses the same
`apple.modules` registration.
Only `PiSshBridge.h` is public to Swift; C++ and vendored headers are private with
preserved directory mapping. The C translation-unit list follows upstream
`src/Makefile.inc`; `openssl.c` and `blowfish.c` are included by other C sources,
not compiled twice.

With Ruby and `cocoapods-core` 1.16.2 installed in a temporary tool environment,
`ruby packages/app/modules/pi-ssh/ios/tests/validate_podspec.rb` runs CocoaPods'
actual specification linter and validates file globs, pinning, public headers,
and license resources. The local-only spec's Git source intentionally has no
release tag; the linter reports that metadata warning, not a compile error.
It does not perform `pod install` or an Xcode build.

On the authorized macOS/EAS build, normal Expo prebuild/pod install must resolve
`OpenSSL-Universal (3.6.2000)`. Preserve the generated Podfile.lock in the native
build workflow where applicable. Check both arm64 device Release and simulator
builds. Linux portable tests do **not** validate Swift/Objective-C++ bridging,
CocoaPods/Xcode compilation, signing, TestFlight, or actual device behavior.

Device release checklist:

1. Compile/link the pod and generated `ExpoModulesProvider` with Expo SDK 54.
2. Accept/reject TOFU prompts, reject an already-pinned changed key, and reload or
   disconnect while trust is pending. Check event order and one close event.
3. Exercise password, Ed25519/OpenSSH key, passphrase, stdin, concurrent exec,
   stderr/status, timeout, and generated-key installation against a test host.
4. Verify loss notification on network blackhole, Wi-Fi/cellular changes,
   background/resume, and module reload. Inspect Xcode memory/thread diagnostics.
5. Verify `PiSshLicenses.bundle`, crypto/export-compliance declarations, app
   signing, and TestFlight configuration in the separately owned app workflow.

## Portable tests

Requirements: CMake, a C/C++17 compiler, OpenSSL development headers/library,
Python 3.9+ (Linux pidfd support), `ssh-keygen`, and an unprivileged `/usr/sbin/sshd`. Test configs disable
user RC/environment files, use temporary host/client keys and authorized_keys,
bind only loopback ephemeral ports, and clean up their owned process groups.
Linux runners also become child subreapers. They validate direct/adopted child
ownership with `waitid(P_PIDFD)` before signalling a PID handle; they never
recursively signal descendant PID snapshots. Surviving descendants are adopted
and reaped on subsequent passes, including non-PTY commands that call setsid.
The protocol fixture additionally uses Paramiko `4.0.0`; install it into a
**temporary environment**, never app `node_modules` or system/user SSH state.

```sh
export TMPDIR="$(mktemp -d /var/tmp/pi-ios-ssh.XXXXXX)"
export PYTHONDONTWRITEBYTECODE=1
export ASAN_OPTIONS=detect_leaks=1:halt_on_error=1
export UBSAN_OPTIONS=halt_on_error=1
python3 -m unittest discover -s packages/app/modules/pi-ssh/ios/tests -p 'test_*.py' -v
cmake -S packages/app/modules/pi-ssh/ios/tests -B "$TMPDIR/asan" \
  -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_C_FLAGS='-fsanitize=address,undefined -fno-omit-frame-pointer' \
  -DCMAKE_CXX_FLAGS='-fsanitize=address,undefined -fno-omit-frame-pointer'
cmake --build "$TMPDIR/asan" -j4
"$TMPDIR/asan/pissh_packet_wait_test"
python3 packages/app/modules/pi-ssh/ios/tests/run_sshd.py \
  "$TMPDIR/asan/pissh_harness" --fault-harness "$TMPDIR/asan/pissh_fault_harness"
uv venv "$TMPDIR/python"
uv pip install --python "$TMPDIR/python/bin/python" 'paramiko==4.0.0'
"$TMPDIR/python/bin/python" packages/app/modules/pi-ssh/ios/tests/run_protocol.py \
  "$TMPDIR/asan/pissh_harness" --fault-harness "$TMPDIR/asan/pissh_fault_harness"
(cd packages/app && npx vitest run --project unit src/ssh/native-client.test.ts)
(cd packages/app && npm run typecheck)
```

The tests compile the **production** core, crypto helper, and vendored libssh2,
not a JS SSH implementation. OpenSSH tests exercise wire fingerprints, no
userauth before trust, rejection/expiry/cancel/destruction, wrong/invalid keys,
encrypted-key passphrases, generated-key interoperability, stdin and separate
UTF-8 streams/status, concurrent commands, multi-MiB full-duplex I/O, rekey,
output cap, exec cancellation/timeout, and excluded human-decision time.
Protocol tests add password/keyboard-interactive auth, missing exit status,
TCP loss, silent blackhole detection without remote commands, and changed-key
rekey rejection for both curve25519 and NIST P-256 KEX. Sanitizers should remain
enabled for dependency upgrades; never suppress a leak to make these tests pass.

On Linux, `pissh_fault_harness` links `--wrap=send` plus public-operation wrappers;
none of these hooks are built into the pod. The `--fault-harness` option adds 48
cases to the unchanged 13 OpenSSH scenarios (plus keygen): 12 repeated duplex
cases, 24 blocked-command cancellation/destruction/timeout cases, six blocked
heartbeat cases, and six blocked handshake/auth cases. Duplex cases each run
three rounds/eight interleaved commands with `RekeyLimit 1M`, including
`head -c 4194304 /dev/zero; cat` with 2 MiB stdin. They inject 250 ms EAGAIN
bursts and seven-byte partial sends across open/start/read/write/EOF/close,
assert exact stdout/stderr/status and actual fault counts, and reject competing
API/channel entry while a send is pending. An independent fast-before-slow
assertion detects whole-command serialization. Teardown tests retain a live
`sleep 10` channel, block another operation indefinitely, enqueue more work,
and require cancellation, destruction, or the original deadline to settle all
promises before leak checking. Dedicated 200 ms heartbeat cases test the 600 ms
liveness deadline; command cases use the production 15,000 ms keepalive default.
The 11 base protocol cases retain changed-key rejection for both KEX algorithms.
Two additional cases coordinate a server global request with the client's write,
then apply EAGAIN/partial sends to its reply; the write must resume that reply
before channel data. The cleanup unit tests verify that unrelated recycled PIDs
are never signalled. `run_sshd.py --fault-case mode:stage:injection` selects one
case for diagnosis; without it, all 48 cases remain required. `--fault-repeat 20`
repeats the selected cases to check timing-sensitive concurrency. The separate
`pissh_packet_wait_test` deterministically checks zero-read continuation and
other-channel replies: neither may fail the pending command or lose the reply.

The reviewer scratch path `/tmp/pi-ssh-audit-bhlfp1` was unavailable in this
checkout; these maintained fixtures reconstruct the reported wire scenarios.
The command block above is for Linux/GNU-compatible linkers. On other portable
hosts omit `--fault-harness` to run the original fixtures; Apple compilation and
device verification remain separate requirements.
