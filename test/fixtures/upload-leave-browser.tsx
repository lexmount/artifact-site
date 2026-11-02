import Uploader from "../../src/components/uploader";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { useUploadLeaveGuard } from "../../src/components/upload-leave-guard";
import { LocaleProvider } from "../../src/components/locale-provider";
function Fixture() {
  const [active, setActive] = useState(false);
  const guard = useUploadLeaveGuard(active, true);
  return <main style={{ maxWidth: 720, margin: "40px auto", padding: 20 }}>
    <h1>上传作品</h1><a id="navigate" href="/next">我的站点</a>
    <button id="start" className="btn solid" onClick={() => setActive(true)}>开始上传</button>
    <button id="background" className="btn" onClick={() => { guard.release(); setActive(false); }}>后台已接收</button>
    <button id="failed" className="btn" onClick={() => setActive(false)}>上传失败</button>
    {active && <div className="upload-progress"><div className="upload-progress-bar"><span style={{ width: "42%" }} /></div><p>已上传 38 / 90 MB</p></div>}
    {guard.hint}{guard.dialog}
  </main>;
}
if (location.pathname === "/uploader") {
  Object.defineProperty(window, "crypto", { value: undefined });
  window.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/auth/me")) return Response.json({ user: { id: "test" }, uploadLimits: { archiveChunks: 1, packageUploads: 1 } });
    if (url.endsWith("/api/uploads") && init?.method === "POST") { document.body.dataset.newUpload = "true"; return Response.json({ error: "New upload requested" }, { status: 400 }); }
    if (url.includes("/api/uploads/old")) return Response.json({ versionId: "old", status: new URLSearchParams(location.search).get("status") || "queued" });
    return Response.json({ jobs: [] });
  };
}
createRoot(document.getElementById("root")!).render(<LocaleProvider locale="zh-CN">{location.pathname === "/uploader" ? <Uploader compact /> : <Fixture />}</LocaleProvider>);
