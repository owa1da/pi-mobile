// A native forge screen over one session: the route /h/[hostId]/f/[sessionId]/[tool]. It keeps the
// host listing and the session's remote channel polled while visible, then hands both to the view.

import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/pi/empty-state";
import type { SessionRow } from "@/host/types";
import {
  connectionStore,
  refreshSessions,
  useHostConnection,
  useHostsLoaded,
  useSessionsEntry,
} from "@/stores/app";
import { findRow } from "@/stores/sessions-store";
import { useAppActive, usePoller, useScreenFocused } from "@/stores/use-polling";
import { useRemoteChannel, type RemoteChannel } from "@/screens/session/use-remote-channel";
import { ForgeFrame, Loading, type ForgeTool } from "./parts";
import { RewindView } from "./rewind";
import { CheckpointsView, DiffView } from "./checkpoints";
import { BtwView, SideView } from "./side-btw";
import { TaskView, TasksView } from "./tasks";
import { ModelView } from "./model";
import { ChangelogView, CostView, UsageView } from "./info";

export interface ForgeViewProps {
  hostId: string;
  row: SessionRow;
  channel: RemoteChannel;
  active: boolean;
  params: Record<string, string | undefined>;
}

const VIEWS: Record<ForgeTool, (props: ForgeViewProps) => React.ReactNode> = {
  rewind: RewindView,
  checkpoints: CheckpointsView,
  diff: DiffView,
  side: SideView,
  btw: BtwView,
  tasks: TasksView,
  task: TaskView,
  model: ModelView,
  usage: UsageView,
  cost: CostView,
  changelog: ChangelogView,
};

export function ForgeScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<Record<string, string>>();
  const hostId = params.hostId ?? "";
  const sessionId = params.sessionId ?? "";
  const tool = params.tool as ForgeTool;
  const hostsLoaded = useHostsLoaded();
  const connection = useHostConnection(hostId);
  const entry = useSessionsEntry(hostId);
  const focused = useScreenFocused();
  const appActive = useAppActive();
  const connected = connection.status === "connected";
  useEffect(() => {
    if (hostsLoaded) void connectionStore.getState().ensureConnected(hostId);
  }, [hostId, hostsLoaded]);
  const poll = useCallback(() => refreshSessions(hostId).then(() => undefined), [hostId]);
  usePoller(poll, 2000, focused && appActive && connected);
  const row = findRow(entry, sessionId);
  const View = VIEWS[tool];
  if (!View) return null;
  if (!row)
    return (
      <ForgeFrame title={t(`pi.forge.titles.${tool}`)}>
        {entry?.snapshot ? (
          <EmptyState title={t("pi.session.goneTitle")} body={t("pi.session.goneBody")} />
        ) : (
          <Loading />
        )}
      </ForgeFrame>
    );
  return (
    <ForgeBody
      hostId={hostId}
      row={row}
      active={focused && appActive}
      entry={entry}
      params={params}
      View={View}
    />
  );
}

function ForgeBody({
  hostId,
  row,
  active,
  entry,
  params,
  View,
}: Omit<ForgeViewProps, "channel"> & {
  entry: ReturnType<typeof useSessionsEntry>;
  View: (props: ForgeViewProps) => React.ReactNode;
}) {
  const channel = useRemoteChannel(hostId, row, entry, active);
  return <View hostId={hostId} row={row} channel={channel} active={active} params={params} />;
}
