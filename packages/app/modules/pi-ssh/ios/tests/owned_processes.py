"""Linux containment for only this fixture's descendants, including sshd orphans.

OpenSSH commands can setsid() and outlive the connection, so killing only the
listener's process group is insufficient. No process-name matching, user-wide
signals, credentials, or unrelated /proc entries are used.
"""
import ctypes
import errno
import os
from pathlib import Path
import signal
import sys
import time


def adopt_orphans():
    if sys.platform != "linux":
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "Could not contain fixture descendants")


def cleanup_descendants():
    if sys.platform != "linux":
        return
    deadline = time.monotonic() + 5

    def children(pid):
        try:
            return [int(p) for p in Path(f"/proc/{pid}/task/{pid}/children").read_text().split()]
        except FileNotFoundError:
            return []

    def kill_child(pid):
        # Only direct/adopted children are ours to reap. Never recurse through
        # sshd's child PID snapshots: it could reap them before we open a pidfd.
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            return
        try:
            # Validate parenthood on the pinned identity, without reaping it.
            # A recycled unrelated PID yields ECHILD and must not be signalled.
            try:
                os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            except ChildProcessError:
                return
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
        finally:
            os.close(fd)

    while True:
        # Killing parents causes surviving descendants to become our direct
        # children via PR_SET_CHILD_SUBREAPER; handle those on the next pass.
        for pid in children(os.getpid()):
            kill_child(pid)
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            return
        except OSError as error:
            if error.errno == errno.ECHILD:
                return
            raise
        if time.monotonic() >= deadline:
            raise RuntimeError("Fixture descendants did not exit")
        time.sleep(0.01)
