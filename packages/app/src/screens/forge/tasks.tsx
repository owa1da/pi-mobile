// /tasks: rows as forge's tasks panel shows them (name, status), each opening its own view: a
// shell's log tail (task.tail), an agent's transcript from its session file with a composer
// (agent.send: steer while it works, else a follow-up), and stop / resume where forge allows.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChatView } from "@/components/pi/chat-view";
import { Composer } from "@/components/pi/composer";
import { ActionBar, sheetActionStyles } from "@/components/pi/sheet-actions";
import { Button } from "@/components/ui/button";
import type { RemoteTask } from "@/remote/types";
import { findTask, tailText, taskRows, taskRunning, taskView } from "@/remote/views";
import { useChatFeed } from "@/screens/session/use-chat-feed";
import { usePoller } from "@/stores/use-polling";
import type { ForgeViewProps } from "./forge-screen";
import {
  ErrorLine,
  ForgeFrame,
  forgeStyles,
  ListRow,
  Loading,
  openForge,
  TranscriptProviders,
  UpdateForge,
  useForgeAction,
} from "./parts";

const keyOf = (task: RemoteTask) => `${task.owner}\n${task.key}`;
const isRunning = taskRunning;

/** Steer while the agent works; a finished one that can go on resumes with the message. */
function composerPlaceholder(working: boolean, resumes: boolean): string {
  if (working) return "pi.forge.tasks.steer";
  return resumes ? "pi.forge.tasks.resumeWith" : "pi.forge.tasks.followUp";
}

export function TasksView({ hostId, row, channel }: ForgeViewProps) {
  const { t } = useTranslation();
  const tasks = channel.state?.tasks;
  const rows = useMemo(() => (tasks ? taskRows(tasks) : []), [tasks]);
  const sessionId = row.sessionId;
  const openTask = useCallback(
    (id: string) => {
      const [owner = "", key = ""] = id.split("\n");
      openForge(hostId, sessionId, "task", { owner, key });
    },
    [hostId, sessionId],
  );
  const renderTask = useCallback(
    ({ item }: { item: RemoteTask }) => (
      <ListRow
        title={item.name}
        subtitle={item.status}
        pressKey={keyOf(item)}
        onPressKey={openTask}
        testID={`task-row-${item.key}`}
      />
    ),
    [openTask],
  );
  let body;
  if (!channel.available || (channel.loaded && tasks === undefined)) body = <UpdateForge />;
  else if (!channel.loaded) body = <Loading />;
  else if (rows.length === 0)
    body = <Text style={forgeStyles.intro}>{t("pi.forge.tasks.empty")}</Text>;
  else
    body = (
      <FlatList data={rows} keyExtractor={keyOf} renderItem={renderTask} testID="tasks-list" />
    );
  return <ForgeFrame title={t("pi.forge.titles.tasks")}>{body}</ForgeFrame>;
}

export function TaskView({ hostId, channel, active, params }: ForgeViewProps) {
  const { t } = useTranslation();
  const task = findTask(channel.state?.tasks, params.owner ?? "", params.key ?? "");
  const action = useForgeAction(channel);
  const run = action.run;
  // An agent resumes with a message (its composer); a run resumes with a button; both stop here.
  const showFooter = Boolean(
    task && !action.unsupported && (task.canStop || (task.canResume && task.kind !== "agent")),
  );
  return (
    <ForgeFrame title={task?.name ?? t("pi.forge.titles.task")}>
      {task ? (
        <Text style={forgeStyles.intro} testID="task-status">
          {task.status}
        </Text>
      ) : null}
      <View style={styles.fill}>
        <TaskBody
          hostId={hostId}
          task={task}
          active={active}
          run={run}
          busy={action.busy !== null}
          ready={channel.loaded}
          unavailable={!channel.available || action.unsupported}
        />
      </View>
      <ErrorLine message={action.error} onDismiss={action.clearError} />
      {showFooter && task ? <TaskFooter task={task} run={run} busy={action.busy} /> : null}
    </ForgeFrame>
  );
}

function TaskBody({
  hostId,
  task,
  active,
  run,
  busy,
  ready,
  unavailable,
}: {
  hostId: string;
  task: RemoteTask | undefined;
  active: boolean;
  run: ReturnType<typeof useForgeAction>["run"];
  busy: boolean;
  ready: boolean;
  unavailable: boolean;
}) {
  const { t } = useTranslation();
  if (unavailable) return <UpdateForge />;
  if (!ready) return <Loading />;
  if (!task) return <Text style={forgeStyles.intro}>{t("pi.forge.tasks.gone")}</Text>;
  const view = taskView(task);
  if (view === "transcript")
    return <AgentTranscript hostId={hostId} task={task} active={active} run={run} busy={busy} />;
  if (view === "tail") return <TailView task={task} active={active} run={run} />;
  return <Text style={forgeStyles.intro}>{task.detail ?? ""}</Text>;
}

