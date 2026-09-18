import {expect,it} from "vitest";
import {parseReadProgress,mergeReadProgress} from "@/components/comments/read-progress";
it("rejects legacy device-clock baselines and malformed storage",()=>{
  expect(parseReadProgress(JSON.stringify({since:Date.now()+999999,seen:[]}))).toBeNull();
  expect(parseReadProgress("broken")).toBeNull();
});
it("merges tabs without losing receipts or rolling back mark-all-read",()=>{
  const a={version:1 as const,since:100,seen:["m1"]};
  const b={version:1 as const,since:200,seen:["m2"]};
  const merged=mergeReadProgress(a,b);
  expect(merged).toEqual({version:1,since:200,seen:["m1","m2"]});
  expect(mergeReadProgress(merged,a)).toEqual(merged);
  expect(mergeReadProgress(b,a)).toEqual(merged);
  expect(parseReadProgress(JSON.stringify(merged))).toEqual(merged);
});
it("bounds retained receipts",()=>{
  expect(mergeReadProgress({version:1,since:1,seen:Array.from({length:3000},(_,i)=>String(i))},null).seen).toHaveLength(2000);
});
