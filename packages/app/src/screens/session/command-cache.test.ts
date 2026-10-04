import { describe, expect, it, vi } from "vitest";
import { cachedCommands, rememberCommands, subscribeCommands } from "./command-cache";

describe("host command discovery cache", () => {
  it("retains only commands across completed sessions, isolated by host", () => {
    const commands = [{ name: "model", description: "Pick a model" }];
    rememberCommands("cache-host-a", commands);
    rememberCommands("cache-host-a", undefined);
    expect(cachedCommands("cache-host-a")).toEqual(commands);
    expect(cachedCommands("cache-host-b")).toBeUndefined();
    commands[0].name = "mutated";
    expect(cachedCommands("cache-host-a")?.[0].name).toBe("model");
  });
  it("replaces a list from any live session on that host, including an empty list", () => {
    rememberCommands("cache-replace", [{ name: "old", description: "Old" }]);
    rememberCommands("cache-replace", [{ name: "new", description: "New" }]);
    expect(cachedCommands("cache-replace")?.map((c) => c.name)).toEqual(["new"]);
    rememberCommands("cache-replace", []);
    expect(cachedCommands("cache-replace")).toEqual([]);
  });
  it("notifies already visible completed sessions only when the list changes", () => {
    const changed = vi.fn();
    const unsubscribe = subscribeCommands(changed);
    rememberCommands("cache-notify", [{ name: "model", description: "Model" }]);
    rememberCommands("cache-notify", [{ name: "model", description: "Model" }]);
    rememberCommands("cache-notify", undefined);
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
    rememberCommands("cache-notify", []);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
