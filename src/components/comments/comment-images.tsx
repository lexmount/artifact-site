"use client";
import { browserRandomId } from "@/lib/browser-random-id";
import { useEffect, useLayoutEffect, useRef, useState, useId } from "react";
import { uploadCommentImage } from "@/lib/comments/upload-image";
import { ImagePlus, RefreshCw, X } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { commentAttachmentSchema, type CommentAttachment, type CommentScope } from "@/lib/comments/contracts";

/** Fetch with the host credential; never put share tokens in image URLs or persisted drafts. */
export function CommentImage({attachment, endpoint, shareToken}: {attachment: CommentAttachment; endpoint: string; shareToken?: string}) {
  const t = useT();
  const host = useRef<HTMLSpanElement>(null);
  const descriptionId = useId();
  const [nearby, setNearby] = useState(false);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    if (!("IntersectionObserver" in window)) {
      // Defer fallback updates to satisfy react-hooks/set-state-in-effect.
      let active = true;
      queueMicrotask(() => { if (active) setNearby(true); });
      return () => { active = false; };
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setNearby(true); observer.disconnect(); }
    }, {rootMargin: "160px"});
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLButtonElement>(null);
  const identity=JSON.stringify([attachment.id,endpoint,shareToken,attempt]);
  const [loadedIdentity,setLoadedIdentity]=useState("");
  useEffect(() => {
    if (!nearby) return;
    let active = true, objectUrl = "";
    const controller = new AbortController();
    fetch(`${endpoint}/attachments/${encodeURIComponent(attachment.id)}`, {headers:shareToken ? {"x-artifact-share":shareToken} : {},cache:"no-store",signal:controller.signal})
      .then(async response => {if (!response.ok) throw new Error(); return response.blob();})
      .then(blob => {if (active) {objectUrl = URL.createObjectURL(blob);setUrl(objectUrl);setFailed(false);setLoadedIdentity(identity);}})
      .catch(() => {if(active) {setFailed(true);setLoadedIdentity(identity);}});
    return () => {active=false;controller.abort();if(objectUrl) URL.revokeObjectURL(objectUrl);};
  }, [attachment.id, endpoint, shareToken, attempt, identity, nearby]);
  return <span ref={host} className="comment-image-slot">
    <span id={descriptionId} className="sr-only">{attachment.name}</span>
    {loadedIdentity !== identity || (!failed && !url) ? <span className="comment-image-loading">{nearby ? t("Loading image…") : ""}</span> : failed ?
      <button type="button" className="comment-image-retry" aria-describedby={descriptionId} onClick={()=>setAttempt(value=>value+1)}><RefreshCw size={14}/>{t("Image unavailable. Retry")}</button> : <>
      <button ref={preview} type="button" className="comment-image-preview" aria-label={t("Preview image")} aria-describedby={descriptionId} onClick={()=>dialog.current?.showModal()}>
        {/* Safe raster response from the authorized attachment service; never artifact HTML. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={attachment.name} width={attachment.width} height={attachment.height}/>
      </button>
      <dialog ref={dialog} aria-label={t("Preview image")} aria-describedby={descriptionId} onClose={()=>preview.current?.focus()} className="comment-image-dialog" onClick={event=>{if(event.target===event.currentTarget) dialog.current?.close();}} onKeyDown={event=>event.stopPropagation()}>
        <button type="button" aria-label={t("Close image preview")} onClick={()=>dialog.current?.close()}><X size={20}/></button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={attachment.name}/>
      </dialog>
    </>}
  </span>;
}
export function CommentImages({attachments, endpoint, shareToken}: {attachments?: CommentAttachment[]; endpoint:string; shareToken?:string}) {
  if (!attachments?.length) return null;
  return <div className="comment-images">{attachments.map(attachment=><CommentImage key={attachment.id} attachment={attachment} endpoint={endpoint} shareToken={shareToken}/>)}</div>;
}
type Pending = {id:string;file:File;error:boolean;progress?:number;reason?:"image_too_large"|"image_invalid"};
export function CommentUpload({attachments,onChange,endpoint,scope,shareToken,disabled,onPending,textarea}: {
  attachments:CommentAttachment[];onChange:(next:CommentAttachment[])=>void;endpoint:string;scope:CommentScope;shareToken?:string;disabled:boolean;onPending:(pending:boolean)=>void;textarea:React.RefObject<HTMLTextAreaElement|null>;
}) {
  const t = useT(), input = useRef<HTMLInputElement>(null);
  const [resizedIds,setResizedIds] = useState<Set<string>>(new Set());
  const [pending,setPending] = useState<Pending[]>([]), [error,setError] = useState("");
  const current = useRef(attachments), alive=useRef(true), pendingRef=useRef<Pending[]>([]), changed=useRef(onChange);
  const uploads = useRef(new Map<string, AbortController>());
  useLayoutEffect(()=>{current.current=attachments;changed.current=onChange;},[attachments,onChange]);
  useEffect(()=>{alive.current=true;const active=uploads.current;return ()=>{alive.current=false;for(const upload of active.values()) upload.abort();};},[]);
  function updatePending(next:Pending[]) {pendingRef.current=next;setPending(next);onPending(next.length>0);}
  async function upload(item:Pending) {
    if(uploads.current.has(item.id)) return;
    const controller=new AbortController();uploads.current.set(item.id,controller);
    updatePending(pendingRef.current.map(p=>p.id===item.id?{...p,error:false,progress:0}:p));
    try {
      const data=new FormData();data.set("scope",JSON.stringify({siteId:scope.siteId,versionId:scope.versionId,entry:scope.entry}));data.set("file",item.file);
      const response=await uploadCommentImage(`${endpoint}/attachments`,data,shareToken,controller.signal,percent=>{
        if(alive.current) updatePending(pendingRef.current.map(p=>p.id===item.id?{...p,progress:percent}:p));
      });
      const attachment=commentAttachmentSchema.parse(response.data);
      if(!alive.current || !pendingRef.current.some(p=>p.id===item.id)) return;
      if(response.resized) setResizedIds(previous=>new Set([...previous,attachment.id]));
      const next=[...current.current,attachment];current.current=next;changed.current(next);
      updatePending(pendingRef.current.filter(p=>p.id!==item.id));
    } catch (failure) {
      const code=failure && typeof failure === "object" && "code" in failure ? failure.code : undefined;
      const reason=code === "image_too_large" || code === "image_invalid" ? code : undefined;
      if(alive.current) updatePending(pendingRef.current.map(p=>p.id===item.id?{...p,error:true,reason}:p));
    }
    finally { uploads.current.delete(item.id); }
  }
  function add(files:File[]) {
    if(disabled) return;
    setError("");
    const accepted:Pending[]=[];
    for(const file of files) {
      if(current.current.length+pendingRef.current.length+accepted.length>=4) {setError(t("Attach up to 4 images."));break;}
      if(!["image/png","image/jpeg","image/webp"].includes(file.type)||file.size>5*1024*1024) {setError(t("Use PNG, JPEG or WebP images up to 5 MB."));continue;}
      accepted.push({id:browserRandomId(),file,error:false});
    }
    updatePending([...pendingRef.current,...accepted]);
    for(const item of accepted) void upload(item);
  }
  useEffect(()=>{
    const protect=(event:BeforeUnloadEvent)=>{if(pendingRef.current.length){event.preventDefault();event.returnValue="";}};
    window.addEventListener("beforeunload",protect);
    return ()=>window.removeEventListener("beforeunload",protect);
  },[]);
  const pasteHandler=useRef(add);useEffect(()=>{pasteHandler.current=add;});
  useEffect(()=>{
    const editor=textarea.current;
    const paste=(event:ClipboardEvent)=>{const files=Array.from(event.clipboardData?.files??[]);if(files.length) {event.preventDefault();pasteHandler.current(files);}};
    editor?.addEventListener("paste",paste);
    return ()=>editor?.removeEventListener("paste",paste);
  },[textarea]);
  return <>
    <div className="comment-image-tools">
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden aria-label={t("Attach images")} onChange={event=>{add(Array.from(event.target.files??[]));event.target.value="";}}/>
      <button type="button" disabled={disabled||attachments.length+pending.length>=4} aria-label={t("Attach images")} title={t("Paste a screenshot or attach an image")} onClick={()=>input.current?.click()}><ImagePlus size={16}/><span>{t("Image")}</span></button>
    </div>
    {error&&<p role="alert" className="comment-error">{error}</p>}
    {(attachments.length>0||pending.length>0)&&<div className="comment-upload-list">
      {attachments.map(attachment=><div key={attachment.id} className="comment-upload-item">
        <CommentImage attachment={attachment} endpoint={endpoint} shareToken={shareToken}/>
        {resizedIds.has(attachment.id)&&<small role="status">{t("Resized to fit the image limit")}</small>}
        <button type="button" className="comment-upload-remove" disabled={disabled} aria-label={t("Remove image")} onClick={()=>{const next=current.current.filter(a=>a.id!==attachment.id);current.current=next;onChange(next);void fetch(`${endpoint}/attachments/${encodeURIComponent(attachment.id)}`,{method:"DELETE",headers:shareToken?{"x-artifact-share":shareToken}:{}}).catch(()=>{});}}><X size={14}/></button>
      </div>)}
      {pending.map(item=><div key={item.id} className="comment-upload-pending">
        <span title={item.file.name}>{item.file.name}</span><small role={item.error?"alert":"status"}>{item.error?(item.reason === "image_too_large" ? t("Image is too large. Choose a smaller image.") : item.reason === "image_invalid" ? t("Image could not be decoded. Choose another PNG, JPEG or WebP.") : t("Upload failed")):item.progress===100?t("Processing image…"):t("Uploading {percent}%",{percent:item.progress??0})}</small>
        {!item.error&&<progress max={100} value={item.progress??0} aria-label={t("Image upload progress")}/>}
        {item.error&&<button type="button" onClick={()=>void upload(item)}>{t("Retry")}</button>}<button type="button" aria-label={t("Remove image")} onClick={()=>{uploads.current.get(item.id)?.abort();updatePending(pendingRef.current.filter(p=>p.id!==item.id));}}><X size={14}/></button>
      </div>)}
    </div>}
  </>;
}