function TaskFooter({
  task,
  run,
  busy,
}: {
  task: RemoteTask;
  run: ReturnType<typeof useForgeAction>["run"];
  busy: string | null;
}) {
  const { t } = useTranslation();
  const stop = useCallback(() => {
    void run("task.stop", { owner: task.owner, key: task.key });
  }, [run, task.key, task.owner]);
  const resume = useCallback(() => {
    void run("task.resume", { runId: runIdOf(task) });
  }, [run, task]);
  return (
    <ActionBar>
      {task.canStop ? (
        <Button
          variant="destructive"
          onPress={stop}
          loading={busy === "task.stop"}
          style={sheetActionStyles.button}
          testID="task-stop"
        >
          {t("pi.forge.tasks.stop")}
        </Button>
      ) : (
        <Button
          variant="default"
          onPress={resume}
          loading={busy === "task.resume"}
          style={sheetActionStyles.button}
          testID="task-resume"
        >
          {t("pi.forge.tasks.resume")}
        </Button>
      )}
    </ActionBar>
  );
}

/** A workflow run's id: the last part of its run dir (forge names runs by their dir), else its key. */
function runIdOf(task: RemoteTask): string {
  const dir = task.runDir?.replace(/\/+$/, "");
  return dir ? dir.slice(dir.lastIndexOf("/") + 1) : task.key;
}

function TailView({
  task,
  active,
  run,
}: {
  task: RemoteTask;
  active: boolean;
  run: ReturnType<typeof useForgeAction>["run"];
}) {
  const { t } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  const owner = task.owner;
  const key = task.key;
  const live = isRunning(task);
  const load = useCallback(async () => {
    const out = await run("task.tail", { owner, key, bytes: 64 * 1024 }, ["stale", "timeout"]);
    if (out.ok) setText(tailText(out.data));
    return live ? 2000 : 0;
  }, [key, live, owner, run]);
  const kick = usePoller(load, 2000, active && live);
  useEffect(() => {
    if (!live) kick();
  }, [kick, live]);
  if (text === null) return <Loading testID="task-tail-loading" />;
  return (
    <ScrollView contentContainerStyle={forgeStyles.scroll} testID="task-tail">
      <ScrollView horizontal contentContainerStyle={styles.hscroll}>
        <Text style={[forgeStyles.mono, styles.tail]} selectable>
          {text || t("pi.forge.tasks.noOutput")}
        </Text>
      </ScrollView>
    </ScrollView>
  );
}

function AgentTranscript({
  hostId,
  task,
  active,
  run,
  busy,
}: {
  hostId: string;
  task: RemoteTask;
  active: boolean;
  run: ReturnType<typeof useForgeAction>["run"];
  busy: boolean;
}) {
  const { t } = useTranslation();
  const working = isRunning(task);
  // A finished agent that can go on: the message resumes it (agent.resume {key, text}).
  const resumes = !working && task.canResume;
  const source = useMemo(
    () => ({
      sessionFile: task.sessionFile ?? undefined,
      state: working ? ("working" as const) : ("idle" as const),
    }),
    [task.sessionFile, working],
  );
  const feed = useChatFeed(hostId, source, active);
  const key = task.key;
  const send = useCallback(
    async (text: string) => {
      const out = resumes
        ? await run("agent.resume", { key, text })
        : await run("agent.send", { key, text, mode: working ? "steer" : "followUp" });
      if (out.ok) feed.boost();
      return out.ok;
    },
    [feed, key, resumes, run, working],
  );
  return (
    <View style={styles.fill}>
      <TranscriptProviders>
        <ChatView rows={feed.rows} truncated={feed.truncated} loading={feed.loading} />
      </TranscriptProviders>
      <Composer
        placeholder={t(composerPlaceholder(working, resumes))}
        onSubmit={send}
        busy={busy}
        testID="agent-composer"
        sendTestID="agent-send"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1 },
  hscroll: { minWidth: "100%" },
  tail: { paddingHorizontal: theme.spacing[4], paddingVertical: theme.spacing[2] },
}));
