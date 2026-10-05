// Script-builder fixture only: records argv, never connects to a tmux server.
import fs from "node:fs";

const args = process.argv.slice(2);
const command = args[2]; // -S <private socket> <command>
const sessions = JSON.parse(process.env.FAKE_TMUX_SESSIONS || "[]");
fs.appendFileSync(process.env.FAKE_TMUX_LOG, `${JSON.stringify(args)}\n`);
const value = (flag) => args[args.indexOf(flag) + 1];
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

switch (command) {
  case "has-session":
    if (value("-t") !== "=Pi:") fail("expected exact Pi target");
    process.exit(sessions.includes("Pi") ? 0 : 1);
    break;
  case "show-environment":
    process.exit(sessions.length ? 0 : 1);
    break;
  case "list-sessions":
    // Legacy selection would choose a different, more recently attached session.
    for (const [index, name] of sessions.entries()) console.log(`${index} $${index} ${name}`);
    process.exit(sessions.length ? 0 : 1);
    break;
  case "new-session":
    if (process.env.FAKE_TMUX_CREATE_ERROR) fail(process.env.FAKE_TMUX_CREATE_ERROR);
    console.log(`@1 %2 4242 ${value("-s")}`);
    break;
  case "new-window": {
    const target = value("-t");
    const name = target === "=Pi:" ? "Pi" : sessions[Number(target.slice(1, -1))];
    console.log(`@1 %2 4242 ${name}`);
    break;
  }
  case "set-environment":
    break;
  default:
    fail(`unexpected command: ${command}`);
}
