import { afterEach, expect, it, vi } from "vitest";
import { uploadCommentImage } from "@/lib/comments/upload-image";
class FakeXHR {
  static instance:FakeXHR;
  upload = {onprogress: undefined as unknown as (e:{lengthComputable:boolean;loaded:number;total:number})=>void};
  onload=()=>{};onerror=()=>{};ontimeout=()=>{};onabort=()=>{};
  responseText='{"id":"image"}';status=201;timeout=0;
  open=vi.fn();send=vi.fn();setRequestHeader=vi.fn();getResponseHeader=vi.fn(()=>"true");
  abort=vi.fn(()=>this.onabort());
  constructor(){FakeXHR.instance=this;}
}
afterEach(()=>vi.unstubAllGlobals());
it("reports transfer progress separately from completion and preserves resize status",async()=>{
 vi.stubGlobal("XMLHttpRequest",FakeXHR);
 const progress=vi.fn(),controller=new AbortController();
 const pending=uploadCommentImage("/images",new FormData(),"share",controller.signal,progress);
 expect(FakeXHR.instance.timeout).toBe(300_000);
 expect(FakeXHR.instance.setRequestHeader).toHaveBeenCalledWith("x-artifact-share","share");
 FakeXHR.instance.upload.onprogress({lengthComputable:true,loaded:5,total:10});expect(progress).toHaveBeenLastCalledWith(50);
 FakeXHR.instance.upload.onprogress({lengthComputable:true,loaded:10,total:10});expect(progress).toHaveBeenLastCalledWith(100);
 FakeXHR.instance.onload();await expect(pending).resolves.toEqual({data:{id:"image"},resized:true});
 controller.abort();expect(FakeXHR.instance.abort).not.toHaveBeenCalled();
});
it("cancels uploads and reports server errors without accepting an invalid response",async()=>{
 vi.stubGlobal("XMLHttpRequest",FakeXHR);
 const controller=new AbortController();
 const pending=uploadCommentImage("/images",new FormData(),undefined,controller.signal,()=>{});
 controller.abort();await expect(pending).rejects.toMatchObject({name:"AbortError"});
 const retry=uploadCommentImage("/images",new FormData(),undefined,new AbortController().signal,()=>{});
 FakeXHR.instance.status=413;FakeXHR.instance.responseText='{"code":"image_too_large"}';FakeXHR.instance.onload();
 await expect(retry).rejects.toMatchObject({code:"image_too_large"});
});
