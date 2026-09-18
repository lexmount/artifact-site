"use client";
import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import { useT } from "@/components/locale-provider";
function useLocalCommentToast() {
  const [error,setError]=useState("");
  const [success,setSuccess]=useState("");
  const timer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setNotice=useCallback((message:string)=>{clearTimeout(timer.current);setSuccess("");setError(message);},[]);
  const showSuccess=useCallback((message:string)=>{
    clearTimeout(timer.current);setSuccess(message);
    timer.current=setTimeout(()=>setSuccess(""),3000);
  },[]);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  return {notice:error || success,noticeSuccess:!error && Boolean(success),setNotice,showSuccess};
}
const ToastContext=createContext<ReturnType<typeof useLocalCommentToast>|null>(null);
export function CommentToastProvider({children}:{children:ReactNode}) {
  const value=useLocalCommentToast();
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}
export function useCommentToast() {
  const shared=useContext(ToastContext), local=useLocalCommentToast();
  return shared ?? local;
}
export function CommentToast({notice,noticeSuccess,setNotice}: Pick<ReturnType<typeof useCommentToast>,"notice"|"noticeSuccess"|"setNotice">) {
  const t=useT();
  return notice && typeof document!=="undefined" ? createPortal(
    <div className="comment-workspace comment-notice" data-success={noticeSuccess} role="status">
      {noticeSuccess && <Check size={18} />}{notice}
      <button aria-label={t("Dismiss")} onClick={()=>setNotice("")}><X size={14} /></button>
    </div>,document.body) : null;
}
