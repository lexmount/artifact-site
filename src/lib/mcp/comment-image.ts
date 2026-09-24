import "server-only";
import sharp from "sharp";

export const MCP_COMMENT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** Model-facing derivative only: the authorized stored attachment stays unchanged. */
export async function prepareCommentImage(bytes: Uint8Array, mimeType: "image/png" | "image/jpeg", maxEdge: number) {
  const source = sharp(bytes,{limitInputPixels:16_000_000,failOn:"error"});
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error("Invalid stored comment image");
  let width=metadata.width, height=metadata.height, data=Buffer.from(bytes);
  const encode = async (edge:number) => {
    const image=source.clone().resize({width:edge,height:edge,fit:"inside",withoutEnlargement:true});
    return (mimeType === "image/jpeg" ? image.jpeg({quality:85}) : image.png()).toBuffer({resolveWithObject:true});
  };
  if(Math.max(width,height)>maxEdge) {
    const result=await encode(maxEdge);data=Buffer.from(result.data);width=result.info.width;height=result.info.height;
  }
  for(let attempt=0;data.length>MCP_COMMENT_IMAGE_MAX_BYTES && attempt<3;attempt++) {
    const edge=Math.max(1,Math.floor(Math.max(width,height)*Math.sqrt(MCP_COMMENT_IMAGE_MAX_BYTES/data.length)*0.85));
    const result=await encode(edge);data=Buffer.from(result.data);width=result.info.width;height=result.info.height;
  }
  if(data.length>MCP_COMMENT_IMAGE_MAX_BYTES) throw new Error("Comment image exceeds the response budget");
  return {data,image:{width,height,mimeType,byteSize:data.length,resized:width!==metadata.width||height!==metadata.height}};
}
