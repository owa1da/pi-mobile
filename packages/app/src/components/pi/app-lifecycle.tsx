// App-wide effects: load saved hosts once, re-check connections when the app returns to the
// foreground, and show the first-use host key prompt wherever a person started a connect.

import { useCallback, useEffect } from "react";
import { connectionStore, hostsStore, useHost, useHostKeyPrompt } from "@/stores/app";
import { useAppActive } from "@/stores/use-polling";
import { HostKeyTrustSheet } from "./host-key-sheet";

export function AppLifecycle() {
  const active = useAppActive();
  useEffect(() => {
    void hostsStore.getState().load();
  }, []);
  useEffect(() => {
    if (active) connectionStore.getState().checkAll();
  }, [active]);
  return null;
}

export function HostKeyPromptHost() {
  const prompt = useHostKeyPrompt();
  const host = useHost(prompt?.hostId);
  const trust = useCallback(() => connectionStore.getState().answerPrompt(true), []);
  const cancel = useCallback(() => connectionStore.getState().answerPrompt(false), []);
  return (
    <HostKeyTrustSheet
      visible={prompt !== null}
      hostLabel={host?.label ?? ""}
      fingerprint={prompt?.key.fingerprint ?? ""}
      onTrust={trust}
      onCancel={cancel}
    />
  );
}
