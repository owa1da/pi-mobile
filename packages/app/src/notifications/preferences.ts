export const PROJECT_ID = "d2696fae-ad1a-472f-9b34-8aeb34f66b20";
const STORAGE_KEY = "pi.notifications.v1";
const API_TIMEOUT_MS = 10000;
async function bounded<T>(action: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Push API timed out")), API_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
interface Permission {
  granted: boolean;
  canAskAgain?: boolean;
}
export interface NotificationApi {
  getPermissionsAsync(): Promise<Permission>;
  requestPermissionsAsync(options: {
    ios: { allowAlert: boolean; allowSound: boolean; allowBadge: boolean };
  }): Promise<Permission>;
  getExpoPushTokenAsync(options: { projectId: string }): Promise<{ data: string }>;
}
interface State {
  loaded: boolean;
  installationId: string;
  enabled: Record<string, boolean>;
  asked: boolean;
  denied: boolean;
  busy: boolean;
  error: boolean;
}
interface Deps {
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
  api: NotificationApi;
  newId(): string;
  register(hostId: string, installationId: string, token: string): Promise<void>;
  unregister(hostId: string, installationId: string): Promise<void>;
}

/** Non-secret preferences only. Tokens remain in memory and SSH stdin, never storage/logs. */
export function createNotificationPreferences(deps: Deps) {
  let state: State = {
    loaded: false,
    installationId: "",
    enabled: {},
    asked: false,
    denied: false,
    busy: false,
    error: false,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const persist = () =>
    deps.storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        installationId: state.installationId,
        enabled: state.enabled,
        asked: state.asked,
      }),
    );
  let loading: Promise<void> | undefined;
  const load = () =>
    (loading ??= (async () => {
      const raw = await deps.storage.getItem(STORAGE_KEY);
      let saved: Partial<State> = {};
      try {
        saved = raw ? JSON.parse(raw) : {};
      } catch {
        /* Ignore malformed non-secret preferences. */
      }
      const installationId =
        typeof saved?.installationId === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(saved.installationId)
          ? saved.installationId
          : deps.newId();
      const enabled: Record<string, boolean> = {};
      if (saved?.enabled && typeof saved.enabled === "object") {
        for (const [id, value] of Object.entries(saved.enabled))
          if (/^[A-Za-z0-9_-]{1,128}$/.test(id) && value === true) enabled[id] = true;
      }
      publish({ installationId, enabled, asked: saved?.asked === true });
      await persist();
      publish({ loaded: true });
    })());
  // Serialize registration/removal per host so disable/delete cannot race an in-flight write.
  const queues = new Map<string, Promise<void>>();
  function enqueue(hostId: string, action: () => Promise<void>): Promise<void> {
    const task = (queues.get(hostId) ?? Promise.resolve()).catch(() => undefined).then(action);
    queues.set(hostId, task);
    void task
      .finally(() => {
        if (queues.get(hostId) === task) queues.delete(hostId);
      })
      .catch(() => undefined);
    return task;
  }
  // Expo calls must never occupy the SSH mutation queue: opt-out/delete can proceed
  // while permission or token acquisition is stalled.
  const write = async (hostId: string) => {
    const token = (await bounded(deps.api.getExpoPushTokenAsync({ projectId: PROJECT_ID }))).data;
    await enqueue(hostId, async () => {
      if (state.enabled[hostId]) await deps.register(hostId, state.installationId, token);
    });
  };
  const renew = async (hostId: string) => {
    await load();
    if (!state.enabled[hostId]) return;
    try {
      const permission = await bounded(deps.api.getPermissionsAsync());
      publish({ denied: !permission.granted });
      if (permission.granted && state.enabled[hostId]) await write(hostId);
    } catch {
      publish({ error: true });
    }
  };
  const intents = new Map<string, number>();
  const disable = async (hostId: string) => {
    await load();
    intents.set(hostId, (intents.get(hostId) ?? 0) + 1);
    const enabled = { ...state.enabled };
    delete enabled[hostId];
    publish({ enabled });
    // Local opt-out must take effect even if persistence/removal fails or a prior token fetch stalls.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([
          persist(),
          enqueue(hostId, () => deps.unregister(hostId, state.installationId)),
        ]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Push removal timed out")), 4000);
        }),
      ]);
    } catch {
      publish({ error: true });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return {
    load,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    renew,
    forget: disable,
    async setEnabled(hostId: string, enabled: boolean) {
      if (state.busy && enabled) return;
      publish({ busy: true, denied: false, error: false });
      try {
        await load();
        if (!enabled) {
          await disable(hostId);
          return;
        }
        const intent = intents.get(hostId) ?? 0;
        let permission = await bounded(deps.api.getPermissionsAsync());
        publish({ denied: !permission.granted });
        if (!permission.granted && !state.asked && permission.canAskAgain !== false) {
          publish({ asked: true });
          await persist();
          permission = await bounded(
            deps.api.requestPermissionsAsync({
              ios: { allowAlert: true, allowSound: true, allowBadge: false },
            }),
          );
          publish({ denied: !permission.granted });
        }
        if (!permission.granted) {
          publish({ denied: true });
          return;
        }
        if ((intents.get(hostId) ?? 0) !== intent) return;
        publish({ enabled: { ...state.enabled, [hostId]: true } });
        await persist();
        // Granted by this explicit request: no second permission query is needed.
        await write(hostId);
      } catch {
        publish({ error: true });
      } finally {
        publish({ busy: false });
      }
    },
    async tokenChanged() {
      await load();
      await Promise.all(Object.keys(state.enabled).map(renew));
    },
  };
}
