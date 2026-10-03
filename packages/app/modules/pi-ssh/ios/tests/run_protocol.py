#!/usr/bin/env python3
"""Adversarial SSH protocol tests using Paramiko 4.0.0 in an external temp venv.
No system accounts, user credentials, user SSH config or public interfaces are used.
"""
import argparse
import base64
import hashlib
import logging
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time

import paramiko

from owned_processes import adopt_orphans, cleanup_descendants

logging.getLogger("paramiko").addHandler(logging.NullHandler())


class GateSocket:
    """After authentication, emulate a blackholed network with TCP still open."""
    def __init__(self, sock):
        self.sock = sock
        self.drop = False

    def __getattr__(self, name):
        return getattr(self.sock, name)

    def send(self, data):
        return len(data) if self.drop else self.sock.send(data)

    def recv(self, count):
        if self.drop:
            time.sleep(0.02)
            raise socket.timeout()
        return self.sock.recv(count)


class Server(paramiko.ServerInterface):
    def __init__(self, root, mode):
        self.root = root
        self.mode = mode
        self.auth = []
        self.commands = []
        self.children = []
        self.threads = []
        self.lock = threading.Lock()

    def get_allowed_auths(self, username):
        return "password,keyboard-interactive,publickey"

    def check_auth_none(self, username):
        self.auth.append("none")
        return paramiko.AUTH_FAILED

    def check_auth_password(self, username, password):
        self.auth.append("password")
        return paramiko.AUTH_SUCCESSFUL if password == "test-password" and self.mode != "interactive" else paramiko.AUTH_FAILED

    def check_auth_publickey(self, username, key):
        self.auth.append("publickey")
        return paramiko.AUTH_SUCCESSFUL

    def check_auth_interactive(self, username, submethods):
        self.auth.append("interactive")
        return paramiko.InteractiveQuery("", "", ("Password: ", False))

    def check_auth_interactive_response(self, responses):
        return paramiko.AUTH_SUCCESSFUL if responses == ["test-password"] else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        self.commands.append(command)
        thread = threading.Thread(target=self.execute, args=(channel, command), daemon=True)
        self.threads.append(thread)
        thread.start()
        return True

    def execute(self, channel, command):
        if command == b"no-status":
            time.sleep(0.02)  # let CHANNEL_SUCCESS precede close
            channel.shutdown_write()
            channel.close()
            return
        child = subprocess.Popen(["/bin/sh", "-c", command.decode()], cwd=self.root,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True)
        with self.lock:
            self.children.append(child)

        def input_stream():
            try:
                while data := channel.recv(16384):
                    child.stdin.write(data)
                    child.stdin.flush()
            except (OSError, EOFError):
                pass
            finally:
                try:
                    child.stdin.close()
                except OSError:
                    pass

        def output_stream(stream, sender):
            try:
                while data := stream.read(16384):
                    sender(data)
            except (OSError, EOFError):
                pass

        threads = [threading.Thread(target=input_stream, daemon=True),
                   threading.Thread(target=output_stream, args=(child.stdout, channel.sendall), daemon=True),
                   threading.Thread(target=output_stream, args=(child.stderr, channel.sendall_stderr), daemon=True)]
        for thread in threads:
            thread.start()
        child.wait()
        for thread in threads[1:]:
            thread.join(timeout=3)
        try:
            channel.send_exit_status(child.returncode)
            channel.shutdown_write()
            channel.close()
        except (OSError, EOFError):
            pass
        threads[0].join(timeout=1)

    def cleanup(self):
        with self.lock:
            for child in self.children:
                if child.poll() is None:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    child.wait(timeout=3)
        for thread in self.threads:
            thread.join(timeout=3)


def test(harness, root, mode, kex, partial=None):
    key = paramiko.Ed25519Key.from_private_key_file(str(root / "host"))
    replacement = paramiko.Ed25519Key.from_private_key_file(str(root / "replacement"))
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(5)
    port = listener.getsockname()[1]
    client_mode = "password" if mode == "interactive" else "loss" if mode == "blackhole" else mode
    command = [str(harness), client_mode, str(port), "test-user", str(root / "client"), fingerprint]
    if mode == "global-reply":
        command = [str(harness), mode, "write", str(port), "test-user", str(root / "client"), fingerprint, partial]
    client = subprocess.Popen(command, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    ready = threading.Event()
    write_ready = threading.Event()
    output_lines = []

    def collect():
        for line in client.stdout:
            output_lines.append(line)
            if line.strip() == "READY":
                ready.set()
            if line.strip() == "READY_WRITE":
                write_ready.set()

    reader = threading.Thread(target=collect, daemon=True)
    reader.start()  # Drain diagnostics too: a sanitizer report can exceed PIPE_BUF.
    transport = None
    server = Server(root, mode)
    channels = []
    try:
        sock, _ = listener.accept()
        gate = GateSocket(sock)
        transport = paramiko.Transport(gate)
        transport.get_security_options().kex = [kex]
        transport.add_server_key(key)
        transport.start_server(server=server)
        if mode in ("changed-rekey", "loss", "blackhole"):
            assert ready.wait(5), "".join(output_lines)
            if mode == "changed-rekey":
                transport.add_server_key(replacement)
                try:
                    transport.renegotiate_keys()
                except (paramiko.SSHException, EOFError, OSError):
                    pass
                else:
                    raise AssertionError("Changed host key was accepted on rekey")
            elif mode == "blackhole":
                gate.drop = True
            else:
                transport.close()
        deadline = time.monotonic() + 30
        while client.poll() is None:
            if write_ready.is_set():
                write_ready.clear()
                # Queue a complete want-reply request before releasing the
                # client's write wrapper. The reply must survive send EAGAIN.
                request = paramiko.Message()
                request.add_byte(paramiko.common.cMSG_GLOBAL_REQUEST)
                request.add_string("keepalive@openssh.com")
                request.add_boolean(True)
                transport._send_user_message(request)
                client.stdin.write("G")
                client.stdin.flush()
            channel = transport.accept(0.02)
            if channel is not None:
                channels.append(channel)  # retain heartbeat channels until client closes them
            if time.monotonic() > deadline:
                raise AssertionError("Harness timed out: " + "".join(output_lines))
        reader.join(timeout=3)
        output = "".join(output_lines)
        assert client.returncode == 0, output
        if mode in ("reject", "gate-timeout", "cancel"):
            assert server.auth == [], server.auth
        if mode in ("loss", "blackhole", "changed-rekey"):
            assert not server.commands, "Heartbeat executed a command"
        print(output, end="")
        print(f"PASS protocol {mode} ({kex})")
    finally:
        client.kill() if client.poll() is None else None
        client.wait(timeout=3)
        reader.join(timeout=3)
        if transport:
            transport.close()
        listener.close()
        server.cleanup()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("harness", type=Path)
    parser.add_argument("--fault-harness", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="pi-ios-protocol-") as directory:
        root = Path(directory)
        for name in ("host", "replacement", "client"):
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(root / name)], check=True)
        for mode in ("reject", "gate-timeout", "cancel", "password", "interactive", "bad-password", "no-status", "loss", "blackhole", "changed-rekey"):
            test(args.harness.resolve(), root, mode, "curve25519-sha256@libssh.org")
        test(args.harness.resolve(), root, "changed-rekey", "ecdh-sha2-nistp256")
        if args.fault_harness:
            for partial in ("eagain", "partial"):
                test(args.fault_harness.resolve(), root, "global-reply", "curve25519-sha256@libssh.org", partial)


if __name__ == "__main__":
    adopt_orphans()
    try:
        main()
    finally:
        cleanup_descendants()
