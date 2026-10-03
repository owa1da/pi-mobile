import signal
import unittest
from unittest.mock import patch

from owned_processes import cleanup_descendants


class CleanupOwnershipTests(unittest.TestCase):
    def test_recycled_unrelated_pid_is_not_signalled(self):
        with patch("owned_processes.Path.read_text", return_value="1234"), \
             patch("owned_processes.os.pidfd_open", return_value=7), \
             patch("owned_processes.os.waitid", side_effect=ChildProcessError), \
             patch("owned_processes.os.waitpid", side_effect=ChildProcessError), \
             patch("owned_processes.os.close") as close, \
             patch("owned_processes.signal.pidfd_send_signal") as send:
            cleanup_descendants()
            send.assert_not_called()
            close.assert_called_once_with(7)

    def test_direct_child_is_signalled_only_after_identity_validation(self):
        events = []
        with patch("owned_processes.Path.read_text", return_value="1234"), \
             patch("owned_processes.os.pidfd_open", return_value=7), \
             patch("owned_processes.os.waitid", side_effect=lambda *args: events.append("validate")), \
             patch("owned_processes.os.waitpid", side_effect=ChildProcessError), \
             patch("owned_processes.os.close"), \
             patch("owned_processes.signal.pidfd_send_signal", side_effect=lambda *args: events.append("signal")) as send:
            cleanup_descendants()
            self.assertEqual(events, ["validate", "signal"])
            send.assert_called_once_with(7, signal.SIGKILL)

    def test_adopted_child_is_handled_on_next_pass_not_recursively(self):
        with patch("owned_processes.Path.read_text", side_effect=["1234", "5678"]) as read, \
             patch("owned_processes.os.pidfd_open", side_effect=[7, 8]), \
             patch("owned_processes.os.waitid", return_value=None), \
             patch("owned_processes.os.waitpid", side_effect=[(0, 0), ChildProcessError]), \
             patch("owned_processes.os.close"), \
             patch("owned_processes.time.sleep"), \
             patch("owned_processes.signal.pidfd_send_signal") as send:
            cleanup_descendants()
            self.assertEqual(read.call_count, 2)
            self.assertEqual([c.args for c in send.call_args_list], [(7, signal.SIGKILL), (8, signal.SIGKILL)])


if __name__ == "__main__":
    unittest.main()
