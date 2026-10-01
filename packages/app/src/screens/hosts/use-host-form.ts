// State and actions of the add/edit host sheet.

import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { useToast } from "@/contexts/toast-context";
import type { SavedHost } from "@/host/types";
import { getSshClient } from "@/ssh";
import { connectionStore, hostsStore, sessionsStore } from "@/stores/app";
import {
  parsePort,
  validateDraft,
  type HostDraft,
  type HostDraftError,
  type HostSecret,
} from "@/stores/host-records";
import { modeOf, needsReconnect, resolveSecret, type AuthMode } from "./host-form-logic";

export type FormField = "label" | "host" | "port" | "username";
export type FormErrors = Partial<Record<"host" | "username" | "port" | "auth", string>>;
export type GenerateState = "idle" | "generating" | "failed";

const ERROR_FIELD: Record<HostDraftError, keyof FormErrors> = {
  "host-required": "host",
  "username-required": "username",
  "port-invalid": "port",
};

const KEY_COMMENT = "pi-mobile";

function initialMode(host: SavedHost | null): AuthMode {
  if (!host) return "generate";
  return host.authType === "password" ? "password" : "paste";
}

async function persistHost(
  host: SavedHost | null,
  draft: HostDraft,
  secret: HostSecret | undefined,
): Promise<SavedHost> {
  const hosts = hostsStore.getState();
  if (!host) {
    if (!secret) throw new Error("A key or password is required");
    return hosts.addHost(draft, secret);
  }
  const reconnect = needsReconnect(host, draft, Boolean(secret));
  const saved = await hosts.updateHost(host.id, draft, secret);
  if (reconnect) {
    connectionStore.getState().disconnect(host.id);
    sessionsStore.getState().clear(host.id);
  }
  return saved;
}

export function useHostForm(host: SavedHost | null, onDone: () => void) {
  const { t } = useTranslation();
  const toast = useToast();
  const [fields, setFields] = useState<Record<FormField, string>>(() => ({
    label: host?.label ?? "",
    host: host?.host ?? "",
    port: host ? String(host.port) : "22",
    username: host?.username ?? "",
  }));
  const [mode, setMode] = useState<AuthMode>(() => initialMode(host));
  const [existing, setExisting] = useState<HostSecret | null>(null);
  const [secretLoaded, setSecretLoaded] = useState(!host);
  const [generated, setGenerated] = useState<{ privateKey: string; publicKey: string } | null>(
    null,
  );
  const [generateState, setGenerateState] = useState<GenerateState>("idle");
  const [secretFields, setSecretFields] = useState({ pastedKey: "", passphrase: "", password: "" });
  const [errors, setErrors] = useState<FormErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    void hostsStore
      .getState()
      .loadSecret(host.id)
      .then((secret) => {
        if (cancelled) return;
        setExisting(secret);
        setMode((current) => modeOf(secret, current));
        if (secret?.kind === "generated") setGenerated(secret);
        setSecretLoaded(true);
        return undefined;
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  const generate = useCallback(async () => {
    setGenerateState("generating");
    try {
      setGenerated(await getSshClient().generateKeyPair(KEY_COMMENT));
      setGenerateState("idle");
    } catch {
      setGenerateState("failed");
    }
  }, []);

  useEffect(() => {
    if (mode === "generate" && secretLoaded && !generated && generateState === "idle")
      void generate();
  }, [generate, generateState, generated, mode, secretLoaded]);

  const onChange = useMemo(() => {
    const field = (name: FormField) => (value: string) =>
      setFields((current) => ({ ...current, [name]: value }));
    const secretField = (name: keyof typeof secretFields) => (value: string) =>
      setSecretFields((current) => ({ ...current, [name]: value }));
    return {
      label: field("label"),
      host: field("host"),
      port: field("port"),
      username: field("username"),
      pastedKey: secretField("pastedKey"),
      passphrase: secretField("passphrase"),
      password: secretField("password"),
    };
  }, []);

  const save = useCallback(async () => {
    const draft: HostDraft = {
      label: fields.label,
      host: fields.host,
      port: parsePort(fields.port) ?? 0,
      username: fields.username,
    };
    const next: FormErrors = {};
    for (const error of validateDraft(draft))
      next[ERROR_FIELD[error]] = t(`pi.hostForm.errors.${error}`);
    const secret = resolveSecret({ mode, existing, generated, ...secretFields });
    if (!secret.ok) next.auth = t("pi.hostForm.errors.secret-required");
    setErrors(next);
    setSaveError(null);
    if (!secret.ok || Object.keys(next).length > 0) return;
    setSaving(true);
    try {
      await persistHost(host, draft, secret.secret);
      onDone();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveError(t("pi.hostForm.errors.save-failed", { message }));
    } finally {
      setSaving(false);
    }
  }, [existing, fields, generated, host, mode, onDone, secretFields, t]);

  const copyPublicKey = useCallback(() => {
    if (!generated) return;
    void Clipboard.setStringAsync(generated.publicKey);
    toast.copied(t("pi.hostForm.copied"));
  }, [generated, t, toast]);

  const confirmDelete = useCallback(() => {
    if (!host) return;
    Alert.alert(t("pi.hostForm.deleteTitle", { label: host.label }), t("pi.hostForm.deleteBody"), [
      { text: t("pi.hostForm.cancel"), style: "cancel" },
      {
        text: t("pi.hostForm.delete"),
        style: "destructive",
        onPress: () => {
          connectionStore.getState().disconnect(host.id);
          sessionsStore.getState().clear(host.id);
          void hostsStore.getState().removeHost(host.id);
          onDone();
        },
      },
    ]);
  }, [host, onDone, t]);

  const retryGenerate = useCallback(() => {
    void generate();
  }, [generate]);

  return {
    fields,
    onChange,
    mode,
    setMode,
    existing,
    generated,
    generateState,
    retryGenerate,
    errors,
    saveError,
    saving,
    save,
    copyPublicKey,
    confirmDelete,
  };
}

export type HostForm = ReturnType<typeof useHostForm>;
