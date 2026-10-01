# Pi mobile

A minimal Android/iOS app to manage [pi](https://github.com/earendil-works/pi) coding-agent sessions
on your own machine over SSH.

## What it is

The phone connects to your machine with SSH and works with the pi sessions already running there.
pi and forge keep running unchanged in tmux, and nothing is installed on the host. The app runs
plain shell commands over the SSH connection to list sessions, read their chat, send prompts and
attach to a session's terminal.

## Requirements on the host

- `sshd` reachable from the phone
- tmux ≥ 3.0
- pi installed
- the forge extension pack (it provides the session registry the dashboard reads)

## Development

```bash
npm install
npm run build:highlight
cd packages/app
npx tsgo --noEmit
npx vitest run --project unit
npx vitest run --project integration
```

The integration tests run against a private tmux server and a fake `pi` in a temporary directory.
The SSH test also needs `/usr/sbin/sshd`.

## Building the app

TODO: APK build instructions.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Based on [Paseo](https://github.com/getpaseo/paseo) by Mohamed Boudra.
