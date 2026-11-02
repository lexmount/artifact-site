import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

type Trace = { metrics: Record<string, number>; counts: Record<string, number>; bytes: number };
const context = new AsyncLocalStorage<{ trace: Trace; active: Set<string> }>();
export function uploadMetric(name: string, value: number) {
  const trace = context.getStore()?.trace;
  if (trace && Number.isFinite(value)) trace.metrics[name] = (trace.metrics[name] || 0) + value;
}
export function uploadCount(name: string, value: number) { const trace = context.getStore()?.trace; if (trace && Number.isFinite(value)) trace.counts[name] = (trace.counts[name] || 0) + value; }
export async function timeUpload<T>(name: string, work: () => Promise<T>): Promise<T> {
  const ctx = context.getStore();
  if (!ctx || ctx.active.has(name)) return work();
  const start = performance.now();
  ctx.trace.counts[name] = (ctx.trace.counts[name] || 0) + 1;
  try { return await context.run({ ...ctx, active: new Set([...ctx.active, name]) }, work); }
  finally { uploadMetric(name, performance.now() - start); }
}
export function uploadBytes(bytes: number) { const trace = context.getStore()?.trace; if (trace) trace.bytes = bytes; }
/** Only traced requests pay measurement overhead. Never record SQL, parameters or file contents. */
export function traceUploadStore<T extends object>(store: T): T {
  return new Proxy(store, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => context.getStore() ? timeUpload("db", () => Reflect.apply(value, target, args)) : Reflect.apply(value, target, args);
  } });
}
export async function traceUpload(request: Request, versionId: string, work: () => Promise<Response>) {
  const requestId = randomUUID(), start = performance.now(), startedAt = new Date().toISOString();
  const trace: Trace = { metrics: {}, counts: {}, bytes: 0 };
  const rawIndex = new URL(request.url).searchParams.get("index");
  const index = rawIndex && /^\d{1,8}$/.test(rawIndex) ? Number(rawIndex) : null;
  const ray = request.headers.get("cf-ray");
  return context.run({ trace, active: new Set() }, async () => {
    let status = 500;
    try {
      const response = await work(); status = response.status;
      response.headers.set("x-upload-request-id", requestId);
      response.headers.set("server-timing", [...Object.entries(trace.metrics), ["app", performance.now() - start]].map(([key, value]) => `${key};dur=${Number(value).toFixed(1)}`).join(", "));
      return response;
    } finally {
      console.info("[upload-timing]", JSON.stringify({ requestId, startedAt, versionId: /^[\w-]{1,100}$/.test(versionId) ? versionId : undefined, index, status, bytes: trace.bytes,
        cfRay: ray && /^[\w-]{1,80}$/.test(ray) ? ray : undefined,
        totalMs: Math.round(performance.now() - start), timingsMs: Object.fromEntries(Object.entries(trace.metrics).map(([k, v]) => [k, Math.round(v)])), calls: trace.counts }));
    }
  });
}
