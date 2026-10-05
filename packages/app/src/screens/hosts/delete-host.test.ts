import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  forget: vi.fn(),
  disconnect: vi.fn(),
  clear: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("@/ssh", () => ({ getSshClient: vi.fn() }));
vi.mock("@/contexts/toast-context", () => ({ useToast: vi.fn() }));
vi.mock("@/notifications/runtime", () => ({ forgetHostNotifications: mocks.forget }));
vi.mock("@/stores/app", () => ({
  connectionStore: { getState: () => ({ disconnect: mocks.disconnect }) },
  sessionsStore: { getState: () => ({ clear: mocks.clear }) },
  hostsStore: { getState: () => ({ removeHost: mocks.remove }) },
}));
import { deleteHostEverywhere } from "./use-host-form";
describe("host delete", () => {
  it("awaits best-effort unregister before disconnect and record removal", async () => {
    let finish!: () => void;
    mocks.forget.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const deletion = deleteHostEverywhere("h");
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    finish();
    await deletion;
    expect(mocks.forget).toHaveBeenCalledWith("h");
    expect(mocks.disconnect).toHaveBeenCalledWith("h");
    expect(mocks.clear).toHaveBeenCalledWith("h");
    expect(mocks.remove).toHaveBeenCalledWith("h");
    expect(mocks.forget.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.disconnect.mock.invocationCallOrder[0]!,
    );
    expect(mocks.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.remove.mock.invocationCallOrder[0]!,
    );
  });
});
