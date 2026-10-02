// Shared SSH contract. Owned by the orchestrator: implementations (native module, node test double)
// and consumers (host service, UI) code against this file only. Change it only through the ledger.

export type SshAuth =
  | { type: "password"; password: string }
  | { type: "key"; privateKey: string; passphrase?: string };

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
}

/** Host key as presented by the server, for trust-on-first-use pinning. */
export interface SshHostKey {
  /** e.g. "ssh-ed25519" */
  algorithm: string;
  /** "SHA256:<base64>" as printed by ssh-keygen -l */
  fingerprint: string;
}

export interface SshConnectOptions {
  /** Called once per connect; resolve true to accept. Pinned keys are checked by the caller. */
  verifyHostKey: (key: SshHostKey) => Promise<boolean>;
  timeoutMs?: number;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  /** null when the channel closed without an exit status */
  exitCode: number | null;
}

export interface SshExecOptions {
  /** Written to the command's stdin, then stdin is closed. */
  stdin?: string;
  timeoutMs?: number;
}

export interface SshConnection {
  exec(command: string, options?: SshExecOptions): Promise<SshExecResult>;
  onClose(listener: (error?: Error) => void): () => void;
  isConnected(): boolean;
  close(): void;
}

export interface SshClient {
  connect(target: SshTarget, options: SshConnectOptions): Promise<SshConnection>;
  /** Returns { privateKey (OpenSSH PEM), publicKey ("ssh-ed25519 AAAA... comment") }. */
  generateKeyPair(comment: string): Promise<{ privateKey: string; publicKey: string }>;
}
