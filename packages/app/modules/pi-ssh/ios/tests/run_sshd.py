#!/usr/bin/env python3
"""Portable production-core tests. Only loopback, private ports, temp keys/config, owned PIDs."""
import argparse
import os
from pathlib import Path
import pwd
import signal
import socket
import subprocess
import tempfile
import time

from owned_processes import adopt_orphans, cleanup_descendants


def run(*args):
    return subprocess.check_output([str(arg) for arg in args], text=True, stderr=subprocess.STDOUT)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("harness", type=Path)
    parser.add_argument("--fault-harness", type=Path,
                        help="also run Linux deterministic send-backpressure regressions")
    parser.add_argument("--fault-case", help="run one named mode:stage:injection case for diagnosis; default runs all")
    parser.add_argument("--fault-repeat", type=int, default=1, help="repeat selected stress cases (1–100)")
    args = parser.parse_args()
    if not 1 <= args.fault_repeat <= 100:
        parser.error("--fault-repeat must be between 1 and 100")
    harness = args.harness.resolve()
    with tempfile.TemporaryDirectory(prefix="pi-ios-sshd-") as directory:
        root = Path(directory)
        for name, password in [("host", ""), ("encrypted", "test-passphrase"), ("other", "")]:
            run("ssh-keygen", "-q", "-t", "ed25519", "-N", password, "-f", root / name)
        print(run(harness, "keygen", root / "generated"), end="")
        (root / "generated").chmod(0o600)
        derived = run("ssh-keygen", "-y", "-f", root / "generated").split()[:2]
        assert derived == (root / "generated.pub").read_text().split()[:2]
        (root / "authorized_keys").write_text((root / "generated.pub").read_text() + (root / "encrypted.pub").read_text())
        (root / "invalid").write_text("not a key")
        fingerprint = run("ssh-keygen", "-lf", root / "host.pub").split()[1]
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        config = root / "sshd_config"
        config.write_text(f"""Port {port}
ListenAddress 127.0.0.1
HostKey {root / 'host'}
PidFile {root / 'sshd.pid'}
AuthorizedKeysFile {root / 'authorized_keys'}
StrictModes no
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PerSourcePenalties no
PermitUserEnvironment no
PermitUserRC no
PrintMotd no
PrintLastLog no
X11Forwarding no
AllowAgentForwarding no
MaxSessions 100
LogLevel DEBUG1
RekeyLimit 1M
""")
        log = open(root / "sshd.log", "w+")
        server = subprocess.Popen(["/usr/sbin/sshd", "-D", "-e", "-f", str(config)],
                                  stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
        try:
            deadline = time.monotonic() + 5
            while "Server listening on" not in (root / "sshd.log").read_text():
                if server.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError((root / "sshd.log").read_text())
                time.sleep(0.02)
            for mode, key, passphrase in [
                ("reject", "generated", None), ("gate-timeout", "generated", None),
                ("cancel", "generated", None), ("bad-key", "other", None),
                ("invalid-key", "invalid", None), ("invalid-key", "encrypted", "wrong"),
                ("success", "generated", None), ("encrypted", "encrypted", "test-passphrase"),
                ("timeout", "generated", None), ("overflow", "generated", None),
                ("cancel-exec", "generated", None), ("destroy-gate", "generated", None),
                ("delayed-gate", "generated", None),
            ]:
                before = (root / "sshd.log").stat().st_size
                command = [harness, mode, port, pwd.getpwuid(os.getuid()).pw_name, root / key, fingerprint]
                if passphrase is not None:
                    command.append(passphrase)
                try:
                    print(run(*command), end="")
                except subprocess.CalledProcessError as error:
                    print(error.output)
                    print("\n".join((root / "sshd.log").read_text().splitlines()[-75:]))
                    raise
                if mode in ("reject", "gate-timeout", "cancel", "destroy-gate"):
                    time.sleep(0.05)
                    added = (root / "sshd.log").read_text()[before:]
                    assert "userauth-request" not in added, "Authentication preceded host trust"
            if args.fault_harness:
                fault_harness = args.fault_harness.resolve()
                cases = [("duplex", stage, partial)
                         for stage in ("open", "start", "read", "write", "eof", "close")
                         for partial in ("eagain", "partial")]
                cases += [(mode, stage, "partial" if mode in ("destroy", "queued-timeout") else "eagain")
                          for mode in ("cancel", "destroy", "timeout", "queued-timeout")
                          for stage in ("open", "start", "read", "write", "eof", "close")]
                cases += [(mode, stage, "partial")
                          for mode in ("heartbeat-cancel", "heartbeat-destroy", "heartbeat-timeout")
                          for stage in ("open", "close")]
                cases += [(mode, stage, "partial")
                          for mode in ("connect-cancel", "connect-destroy", "connect-timeout")
                          for stage in ("handshake", "auth")]
                if args.fault_case:
                    cases = [case for case in cases if ":".join(case) == args.fault_case]
                    assert len(cases) == 1, "Unknown fault case"
                cases *= args.fault_repeat
                for mode, stage, partial in cases:
                    try:
                        print(run(fault_harness, mode, stage, port,
                                  pwd.getpwuid(os.getuid()).pw_name,
                                  root / "generated", fingerprint, partial), end="")
                    except subprocess.CalledProcessError as error:
                        print(error.output)
                        print("\n".join((root / "sshd.log").read_text().splitlines()[-75:]))
                        raise
                print(f"PASS {len(cases)} deterministic backpressure cases")
            log_text = (root / "sshd.log").read_text()
            assert log_text.count("SSH2_MSG_NEWKEYS received") > 10, "Rekey did not run"
            print("PASS no userauth before trust; OpenSSH generated-key interoperability; same-key rekey")
        finally:
            # Stop our listener group; cleanup_descendants also reaps commands
            # which sshd moved into other sessions/process groups.
            try:
                os.killpg(server.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                server.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL)
                server.wait(timeout=3)
            log.close()


if __name__ == "__main__":
    adopt_orphans()
    try:
        main()
    finally:
        cleanup_descendants()
