"use client";
import { commentRequest } from "./comment-client";
import FollowDiscussion from "@/components/notifications/follow-discussion";
import { Component, memo, useCallback, useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from "react";
import { commentTextParts } from "@/lib/comments/format";
import { CommentHighlight } from "./comment-highlight";
import { CommentBody } from "./comment-body";
import { CommentImages } from "./comment-images";
import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { Check, MapPin, MessageCircle, MoreHorizontal, SmilePlus } from "lucide-react";
import { useT, useLocale } from "@/components/locale-provider";
import type { CommentMessage, CommentThreadDetail } from "@/lib/comments/contracts";
import { COMMENT_EMOJI, type CommentEmoji } from "@/lib/comments/contracts";
import { commentAnchorLabel, commentAnchorSource } from "@/lib/comments/presentation";
import { relTime } from "@/lib/rel-time";
const FullEmojiPicker = dynamic(() => import("./full-emoji-picker"), { ssr: false });

export function CommentAuthor({ message, userId }: { message: CommentMessage; userId?: string }) {
  const t = useT(),
    locale = useLocale();
  const name = message.authorDisplayName || t("Participant");
  const time = relTime(message.createdAt, t, locale);
  return (
    <div className="comment-author">
      <span className="comment-avatar" aria-hidden="true">
        {Array.from(name)[0]}
      </span>
      <b>
        {name}
        {message.authorUserId === userId ? ` ${t("(you)")}` : ""}
      </b>
      <time
        dateTime={new Date(message.createdAt).toISOString()}
        title={new Date(message.createdAt).toLocaleString(locale)}
      >
        {time}
      </time>
      {message.editedAt && <span>{t("Edited")}</span>}
    </div>
  );
}
export const CommentSummary = memo(function CommentSummary({
  detail,
  source,
  userId,
  onChoose,
  unread,
  query,
}: {
  detail: CommentThreadDetail;
  source: string;
  userId?: string;
  unread?: boolean;
  query?: string;
  onChoose: (detail: CommentThreadDetail) => void;
}) {
  const t = useT(),
    first = detail.messages.items[0];
  return (
    <button data-thread-id={detail.thread.id} className="comment-summary" type="button" onClick={() => onChoose(detail)}>
      {first && <CommentAuthor message={first} userId={userId} />}
      {unread && <span className="comment-unread-dot" role="status" aria-label={t("Unread")} />}
      <span className="comment-summary-body">
        <CommentHighlight query={query} text={first?.content.state === "visible" ? (first.content.body ? (first.content.format === "lightweight" ? commentTextParts(first.content.body).map(part=>part.text).join("") : first.content.body) : t("Image attachment")) : t("This comment was deleted.")}/>
      </span>
      {detail.searchMatch && <span className="comment-search-match">{t("Matching comment or reply")} · <CommentHighlight text={detail.searchMatch.excerpt} query={query}/></span>}
      {Boolean(first?.reactions?.length) && <span className="comment-summary-reactions">{first.reactions!.map(reaction=><span key={reaction.emoji} data-selected={reaction.reacted}>{reaction.emoji} {reaction.count}</span>)}</span>}
      {(detail.thread.context.excerpt || detail.thread.anchor.kind === "document") && (
        <span className="comment-summary-quote">{commentAnchorLabel(detail.thread.anchor, detail.thread.context.excerpt, t)}</span>
      )}
      <span className="comment-file-source" title={`${t("View location")} · ${commentAnchorSource(detail.thread.anchor, t)}`}>{commentAnchorSource(detail.thread.anchor, t)}</span>
      <span className="comment-summary-meta">
        {source}
        <span>
          <MessageCircle size={13} />
          {Math.max(0, detail.messages.items.length - 1)}
          {detail.messages.nextCursor ? "+" : ""} {t("Replies")}
        </span>
        {detail.thread.resolution.status === "resolved" && <Check size={14} />}
      </span>
    </button>
  );
});
export function CommentConversation({
  endpoint, shareToken, query,
  detail,
  source,
  userId,
  busy,
  onReply,
  onEdit,
  onDelete,
  onResolve,
  onLocate,
  onMore,
  onReact,
  actions,
  context,
}: {
  detail: CommentThreadDetail;
  source: string;
  endpoint: string;
  query?: string;
  shareToken?: string;
  userId?: string;
  busy: boolean;
  onReply: () => void;
  onEdit: (message: CommentMessage) => void;
  onDelete: (message: CommentMessage) => void;
  onResolve: () => void;
  onLocate: () => void;
  onMore: () => void;
  onReact: (message: CommentMessage, emoji: CommentEmoji, reacted: boolean) => Promise<void>;
  actions?: ReactNode;
  context?: ReactNode;
}) {
  const t = useT(),
    locale = useLocale();
  const locatedNotification = useRef<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const messageId = params.get("message"), notificationId = params.get("notification");
    if (!messageId || !notificationId || locatedNotification.current === notificationId) return;
    const message = detail.messages.items.find(m => m.id === messageId);
    if (!message) { if (detail.messages.nextCursor && !busy) onMore(); return; }
    const node = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!node) return;
    node.scrollIntoView({block:"center",behavior:"instant"});
    if (message.content.state === "deleted") return;
    locatedNotification.current = notificationId;
    void commentRequest("/api/notifications",undefined,{method:"POST",body:JSON.stringify({id:notificationId})}).then(()=>window.dispatchEvent(new Event("artifact:notifications-read"))).catch(()=>{locatedNotification.current=null;});
  },[detail,busy,onMore]);
  return (
    <article className="comment-conversation comment-thread" onKeyDown={event => {
      if (event.key !== "Escape" || !(event.target instanceof Element)) return;
      const menu = event.target.closest("details");
      if (menu?.open) { event.stopPropagation(); menu.open = false; menu.querySelector("summary")?.focus(); }
    }}>
      <div className="comment-conversation-toolbar">
        <span>{source}</span>
        {userId && <FollowDiscussion key={detail.thread.id} endpoint={`${endpoint}/${detail.thread.id}`} shareToken={shareToken}/>}
        <details className="comment-overflow">
          <summary aria-label={t("Discussion actions")}>
            <MoreHorizontal size={18} />
          </summary>
          <div>
            {actions}
            {context}
          </div>
        </details>
      </div>
      {detail.messages.items.map((message) => (
        <div className="comment-message" data-message-id={message.id} key={message.id}>
          <CommentAuthor message={message} userId={userId} />
          <p className={message.content.state === "deleted" ? "comment-deleted" : "comment-body"}>
            {message.content.state === "visible" ? <CommentBody body={message.content.body} mentions={message.content.mentions} format={message.content.format} query={query}/> : t("This comment was deleted.")}
          </p>
          {message.content.state === "visible" && <CommentImages attachments={message.attachments} endpoint={endpoint} shareToken={shareToken}/>}
          {message.content.state === "visible" && <CommentReactions message={message} canReact={detail.permissions.canReply} busy={busy} onReact={onReact} />}
          {message.isRoot && (
            <button className="comment-location" onClick={onLocate} title={`${t("View location")} · ${commentAnchorSource(detail.thread.anchor, t)}`}>
              <MapPin size={14} />
              <span>{commentAnchorLabel(detail.thread.anchor, detail.thread.context.excerpt, t)}<small>{commentAnchorSource(detail.thread.anchor, t)}</small></span>
            </button>
          )}

          {(detail.permissions.messages[message.id]?.canEdit ||
            detail.permissions.messages[message.id]?.canDelete) && (
            <details className="comment-message-menu">
              <summary aria-label={t("Message actions")}>
                <MoreHorizontal size={16} />
              </summary>
              {detail.permissions.messages[message.id]?.canEdit && (
                <button disabled={busy} onClick={() => onEdit(message)}>
                  {t("Edit")}
                </button>
              )}
              {detail.permissions.messages[message.id]?.canDelete && (
                <button disabled={busy} onClick={() => onDelete(message)}>
                  {t("Delete")}
                </button>
              )}
            </details>
          )}
        </div>
      ))}
      {detail.messages.nextCursor && (
        <button className="comment-text-button" onClick={onMore} disabled={busy}>
          {t("Load more replies")}
        </button>
      )}
      {detail.thread.resolution.status === "resolved" && (
        <p className="comment-resolved">
          <Check size={14} />
          {t("Discussion ended by {name}", {
            name: detail.thread.resolution.resolvedByDisplayName || t("Participant"),
          })}{" "}
          · {new Date(detail.thread.resolution.resolvedAt).toLocaleString(locale)}
        </p>
      )}
      <div className="comment-thread-actions">
        {detail.permissions.canReply && (
          <button className="btn sm" disabled={busy} onClick={onReply}>
            {t("Reply")}
          </button>
        )}
        {(detail.thread.resolution.status === "open"
          ? detail.permissions.canResolve
          : detail.permissions.canReopen) && (
          <button className="btn sm ghost" disabled={busy} onClick={onResolve}>
            <Check size={14} />
            {detail.thread.resolution.status === "open" ? t("End discussion") : t("Reopen discussion")}
          </button>
        )}
      </div>
    </article>
  );
}

