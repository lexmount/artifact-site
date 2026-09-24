"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { commentRequest, CommentRequestError, commentPollDelay } from "./comment-client";
import { parseReadProgress, mergeReadProgress, type LocalReadProgress } from "./read-progress";
interface Unread {initialized?:boolean; since:number; snapshotAt:number; hasMore:boolean; messages:{id:string;threadId:string;createdAt:number}[]}
const empty: Unread = {since:0,snapshotAt:0,hasMore:false,messages:[]};
/** Progress follows the account/entry, not the current list filters or sidebar visibility. */
export function useCommentUnread({endpoint,versionId,shareId,aggregate,userId,token,enabled,open,workspace}: {endpoint:string; versionId:string; shareId?:string; aggregate:boolean; userId?:string|null; token?:string; enabled:boolean; open:boolean; workspace:RefObject<HTMLDivElement|null>}) {
  const refresh = useRef<()=>void>(()=>{});
  useEffect(()=>{if(open)refresh.current();},[open]);
  const openRef = useRef(open);
  useEffect(()=>{openRef.current=open;},[open]);
  const key = JSON.stringify([endpoint,aggregate ? "aggregate" : versionId,shareId ?? "main",userId ?? "guest"]);
  const [state,setState] = useState<{key:string;data:Unread}>({key:"",data:empty});
  const data = state.key === key ? state.data : empty;
  const current = useRef(key);
  const latest = useRef(data);
  useEffect(() => { current.current = key; latest.current = data; }, [key,data]);
  const pending = useRef(new Set<string>());
  const local = useRef<LocalReadProgress>({version:1,since:0,seen:[]});
  const accept = useCallback((value:Unread) => {
    if (current.current !== key || value.snapshotAt < latest.current.snapshotAt) return;
    if (userId) local.current.since=Math.max(local.current.since,value.since);
    if (!userId) {
      // Only server-clock baselines are persisted. Merge before every write so tabs
      // converge, and never clamp a newer tab's watermark to an older poll response.
      if(!local.current.since) local.current.since=value.since;
      try {
        local.current=mergeReadProgress(local.current,parseReadProgress(localStorage.getItem(`artifact-comment-read:${key}`)));
        const serialized=JSON.stringify(local.current);
        if(localStorage.getItem(`artifact-comment-read:${key}`)!==serialized) localStorage.setItem(`artifact-comment-read:${key}`,serialized);
      } catch { /* visit-only progress */ }
    }
    value = {...value,messages:value.messages.filter(message=>message.createdAt>local.current.since && !local.current.seen.includes(message.id))};
    latest.current=value;
    setState({key,data:value});
  },[key,userId]);
  useEffect(() => {
    pending.current.clear();
    if (!enabled) return;
    let stopped = false, inFlight=false, failures=0, generation=0, queued=false, timer:ReturnType<typeof setTimeout>;
    let lastStarted = -Infinity, retryAt = 0;
    const storage = `artifact-comment-read:${key}`;
    local.current = {version:1,since:0,seen:[]};
    if (!userId) {
      try {local.current=parseReadProgress(localStorage.getItem(storage)) ?? local.current;} catch { /* visit-only progress */ }
    }
    const poll = async () => {
      if (stopped || document.hidden) return;
      if (Date.now() < retryAt) { clearTimeout(timer); timer=setTimeout(()=>void poll(),retryAt-Date.now()); return; }
      if (inFlight) { queued=true; return; }
      const sequence=generation;
      clearTimeout(timer);
      inFlight=true;
      lastStarted=Date.now();
      const query = new URLSearchParams({versionId,aggregate:String(aggregate)});
      if (shareId) query.set("shareId",shareId);
      if (!userId && local.current.since) query.set("since",String(local.current.since));
      try {
        let value = await commentRequest<Unread>(`${endpoint}/unread?${query}`,token);
        if (!stopped && sequence===generation && userId && value.initialized === false) value = await commentRequest<Unread>(`${endpoint}/unread`,token,{method:"POST",body:JSON.stringify({versionId,shareId,aggregate,through:value.snapshotAt})});
        if (!stopped && sequence===generation) {failures=0;retryAt=0;accept(value);}
      }
      catch (error) { if (sequence===generation) { failures++; retryAt=Date.now()+commentPollDelay(failures); } if (!stopped && sequence===generation && error instanceof CommentRequestError && [401,403,404].includes(error.status)) setState({key,data:empty}); }
      inFlight=false;
      if (!stopped && queued) { queued=false; queueMicrotask(()=>void poll()); return; }
      if (!stopped && !document.hidden) timer=setTimeout(poll,failures ? commentPollDelay(failures) : openRef.current ? 15000 : 60000);
    };
    refresh.current=()=>void poll();
    void poll();
    const wake = () => {clearTimeout(timer); if (!document.hidden) timer=setTimeout(()=>void poll(),Math.max(0,retryAt-Date.now()));};
    const focused = () => { if (!inFlight && Date.now()-lastStarted >= 10000) wake(); };
    const storageChanged = (event:StorageEvent) => {
      if (userId || event.key!==storage || !event.newValue) return;
      const saved=parseReadProgress(event.newValue);
      if(!saved)return;
      local.current=mergeReadProgress(local.current,saved);
      accept(latest.current);
      wake();
    };
    const mutation = (event: Event) => { const change=(event as CustomEvent<{endpoint:string;phase:string}>).detail; if(change?.endpoint!==endpoint)return; if(change.phase==="start")generation++; else wake(); };
    window.addEventListener("artifact:comment-mutation",mutation);
    window.addEventListener("storage",storageChanged);
    document.addEventListener("visibilitychange",wake);
    window.addEventListener("focus",focused);
    return () => {stopped=true;window.removeEventListener("artifact:comment-mutation",mutation);refresh.current=()=>{};clearTimeout(timer);document.removeEventListener("visibilitychange",wake);window.removeEventListener("focus",focused);window.removeEventListener("storage",storageChanged);};
  },[key,endpoint,versionId,shareId,aggregate,userId,token,enabled,accept]);
  const acknowledge = useCallback(async (ids:string[],all=false) => {
    if (!enabled || current.current!==key) return;
    const through=latest.current.snapshotAt;
    if (!userId) {
      try {local.current=mergeReadProgress(local.current,parseReadProgress(localStorage.getItem(`artifact-comment-read:${key}`)));} catch { /* optional persistence */ }
      if (all) local.current={version:1,since:Math.max(local.current.since,through),seen:[]};
      else local.current.seen=Array.from(new Set([...local.current.seen,...ids])).slice(-2000);
      accept({...latest.current,messages:all?[]:latest.current.messages.filter(item=>!ids.includes(item.id)),hasMore:all?false:latest.current.hasMore});
      ids.forEach(id=>pending.current.delete(id));
      return;
    }
    try {
      const value=await commentRequest<Unread>(`${endpoint}/unread`,token,{method:"POST",body:JSON.stringify({versionId,shareId,aggregate,...(all?{through}:{messageIds:ids.slice(0,100)})})});
      if (current.current===key) local.current.seen=Array.from(new Set([...local.current.seen,...ids])).slice(-1000);
      accept(value);
    } finally {ids.forEach(id=>pending.current.delete(id));}
  },[enabled,key,userId,accept,endpoint,token,versionId,shareId,aggregate]);
  useEffect(() => {
    if (!open || !enabled || !data.messages.length) return;
    const root=workspace.current?.querySelector(".comment-panel-content");
    const container=workspace.current;
    if (!container) return;
    const timers=new Map<Element,ReturnType<typeof setTimeout>>();
    const ready=new Set<string>();
    let flush:ReturnType<typeof setTimeout> | undefined;
    const observer=new IntersectionObserver(entries=>{
      for (const entry of entries) {
        clearTimeout(timers.get(entry.target));
        const id=(entry.target as HTMLElement).dataset.messageId;
        if (!id || (!entry.isIntersecting || entry.intersectionRect.height < Math.min(entry.boundingClientRect.height * 0.5,100)) || document.hidden || pending.current.has(id) || !data.messages.some(item=>item.id===id)) continue;
        timers.set(entry.target,setTimeout(()=>{
          if (document.hidden) return;
          ready.add(id);
          clearTimeout(flush);
          flush=setTimeout(()=>{
            const ids=Array.from(ready).slice(0,100); ready.clear();
            ids.forEach(id=>pending.current.add(id));
            void acknowledge(ids).catch(()=>{});
          },1500);
        },800));
      }
    },{root,threshold:[0,0.1,0.25,0.5,0.75,1]});
    const observe=()=>container.querySelectorAll("[data-message-id]").forEach(element=>observer.observe(element));
    observe();
    const changes=new MutationObserver(observe); changes.observe(container,{subtree:true,childList:true});
    return ()=>{observer.disconnect();changes.disconnect();timers.forEach(clearTimeout);clearTimeout(flush);};
  },[open,enabled,data.messages,workspace,acknowledge]);
  return {hasMore:data.hasMore,unreadThreadIds:new Set(enabled ? data.messages.map(item=>item.threadId) : []),hasUnread:enabled && (data.messages.length>0 || data.hasMore),markAllRead:()=>acknowledge([],true)};
}
