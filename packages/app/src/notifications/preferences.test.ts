import { describe, expect, it, vi } from "vitest";
import { createNotificationPreferences } from "./preferences";

function setup(granted = true) {
  const values = new Map<string, string>();
  const storage = {
    getItem: async (k: string) => values.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const api = {
    getPermissionsAsync: vi.fn().mockResolvedValue({ granted: false, canAskAgain: true }),
    requestPermissionsAsync: vi.fn().mockResolvedValue({ granted }),
    getExpoPushTokenAsync: vi.fn().mockResolvedValue({ data: "token" }),
  };
  const register = vi.fn().mockResolvedValue(undefined);
  const unregister = vi.fn().mockResolvedValue(undefined);
  const model = createNotificationPreferences({
    storage,
    api,
    newId: () => "installation",
    register,
    unregister,
  });
  return { model, api, register, unregister, storage };
}

describe("notification opt-in", () => {
  it("never prompts on load; grants only on intent with alert/sound but no badge", async () => {
    const { model, api, register } = setup();
    await model.load();
    expect(api.requestPermissionsAsync).not.toHaveBeenCalled();
    await model.setEnabled("h", true);
    expect(api.requestPermissionsAsync).toHaveBeenCalledWith({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    expect(api.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: "d2696fae-ad1a-472f-9b34-8aeb34f66b20",
    });
    expect(model.getState().enabled.h).toBe(true);
    expect(register).toHaveBeenCalledWith("h", "installation", "token");
  });
  it("denial stays off, shows denied, and never re-prompts even on another enable", async () => {
    const { model, api } = setup(false);
    await model.setEnabled("h", true);
    expect(model.getState().denied).toBe(true);
    expect(model.getState().enabled.h).not.toBe(true);
    await model.setEnabled("h", true);
    expect(api.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    await model.renew("h");
    expect(api.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });
  it("renewal and token changes write enabled hosts only; disabling unregisters", async () => {
    const { model, api, register, unregister } = setup();
    await model.setEnabled("h", true);
    api.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
    await model.renew("h");
    await model.tokenChanged();
    expect(register).toHaveBeenCalledTimes(3);
    await model.setEnabled("h", false);
    expect(unregister).toHaveBeenCalledWith("h", "installation");
    await model.renew("h");
    expect(register).toHaveBeenCalledTimes(3);
  });
  it("turns off locally and bounds unregister even when SSH stalls", async () => {
    vi.useFakeTimers();
    try {
      const { model, unregister } = setup();
      await model.setEnabled("h", true);
      unregister.mockImplementation(() => new Promise(() => {}));
      let finished = false;
      void model.setEnabled("h", false).then(() => {
        finished = true;
        return undefined;
      });
      await vi.advanceTimersByTimeAsync(4000);
      expect(model.getState().enabled.h).not.toBe(true);
      expect(finished).toBe(true);
      expect(model.getState().busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("unregisters promptly while renewal token fetch stalls and skips its late registration", async () => {
    vi.useFakeTimers();
    try {
      const { model, api, register, unregister } = setup();
      await model.setEnabled("h", true);
      api.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
      let resolveToken!: (token: { data: string }) => void;
      api.getExpoPushTokenAsync.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveToken = resolve;
          }),
      );
      const renewal = model.renew("h");
      await vi.advanceTimersByTimeAsync(0);
      const disabling = model.setEnabled("h", false);
      await vi.advanceTimersByTimeAsync(0);
      expect(model.getState().enabled.h).not.toBe(true);
      expect(unregister).toHaveBeenCalledWith("h", "installation");
      await disabling;
      resolveToken({ data: "late-token" });
      await renewal;
      expect(register).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds stalled permission and token acquisition without delaying host deletion", async () => {
    vi.useFakeTimers();
    try {
      const { model, api, unregister } = setup();
      await model.setEnabled("h", true);
      api.getPermissionsAsync.mockImplementation(() => new Promise(() => {}));
      const renewal = model.renew("h");
      await vi.advanceTimersByTimeAsync(0);
      await model.forget("h");
      expect(unregister).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10000);
      await renewal;
      expect(model.getState().error).toBe(true);
      api.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
      api.getExpoPushTokenAsync.mockImplementation(() => new Promise(() => {}));
      const enabling = model.setEnabled("h", true);
      await vi.advanceTimersByTimeAsync(0);
      await model.setEnabled("h", false);
      expect(unregister).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10000);
      await enabling;
      expect(model.getState().busy).toBe(false);
      expect(model.getState().enabled.h).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not opt back in when a permission query finishes after disable", async () => {
    const { model, api, register, unregister } = setup();
    await model.load();
    let grant!: (permission: { granted: boolean; canAskAgain: boolean }) => void;
    api.getPermissionsAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const enabling = model.setEnabled("h", true);
    await vi.waitFor(() => expect(api.getPermissionsAsync).toHaveBeenCalled());
    await model.setEnabled("h", false);
    expect(unregister).toHaveBeenCalledTimes(1);
    grant({ granted: true, canAskAgain: true });
    await enabling;
    expect(model.getState().enabled.h).not.toBe(true);
    expect(register).not.toHaveBeenCalled();
  });
  it("clears denial when permission is restored on renewal", async () => {
    const { model, api, register } = setup();
    await model.setEnabled("h", true);
    api.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    await model.renew("h");
    expect(model.getState().denied).toBe(true);
    api.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
    await model.renew("h");
    expect(register).toHaveBeenCalledTimes(2);
    expect(model.getState().denied).toBe(false);
  });
  it("persists random installation identity and denial across model instances", async () => {
    const { model, api, storage } = setup(false);
    await model.setEnabled("h", true);
    const next = createNotificationPreferences({
      storage,
      api,
      newId: () => "other",
      register: vi.fn(),
      unregister: vi.fn(),
    });
    await next.setEnabled("h", true);
    expect(api.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(next.getState().installationId).toBe("installation");
  });
});
