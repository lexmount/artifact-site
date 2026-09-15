"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/components/locale-provider";

/** Keeps the existing drop target untouched; all upload sources meet at this confirmation. */
export function useUploadConfirmation() {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const resolve = useRef<((value: boolean | null) => void) | null>(null);
  const [request, setRequest] = useState<{ replacement: boolean; canOfficial: boolean } | null>(null);
  const [official, setOfficial] = useState(false);
  useEffect(() => { if (request) dialog.current?.showModal(); }, [request]);
  useEffect(() => () => { resolve.current?.(null); }, []);
  function finish(value: boolean | null) {
    dialog.current?.close();
    const callback = resolve.current;
    resolve.current = null;
    setRequest(null);
    callback?.(value);
  }
  function confirm(replacement = false, canOfficial = true): Promise<boolean | null> {
    if (resolve.current) return Promise.resolve(null);
    setOfficial(false);
    setRequest({ replacement, canOfficial });
    return new Promise(done => { resolve.current = done; });
  }
  const confirmation = request && (
    <dialog ref={dialog} className="upload-confirmation" onCancel={e => { e.preventDefault(); finish(null); }} aria-labelledby="upload-confirm-title">
      <h2 id="upload-confirm-title">{t(request.replacement ? "Upload new version" : "Confirm upload")}</h2>
      <p>{t(request.replacement ? "A new version will be created. Existing versions stay unchanged." : "Upload these files and create a shareable report.")}</p>
      {request.canOfficial && <label className="official-upload-choice"><input type="checkbox" checked={official} onChange={e => setOfficial(e.target.checked)} />{t("Set as official version after uploading")}</label>}
      {official && <p className="drawer-note">{t("This replaces any previous official designation. Its content is preserved.")}</p>}
      <div className="official-actions"><button type="button" className="btn" onClick={() => finish(null)}>{t("Cancel")}</button><button type="button" className="btn solid" onClick={() => finish(official)}>{t(official ? "Upload and set as official" : "Upload")}</button></div>
    </dialog>
  );
  return { confirmUpload: confirm, uploadConfirmation: confirmation };
}
