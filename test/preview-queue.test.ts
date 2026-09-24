import { afterEach, expect, it, vi } from "vitest";
import { PreviewQueue } from "@/lib/preview-queue";
afterEach(() => vi.useRealTimers());
it("serializes previews and skips cancelled queued cards", () => {
  vi.useFakeTimers();
  const queue = new PreviewQueue(), started: number[] = [];
  let finish!: () => void;
  queue.enqueue(done => { started.push(1); finish = done; });
  const cancel = queue.enqueue(() => started.push(2));
  queue.enqueue(() => started.push(3));
  cancel(); expect(started).toEqual([1]);
  finish(); finish(); vi.runAllTimers();
  expect(started).toEqual([1, 3]);
});
