// Hosts: saved SSH hosts. Tap connects (first use asks to trust the key) and opens the dashboard.

import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, View, type ListRenderItem } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { ConfirmSheet } from "@/components/pi/confirm-sheet";
import { EmptyState } from "@/components/pi/empty-state";
import { HostFormSheet } from "@/components/pi/host-form-sheet";
import { HostKeyMismatchSheet } from "@/components/pi/host-key-sheet";
import { HostRow } from "@/components/pi/host-row";
import { ThemedPiIcon, ThemedPlus, extraMutedColor, foregroundColor } from "@/components/pi/icons";
import type { SavedHost } from "@/host/types";
import { deleteHostEverywhere } from "@/screens/hosts/use-host-form";
import { connectionStore, useHosts, useHostsLoaded } from "@/stores/app";
import type { HostConnectionState } from "@/stores/connection-store";
import { useStore } from "zustand";

interface FormTarget {
  key: number;
  host: SavedHost | null;
}

interface Mismatch {
  host: SavedHost;
  pinned: string;
  presented: string;
}

const IDLE: HostConnectionState = { status: "idle", attempt: 0 };
const DELETE_CONFIRM_FALLBACK_MS = 800;

function openDashboard(hostId: string) {
  router.push({ pathname: "/h/[hostId]", params: { hostId } });
}

export function HostsScreen() {
  const { t } = useTranslation();
  const hosts = useHosts();
  const loaded = useHostsLoaded();
  const connections = useStore(connectionStore, (state) => state.hosts);
  const [form, setForm] = useState<FormTarget | null>(null);
  const [formVisible, setFormVisible] = useState(false);
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  const [replacing, setReplacing] = useState(false);

  const openForm = useCallback((host: SavedHost | null) => {
    setForm((current) => ({ key: (current?.key ?? 0) + 1, host }));
    setFormVisible(true);
  }, []);
  const addHost = useCallback(() => openForm(null), [openForm]);
  const closeForm = useCallback(() => setFormVisible(false), []);

  // Delete: the edit sheet closes first, then the confirm sheet rises once it has dismissed.
  // A missed dismiss callback must not strand the request: fall back after the sheet's exit time.
  const pendingDelete = useRef<SavedHost | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedHost | null>(null);
  const onFormDismiss = useCallback(() => {
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    if (!pendingDelete.current) return;
    setDeleteTarget(pendingDelete.current);
    pendingDelete.current = null;
  }, []);
  const requestDelete = useCallback(
    (host: SavedHost) => {
      pendingDelete.current = host;
      setFormVisible(false);
      pendingTimer.current = setTimeout(onFormDismiss, DELETE_CONFIRM_FALLBACK_MS);
    },
    [onFormDismiss],
  );
  useEffect(
    () => () => {
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
    },
    [],
  );
  const cancelDelete = useCallback(() => setDeleteTarget(null), []);
  const confirmDelete = useCallback(() => {
    if (deleteTarget) deleteHostEverywhere(deleteTarget.id);
    setDeleteTarget(null);
  }, [deleteTarget]);

  const connect = useCallback(async (host: SavedHost) => {
    const service = await connectionStore.getState().connect(host.id);
    if (service) {
      openDashboard(host.id);
      return;
    }
    const failure = connectionStore.getState().hosts[host.id]?.failure;
    if (failure?.kind === "host-key-mismatch" && failure.pinned && failure.presented)
      setMismatch({ host, pinned: failure.pinned, presented: failure.presented });
  }, []);
  const onPress = useCallback((host: SavedHost) => void connect(host), [connect]);

  const cancelMismatch = useCallback(() => setMismatch(null), []);
  const replaceKey = useCallback(async () => {
    if (!mismatch) return;
    setReplacing(true);
    const service = await connectionStore
      .getState()
      .connect(mismatch.host.id, { replaceKeyWith: mismatch.presented });
    setReplacing(false);
    setMismatch(null);
    if (service) openDashboard(mismatch.host.id);
  }, [mismatch]);
  const onReplace = useCallback(() => void replaceKey(), [replaceKey]);

  const renderItem = useCallback<ListRenderItem<SavedHost>>(
    ({ item }) => (
      <HostRow
        host={item}
        connection={connections[item.id] ?? IDLE}
        onPress={onPress}
        onEdit={openForm}
      />
    ),
    [connections, onPress, openForm],
  );

  const title = useMemo(
    () => <ScreenTitle style={styles.title}>{t("pi.hosts.title")}</ScreenTitle>,
    [t],
  );
  const addButton = useMemo(
    () => (
      <Pressable
        onPress={addHost}
        style={styles.headerButton}
        accessibilityRole="button"
        accessibilityLabel={t("pi.hosts.add")}
        testID="hosts-add"
      >
        <ThemedPlus size={22} uniProps={foregroundColor} />
      </Pressable>
    ),
    [addHost, t],
  );
  const emptyIcon = useMemo(() => <ThemedPiIcon size={40} uniProps={extraMutedColor} />, []);

  let body = null;
  if (loaded && hosts.length === 0) {
    body = (
      <EmptyState
        icon={emptyIcon}
        title={t("pi.hosts.emptyTitle")}
        body={t("pi.hosts.emptyBody")}
        actionLabel={t("pi.hosts.add")}
        onAction={addHost}
        actionTestID="hosts-add-empty"
        testID="hosts-empty"
      />
    );
  } else if (loaded) {
    body = (
      <FlatList
        data={hosts}
        keyExtractor={keyOf}
        renderItem={renderItem}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={styles.list}
        testID="hosts-list"
      />
    );
  }

  return (
    <View style={styles.screen}>
      <ScreenHeader left={title} right={addButton} />
      {body}
      {form ? (
        <HostFormSheet
          key={form.key}
          visible={formVisible}
          host={form.host}
          onClose={closeForm}
          onDismiss={onFormDismiss}
          onRequestDelete={requestDelete}
        />
      ) : null}
      <ConfirmSheet
        visible={deleteTarget !== null}
        title={t("pi.hostForm.deleteTitle", { label: deleteTarget?.label ?? "" })}
        body={t("pi.hostForm.deleteBody")}
        cancelLabel={t("pi.hostForm.cancel")}
        confirmLabel={t("pi.hostForm.deleteConfirm")}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
        testID="host-delete-sheet"
      />
      <HostKeyMismatchSheet
        visible={mismatch !== null}
        hostLabel={mismatch?.host.label ?? ""}
        pinned={mismatch?.pinned ?? ""}
        presented={mismatch?.presented ?? ""}
        replacing={replacing}
        onReplace={onReplace}
        onCancel={cancelMismatch}
      />
    </View>
  );
}

const keyOf = (host: SavedHost) => host.id;

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  // Header inset (4) + 12 = the 16dp row gutter.
  title: { marginLeft: theme.spacing[3] },
  list: { paddingBottom: theme.spacing[8] },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: theme.spacing[4],
    backgroundColor: theme.colors.border,
  },
  headerButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
}));
