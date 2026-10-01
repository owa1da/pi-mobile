// Per-shell event fan-out shared by the native and Node clients.
// Data that arrives before the first onData listener is buffered (bounded) and delivered to it on
// a microtask; the close notification is never delivered before buffered data.

const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

type DataListener = (bytes: Uint8Array) => void;
type CloseListener = (exitCode: number | null) => void;

function safeCall<T>(fn: (value: T) => void, value: T): void {
  try {
    fn(value);
  } catch (error) {
    // A throwing listener must not break delivery to the others.
    setTimeout(() => {
      throw error;
    }, 0);
  }
}

export class ShellEvents {
  private readonly dataListeners = new Set<DataListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private buffered: Uint8Array[] = [];
  private bufferedBytes = 0;
  private flushPending = false;
  private closed = false;
  private closeDelivered = false;
  private exitCode: number | null = null;

  constructor(private readonly maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES) {}

  get isClosed(): boolean {
    return this.closed;
  }

  pushData(bytes: Uint8Array): void {
    if (this.closed || bytes.length === 0) return;
    if (this.dataListeners.size === 0 || this.flushPending) {
      this.buffer(bytes);
      return;
    }
    for (const listener of Array.from(this.dataListeners)) safeCall(listener, bytes);
  }

  pushClose(exitCode: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = exitCode;
    if (!this.flushPending) this.deliverClose();
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    if (this.buffered.length > 0 && !this.flushPending) {
      this.flushPending = true;
      queueMicrotask(() => this.flush());
    }
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    if (this.closeDelivered) {
      queueMicrotask(() => {
        if (this.closeListeners.has(listener)) {
          this.closeListeners.delete(listener);
          safeCall(listener, this.exitCode);
        }
      });
    }
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  private buffer(bytes: Uint8Array): void {
    this.buffered.push(bytes);
    this.bufferedBytes += bytes.length;
    while (this.bufferedBytes > this.maxBufferedBytes && this.buffered.length > 1) {
      const dropped = this.buffered.shift();
      this.bufferedBytes -= dropped ? dropped.length : 0;
    }
  }

  private flush(): void {
    const chunks = this.buffered;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.flushPending = false;
    for (const chunk of chunks) {
      for (const listener of Array.from(this.dataListeners)) safeCall(listener, chunk);
    }
    if (this.closed && !this.closeDelivered) this.deliverClose();
  }

  private deliverClose(): void {
    this.closeDelivered = true;
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) safeCall(listener, this.exitCode);
    this.dataListeners.clear();
  }
}
