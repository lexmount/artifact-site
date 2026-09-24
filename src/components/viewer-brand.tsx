import { ArrowLeft } from "lucide-react";

/** Shared header contents; callers retain their route and unsaved-change navigation guard. */
export default function ViewerBrand() {
  return <>
    <span aria-hidden="true"><ArrowLeft size={15} /></span>
    <picture className="viewer-brand-logo">
      <img src="/brand/logo.png" alt="artifact-site" width={123} height={41} />
    </picture>
  </>;
}
