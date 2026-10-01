// Raw binding of the PiSsh Expo module (android/src/main/java/sh/pimobile/ssh/PiSshModule.kt).
// App code should use src/ssh (SshClient), not this binding directly.

export interface PiSshConnectOptions {
  /** Caller-chosen unique id; events for this connection carry it. */
  connectionId: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** TCP + handshake timeout. Default 20000. Time spent waiting for respondHostKey is not counted. */
  timeoutMs?: number;
  /** How long to wait for respondHostKey before failing. Default 120000. */
  hostKeyTimeoutMs?: number;
  /** SSH keepalive interval. Default 15000. */
  keepaliveIntervalMs?: number;
}

export interface PiSshOpenShellOptions {
  connectionId: string;
  /** Caller-chosen unique id; data/close events carry it. */
  shellId: string;
  cols: number;
  rows: number;
  term?: string;
  command?: string;
}

export interface PiSshExecResult {
  stdout: string;
  stderr: string;
  /** Absent when the channel closed without an exit status. */
  exitCode?: number | null;
}

export interface PiSshHostKeyEvent {
  connectionId: string;
  requestId: string;
  algorithm: string;
  fingerprint: string;
}

export interface PiSshShellDataEvent {
  shellId: string;
  /** base64 bytes */
  data: string;
}

export interface PiSshShellCloseEvent {
  shellId: string;
  connectionId: string;
  exitCode?: number | null;
}

export interface PiSshConnectionCloseEvent {
  connectionId: string;
  /** "closed" after disconnect(), "lost" when the transport died. */
  reason: "closed" | "lost";
}

export interface PiSshEventMap {
  onHostKey: PiSshHostKeyEvent;
  onShellData: PiSshShellDataEvent;
  onShellClose: PiSshShellCloseEvent;
  onConnectionClose: PiSshConnectionCloseEvent;
}

export interface PiSshSubscription {
  remove(): void;
}

export interface PiSshNativeModule {
  connect(options: PiSshConnectOptions): Promise<string>;
  respondHostKey(requestId: string, accept: boolean): boolean;
  exec(
    connectionId: string,
    command: string,
    stdin: string | null,
    timeoutMs: number | null,
  ): Promise<PiSshExecResult>;
  openShell(options: PiSshOpenShellOptions): Promise<string>;
  write(shellId: string, base64: string): void;
  resize(shellId: string, cols: number, rows: number): void;
  closeShell(shellId: string): void;
  isConnected(connectionId: string): boolean;
  disconnect(connectionId: string): void;
  generateKeyPair(comment: string): Promise<{ privateKey: string; publicKey: string }>;
  addListener<K extends keyof PiSshEventMap>(
    eventName: K,
    listener: (event: PiSshEventMap[K]) => void,
  ): PiSshSubscription;
}
