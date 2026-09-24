/** In-memory only. Keys must include identity and explicit link/receipt credentials. */
export class RequestCache<T> {
  private entries = new Map<
    string,
    {
      promise: Promise<T>;
      controller: AbortController;
      refs: number;
      expires: number;
      done: boolean;
    }
  >();
  constructor(
    private ttl = 30_000,
    private limit = 128,
  ) {}
  clear() {
    for (const e of this.entries.values()) e.controller.abort();
    this.entries.clear();
  }
  acquire(key: string, load: (signal: AbortSignal) => Promise<T>) {
    let entry = this.entries.get(key);
    if (entry?.done && entry.expires <= Date.now()) {
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      const controller = new AbortController();
      const created = {
        controller,
        refs: 0,
        expires: 0,
        done: false,
        promise: null as unknown as Promise<T>,
      };
      created.promise = load(controller.signal).then(
        (value) => {
          created.done = true;
          created.expires = Date.now() + this.ttl;
          return value;
        },
        (error) => {
          if (this.entries.get(key) === created) this.entries.delete(key);
          throw error;
        },
      );
      entry = created;
      for (const [k, e] of this.entries) {
        if (this.entries.size < this.limit) break;
        if (e.done && e.refs === 0) this.entries.delete(k);
      }
      // Do not cancel active consumers to make room. Overflow keys run uncached.
      if (this.entries.size < this.limit) this.entries.set(key, entry);
    }
    const held = entry;
    held.refs++;
    let released = false;
    return {
      promise: held.promise,
      release: () => {
        if (released) return;
        released = true;
        held.refs--;
        // Allow effect replay to reacquire the same in-flight request.
        setTimeout(() => {
          if (!held.refs && !held.done) {
            held.controller.abort();
            if (this.entries.get(key) === held) this.entries.delete(key);
          }
        }, 0);
      },
    };
  }
}
