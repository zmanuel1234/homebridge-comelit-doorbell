/** Channel type ids used in binary COMMAND packets when opening a channel. */
export enum ChannelType {
  UAUT = 7,
  UCFG = 2,
  INFO = 20,
  CTPP = 16,
  CSPB = 17,
}
/** PUSH uses the same wire type as UCFG; the device tells them apart by channel name. */
export const CHANNEL_TYPE_PUSH = ChannelType.UCFG;

/** Message ids used in JSON `message-id` fields (not the same as ChannelType). */
export enum ViperMessageId {
  UAUT = 2,
  UCFG = 3,
  SERVER_INFO = 20,
  PUSH = 2,
}

export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(item: T | null) => void> = [];

  enqueue(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  /** Resolves with the next item, or null after `timeoutMs` or when the queue is cleared. */
  dequeue(timeoutMs = 30_000): Promise<T | null> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift()!);
    }
    return new Promise((resolve) => {
      const waiter = (item: T | null) => {
        clearTimeout(timer);
        resolve(item);
      };
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  clear(): void {
    for (const w of this.waiters) {
      w(null);
    }
    this.waiters = [];
    this.items = [];
  }
}

export class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

export interface Channel {
  name: string;
  channelType: number;
  requestId: number;
  serverChannelId: number;
  sequence: number;
  isOpen: boolean;
  openBody: Buffer;
  responseQueue: AsyncQueue<Buffer>;
  sendMutex: AsyncMutex;
  openResolve?: (body: Buffer) => void;
  openReject?: (err: Error) => void;
}

export function createChannel(name: string, channelType: number, requestId: number): Channel {
  return {
    name,
    channelType,
    requestId,
    serverChannelId: 0,
    sequence: 1,
    isOpen: false,
    openBody: Buffer.alloc(0),
    responseQueue: new AsyncQueue<Buffer>(),
    sendMutex: new AsyncMutex(),
  };
}