function CommentReactions({message,canReact,busy,onReact}: {message: CommentMessage; canReact: boolean; busy: boolean; onReact: (message: CommentMessage, emoji: CommentEmoji, reacted: boolean) => Promise<void>}) {
  const t = useT();
  return <div className="comment-reactions" role="group" aria-label={t("Reactions")}>
    {message.reactions?.map(reaction => {
      const emoji = reaction.emoji;
      return <button key={emoji} type="button" disabled={!canReact || busy} aria-label={t("{emoji}: {count} reactions", {emoji, count:reaction.count})} aria-pressed={reaction.reacted} onClick={() => void onReact(message,emoji,!reaction.reacted)}>{emoji} <span>{reaction.count}</span></button>;
    })}
    {canReact && <ReactionPicker message={message} busy={busy} onReact={onReact} />}

  </div>;
}

class PickerBoundary extends Component<{children:ReactNode; fallback:ReactNode}, {failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError() { return {failed:true}; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
function ReactionPicker({message,busy,onReact}: {message:CommentMessage;busy:boolean;onReact:(message:CommentMessage,emoji:CommentEmoji,reacted:boolean)=>Promise<void>}) {
  const t=useT(), id=useId(), menu=useRef<HTMLDivElement>(null), trigger=useRef<HTMLButtonElement>(null);
  const [position,setPosition]=useState({left:0,top:0,maxHeight:400});
  const [open,setOpen]=useState(false), [expanded,setExpanded]=useState(false);
  const close=useCallback((restore=false)=>{setOpen(false);if(restore)trigger.current?.focus();},[]);
  const place=useCallback(()=>{
    const rect=trigger.current?.getBoundingClientRect();
    if(!rect) return;
    const viewport=window.visualViewport;
    const left=viewport?.offsetLeft ?? 0, top=viewport?.offsetTop ?? 0;
    const width=viewport?.width ?? innerWidth, height=viewport?.height ?? innerHeight;
    const box=menu.current?.getBoundingClientRect();
    const menuHeight=Math.min(box?.height || (expanded ? 400 : 50),height-16);
    const next={left:Math.max(left+8,Math.min(left+width-(box?.width || 296)-8,rect.left)),top:Math.max(top+8,Math.min(rect.bottom+6,top+height-menuHeight-8)),maxHeight:Math.max(100,height-16)};
    setPosition(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);
  },[expanded]);
  useLayoutEffect(()=>{if(open)place();},[open,expanded,place]);
  useEffect(()=>{
    if(!open) return;
    const down=(event:PointerEvent)=>{if(event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target))close();};
    const blur=()=>{if(document.hidden || document.activeElement?.tagName==="IFRAME")close();};
    const observer=new ResizeObserver(place);if(menu.current)observer.observe(menu.current);
    document.addEventListener("pointerdown",down,true);
    document.addEventListener("scroll",place,true);
    window.addEventListener("resize",place);window.addEventListener("blur",blur);
    window.visualViewport?.addEventListener("resize",place);window.visualViewport?.addEventListener("scroll",place);
    if(!expanded)menu.current?.querySelector("button")?.focus();
    return ()=>{observer.disconnect();document.removeEventListener("pointerdown",down,true);document.removeEventListener("scroll",place,true);window.removeEventListener("resize",place);window.removeEventListener("blur",blur);window.visualViewport?.removeEventListener("resize",place);window.visualViewport?.removeEventListener("scroll",place);};
  },[open,expanded,place,close]);
  const select=(emoji:string)=>{if(busy)return;close(true);void onReact(message,emoji,!message.reactions?.find(item=>item.emoji===emoji)?.reacted);};
  return <>
    <button ref={trigger} type="button" className="comment-reaction-picker" aria-label={t("Add reaction")} data-tooltip aria-controls={open?id:undefined} aria-expanded={open} aria-haspopup="dialog" aria-disabled={busy} onClick={()=>{if(busy)return;if(open)close(true);else{setExpanded(false);setOpen(true);}}}><SmilePlus size={17} /></button>
    {open && createPortal(<div ref={menu} id={id} role="dialog" aria-label={t("Choose a reaction")} className="comment-emoji-menu" style={position} onKeyDown={event=>{
      if(event.key==="Escape") {event.stopPropagation();event.preventDefault();close(true);}
      if(!expanded && (event.key==="ArrowRight"||event.key==="ArrowLeft")) {event.preventDefault();const buttons=Array.from(menu.current!.querySelectorAll("button"));const at=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(at+(event.key==="ArrowRight"?1:buttons.length-1))%buttons.length]?.focus();}
    }}>
      <div className="comment-emoji-shortcuts">{COMMENT_EMOJI.map(emoji=><button type="button" key={emoji} disabled={busy} aria-label={emoji} aria-pressed={Boolean(message.reactions?.find(item=>item.emoji===emoji)?.reacted)} onClick={()=>select(emoji)}>{emoji}</button>)}<button type="button" aria-label={t("More emoji")} aria-expanded={expanded} onClick={()=>setExpanded(true)}><SmilePlus size={20} /></button></div>
      {expanded && <PickerBoundary fallback={<p role="alert">{t("Could not load emoji. Reload the page, or use a shortcut.")}</p>}><FullEmojiPicker onSelect={select} /></PickerBoundary>}
    </div>,document.body)}
  </>;
}
