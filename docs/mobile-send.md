# Mobile sending and desktop drafts

For a live process advertising `remote: 1`, the host service reads the remote state and uses
`input.submit {text}` when `input.submit` readiness is published as `input: {submit: true, maxBytes}`.
`draft` is informational: neither an empty rendered placeholder nor a real desktop draft blocks
native mobile sending. Forge submits only explicit mobile text via pi's editor callback. Desktop
text, cursor, paste store and undo state stay in place; working sessions retain pi's steering rules.
Native callback writes are protected across asynchronous work and editor replacement, while desktop
writes outside that callback remain normal, including desktop paste. Native ownership travels
through pi's original serial input consumer and pending queues; the prompt handler restores that
protected context on handoff. Desktop input keeps its normal queueing and backpressure.

New sessions start empty before sending. Closed sessions reopen empty, join a concurrent resume,
then poll the process registration and native readiness before submitting. A stale cached row is
resolved through the current listing. Native submissions never use a tmux frame to decide whether
the editor contains text. An action definitely refused as stale may be retried once after reading
fresh gates. Transport loss, timeout, missing channel after writing or a runtime error is an unknown
outcome: check the chat before trying again. There is no automatic paste/reopen fallback after it.
The remote channel's nonce cache executes each request at most once. Each native request includes
`expect.sessionId`, checked against the actual session immediately before execution. State reads,
resumed-process registration and stale retries stay bound to the selected session: a replacement
sharing its PID never receives the old session's text. The binding is checked again at SDK handler
and message/queue commit boundaries after asynchronous preflight. Message acknowledgements mean
SDK preflight or queue acceptance, not simply that a timer elapsed.

Forge's native text limit is 61,440 UTF-8 bytes. Its complete inbox JSON must fit 65,536 bytes,
including escaping and the envelope. The client validates that serialized bound before writing;
heavily escaped text can exceed it even below the text limit. The host prompt bound is now 61,440 bytes too,
validated before starting or mutating a session (formerly it incorrectly allowed 1 MiB).

## Older running sessions

An updated pack does not update already-running processes. A native process without `input.submit`
returns a clear compatibility error requesting a voluntary Forge update/reload; the app never forces
it. A process without a native channel also receives that compatibility error, even if its rendered
editor looks empty. Rendered frames cannot prove there is no desktop draft: whitespace and rule
characters can be actual draft text, and placeholders can look like literal text. The diagnostic
frame parser recognizes Forge's bare `❯ ` decoration but is no longer used to authorize sending.
Legacy transport cannot send around a real draft safely. The app never pastes, clears, discards,
submits or glues desktop text; native support is required.

Thus draft-independent sending is guaranteed only by the new native capability. Supporting it in an
old running process without voluntary reload is not possible with the existing legacy transport.
