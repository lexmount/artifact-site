/** XHR exposes transfer progress; 100% means server processing, not completion. */
export function uploadCommentImage(url: string, data: FormData, token: string | undefined, signal: AbortSignal, progress: (percent: number) => void): Promise<{data:unknown;resized:boolean}> {
  return new Promise((resolve,reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => {xhr.abort();reject(new DOMException("Upload cancelled","AbortError"));};
    const cleanup = () => signal.removeEventListener("abort",abort);
    if (signal.aborted) {abort();return;}
    xhr.open("POST",url);
    if(token) xhr.setRequestHeader("x-artifact-share",token);
    xhr.timeout=300_000;
    xhr.upload.onprogress=event=>{if(event.lengthComputable) progress(Math.min(100,Math.round(event.loaded/event.total*100)));};
    xhr.onload=()=>{
      cleanup();
      let body:unknown;
      try {body=JSON.parse(xhr.responseText);} catch {reject(new Error("Invalid upload response"));return;}
      if(xhr.status<200||xhr.status>=300) {reject(Object.assign(new Error("Upload failed"),{code:body && typeof body === "object" && "code" in body ? body.code : undefined}));return;}
      resolve({data:body,resized:xhr.getResponseHeader("x-artifact-image-resized")==="true"});
    };
    xhr.onerror=xhr.ontimeout=()=>{cleanup();reject(new Error("Upload failed"));};
    xhr.onabort=()=>{cleanup();reject(new DOMException("Upload cancelled","AbortError"));};
    signal.addEventListener("abort",abort,{once:true});
    xhr.send(data);
  });
}
