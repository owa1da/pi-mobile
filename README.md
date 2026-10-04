# Pi mobile

A minimal mobile app to manage [pi](https://github.com/earendil-works/pi) coding-agent sessions
on your own machine over direct SSH. Based on Paseo.

## What it is

Choose an SSH host, see your sessions, and open a conversation. pi keeps running in tmux on the
host. The app reads session files and uses forge's remote channel for native questions, command
screens, and actions. **There is no terminal view, relay, or separate mobile daemon.**

## Host requirements

- An SSH server reachable from the phone
- tmux ≥ 3.0 and pi installed
- Forge, including the remote-channel extension for native answering and command screens

The remote-channel work is currently on a separate forge branch. Installing the mobile app does
not merge or update forge automatically. An older forge installation cannot provide those remote
features. Bare MCP manager/custom dialogs are not yet answerable from the phone; supported MCP
login, logout, and reconnect dialogs use native answering.

## Development and checks

```bash
npm ci
npm run build:highlight
cd packages/app
npx tsgo --noEmit
npx vitest run --project unit
npx vitest run --project integration
```

Integration tests use temporary agent directories, private tmux servers, and loopback SSH
fixtures. Some tests need `/usr/sbin/sshd` and an installed pi; the real-pi test loads the isolated
forge worktree specified by `PIM_E2E_FORGE`, never the live `~/.pi/forge`.

## iOS builds

This app includes custom native SSH code and **cannot run in Expo Go**. Expo project:
[`@owaida/pi-mobile`](https://expo.dev/accounts/owaida/projects/pi-mobile).

From `packages/app`, while signed into Expo:

```bash
# Compile for the simulator; no Apple signing credentials needed.
npx eas-cli@latest build --platform ios --profile ios-simulator

# Signed device build for TestFlight; Apple developer signing setup required.
npx eas-cli@latest build --platform ios --profile production
```

A simulator build cannot be installed through TestFlight. Only submit a verified, signed device
build, using its explicit build ID:

```bash
npx eas-cli@latest submit --platform ios --id <BUILD_ID> --non-interactive --wait
```

The matching `com.owa1da.pimobile` App Store Connect app is `6818914669`, recorded in
`eas.json`. Once EAS has the submission key, builds/uploads need no user interaction unless
Apple authentication expires. Check Apple's processing directly instead of refreshing the UI:

```bash
npx eas-cli@latest submit:status --platform ios --non-interactive
```

Before testing, complete
Apple's encryption/export-compliance questions and add the tester to an internal TestFlight
group. Do not share Apple passwords or verification codes in chat. Subsequent uploads need a
higher iOS build number. EAS production iOS builds auto-increment the tracked counter in
`packages/app/app.json`; commit that update after each build. Run device builds serially from
one checkout so numbers cannot be reused. Simulator builds do not increment it, and Android
keeps its existing package-version-derived versionCode.

**Real-iPhone verification is still required.** Simulator and signed store builds passed;
installation, SSH, LAN permissions and phone lifecycle checks remain before claiming it ready. Portable SSH tests and the device checklist are documented in
[`modules/pi-ssh/ios/README.md`](packages/app/modules/pi-ssh/ios/README.md).

## Android builds

The Android app has been tested in an emulator. EAS profile `production-apk` creates an APK;
`production` creates a store bundle. Device installation still needs a build for the phone's
architecture and the appropriate signing key, rather than the existing emulator test APK.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Based on [Paseo](https://github.com/getpaseo/paseo) by Mohamed Boudra.
Third-party SSH licenses are preserved in each native module; the iOS app bundles libssh2 and
OpenSSL notices in `PiSshLicenses.bundle`.
