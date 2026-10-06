// Host panels never open/resume pi. Use a listed live channel, otherwise display a bounded snapshot.
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionRow } from "@/host/types";
import { useReportPlace } from "@/navigation/place-restorer";
import { hasRemote } from "@/remote/client";
import { isHostPanel, type HostPanel, type PanelSnapshot } from "@/remote/panel-snapshot";
import { useRemoteChannel } from "@/screens/session/use-remote-channel";
import {
  connectionStore,
  refreshSessions,
  useHostConnection,
  useHostsLoaded,
  useSessionsEntry,
} from "@/stores/app";
import { useAppActive, usePoller, useScreenFocused } from "@/stores/use-polling";
import { ChangelogView, UsageView } from "./info";
import { ForgeFrame, Loading } from "./parts";

export function HostPanelScreen() {
  const { hostId = "", name = "" } = useLocalSearchParams<{ hostId: string; name: string }>();
  const hostsLoaded = useHostsLoaded();
  const connection = useHostConnection(hostId);
  const entry = useSessionsEntry(hostId);
  const focused = useScreenFocused();
  const appActive = useAppActive();
  const active = focused && appActive;
  const connected = connection.status === "connected";
  // Safely restore to the dashboard, not an arbitrary session used to read this host panel.
  useReportPlace({ kind: "dashboard", hostId }, focused);
  useEffect(() => {
    if (hostsLoaded) void connectionStore.getState().ensureConnected(hostId);
  }, [hostId, hostsLoaded]);
  const poll = useCallback(() => refreshSessions(hostId).then(() => undefined), [hostId]);
  usePoller(poll, 2000, active && connected);
  if (!isHostPanel(name)) return null;
  return (
    <PanelSources
      key={`${hostId}/${name}`}
      hostId={hostId}
      name={name}
      entry={entry}
      connected={connected}
      active={active}
    />
  );
}

function PanelSources({
  hostId,
  name,
  entry,
  connected,
  active,
}: {
  hostId: string;
  name: HostPanel;
  entry: ReturnType<typeof useSessionsEntry>;
  connected: boolean;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [failedPids, setFailedPids] = useState<number[]>([]);
  const onFailure = useCallback((pid: number) => {
    setFailedPids((previous) => (previous.includes(pid) ? previous : [...previous, pid]));
  }, []);
  const canTryLive = connected && failedPids.length < 3;
  const row = canTryLive
    ? entry?.snapshot?.rows.find(
        (candidate) => hasRemote(candidate) && !failedPids.includes(candidate.pid!),
      )
    : undefined;
  if (row)
    return (
      <LivePanel
        key={`${hostId}/${name}/${row.pid}`}
        hostId={hostId}
        name={name}
        row={row}
        entry={entry}
        active={active}
        onFailure={onFailure}
      />
    );
  if (!entry?.snapshot && connected)
    return (
      <ForgeFrame title={t(`pi.forge.titles.${name}`)}>
        <Loading />
      </ForgeFrame>
    );
  return (
    <SnapshotPanel
      key={`${hostId}/${name}`}
      hostId={hostId}
      name={name}
      connected={connected}
      active={active}
    />
  );
}

function LivePanel({
  hostId,
  name,
  row,
  entry,
  active,
  onFailure,
}: {
  hostId: string;
  name: HostPanel;
  row: SessionRow;
  entry: ReturnType<typeof useSessionsEntry>;
  active: boolean;
  onFailure: (pid: number) => void;
}) {
  const channel = useRemoteChannel(hostId, row, entry, active);
  const onUnavailable = useCallback(() => onFailure(row.pid!), [onFailure, row.pid]);
  const Panel = name === "usage" ? UsageView : ChangelogView;
  return <Panel channel={channel} onUnavailable={onUnavailable} />;
}

function SnapshotPanel({
  hostId,
  name,
  connected,
  active,
}: {
  hostId: string;
  name: HostPanel;
  connected: boolean;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<PanelSnapshot | undefined>();
  const [loading, setLoading] = useState(connected);
  useEffect(() => {
    if (!connected) {
      setLoading(false);
      return;
    }
    if (!active) return;
    const service = connectionStore.getState().getService(hostId);
    if (!service) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const next = await service.readPanelSnapshot(name).catch(() => undefined);
      if (!cancelled) {
        setSnapshot(next);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hostId, name, connected, active]);
  const Panel = name === "usage" ? UsageView : ChangelogView;
  if (loading)
    return (
      <ForgeFrame title={t(`pi.forge.titles.${name}`)}>
        <Loading />
      </ForgeFrame>
    );
  return <Panel snapshot={snapshot} />;
}
