export interface LocalReadProgress { version:1; since:number; seen:string[] }
export function parseReadProgress(raw:string|null): LocalReadProgress|null {
  try {
    const value=JSON.parse(raw || "null");
    // Legacy baselines came from the device clock and cannot be trusted.
    if(value?.version!==1 || !Number.isFinite(value.since) || value.since<0 || !Array.isArray(value.seen)) return null;
    return {version:1,since:value.since,seen:value.seen.filter((id:unknown)=>typeof id==="string").slice(-2000)};
  } catch {return null;}
}
export function mergeReadProgress(a:LocalReadProgress,b:LocalReadProgress|null):LocalReadProgress {
  return {version:1,since:Math.max(a.since,b?.since ?? 0),seen:Array.from(new Set([...a.seen,...(b?.seen ?? [])])).sort().slice(-2000)};
}
