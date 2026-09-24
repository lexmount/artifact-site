import { expect, it } from "vitest";
import sharp from "sharp";
import { prepareCommentImage, MCP_COMMENT_IMAGE_MAX_BYTES } from "@/lib/mcp/comment-image";
it("bounds the model derivative without upscaling or changing the source", async()=>{
 const original=await sharp({create:{width:8192,height:100,channels:4,background:"#ff000080"}}).png().toBuffer();
 const copy=Buffer.from(original);
 const result=await prepareCommentImage(original,"image/png",1568);
 expect(result.image.width).toBe(1568);expect(result.image.height).toBe(19);expect(result.image.resized).toBe(true);
 expect(result.image.byteSize).toBe(result.data.length);expect(original).toEqual(copy);
 expect((await sharp(result.data).metadata()).hasAlpha).toBe(true);
 const tiny=await sharp({create:{width:3,height:2,channels:3,background:"red"}}).jpeg().toBuffer();
 const small=await prepareCommentImage(tiny,"image/jpeg",1568);
 expect(small.image).toMatchObject({width:3,height:2,resized:false});expect(small.data).toEqual(tiny);
});
it("also bounds encoded response bytes for noisy screenshots", async()=>{
 const pixels=Buffer.alloc(1300*1300*3);let seed=1;
 for(let i=0;i<pixels.length;i++){seed=(Math.imul(seed,1664525)+1013904223)|0;pixels[i]=seed>>>24;}
 const bytes=await sharp(pixels,{raw:{width:1300,height:1300,channels:3}}).png().toBuffer();
 const result=await prepareCommentImage(bytes,"image/png",4096);
 expect(result.data.length).toBeLessThanOrEqual(MCP_COMMENT_IMAGE_MAX_BYTES);
 expect(result.image.width).toBeLessThan(1300);expect(result.image.width).toBe(result.image.height);
});
