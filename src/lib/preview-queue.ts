/** One thumbnail entry at a time; every job must release its slot, including on unmount. */
export class PreviewQueue {
  private waiting: { start: (done: () => void) => void; active: boolean }[] = [];
  private running = false;
  enqueue(start: (done: () => void) => void) {
    const job = { start, active: true };
    this.waiting.push(job);
    this.pump();
    return () => { job.active = false; };
  }
  private pump() {
    if (this.running) return;
    const job = this.waiting.shift();
    if (!job) return;
    if (!job.active) { this.pump(); return; }
    this.running = true;
    let finished = false;
    job.start(() => {
      if (finished) return;
      finished = true;
      this.running = false;
      // Let React remove cancelled frames before admitting the next entry.
      setTimeout(() => this.pump(), 150);
    });
  }
}
export const previewQueue = new PreviewQueue();
