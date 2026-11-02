
    import React, {useRef, useState} from "react";
    import {createRoot} from "react-dom/client";
    import {useCommentPreview} from "@/components/comments/use-comment-preview";
    function App() {
      const frameRef = useRef<HTMLIFrameElement>(null);
      const [version, setVersion] = useState("current");
      const packagePaths = version !== "legacy";
      const scope = React.useMemo(() => ({siteId:"site",versionId:version,entry:{kind:"main" as const}}), [version]);
      const bridge = useCommentPreview({frameRef,scope,packagePaths});
      const file = version === "current" ? ".git/report.html" : version === "historical" ? "node_modules/docs/index.html" : "index.html";
      return <><button id="history" onClick={()=>setVersion("historical")}>History</button>
        <button id="legacy" onClick={()=>setVersion("legacy")}>Legacy</button>
        <button id="current" onClick={()=>setVersion("current")}>Current</button>
        <button id="select" onClick={bridge.select}>Select</button>
        <button id="locate" onClick={()=>bridge.selectedAnchor && bridge.locate({threadId:"thread",anchor:bridge.selectedAnchor})}>Locate</button>
        <output id="state">{JSON.stringify({ready:bridge.ready,path:bridge.currentFilePath,anchor:bridge.selectedAnchor,location:bridge.locationResult})}</output>
        <iframe key={version} ref={frameRef} sandbox="allow-scripts" src={"/frame?file="+encodeURIComponent(file)} /></>;
    }
    createRoot(document.getElementById("app")!).render(<App/>);
  