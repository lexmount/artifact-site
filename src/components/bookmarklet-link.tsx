"use client";

// The home page's "Publish this page" — a button meant to be DRAGGED AWAY, not clicked.
//
// So it looks like something you can pick up (cursor:grab), and its usage is squeezed into the hover
// hint instead of spread out as a paragraph: whoever needs it understands "drag to the bookmarks bar"
// at a glance, and whoever doesn't should not have to read three more lines for it. The home page
// already has two entry points (the upload area and the AI command); a third one must be quieter
// than the first two.
import { useEffect, useRef, useState } from "react";
import { Bookmark } from "lucide-react";
import { bookmarkletSource, BOOKMARKLET_TARGET_PATH } from "@/lib/bookmarklet";
import { useT } from "@/components/locale-provider";

export default function BookmarkletLink() {
  const t = useT();
  // Lazy initialization rather than setState in an effect: origin is already known on the first
  // client frame. There is no window during SSR, so fall back to "" and fill it in on hydration.
  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const link = useRef<HTMLAnchorElement>(null);

  // React blocks `javascript:` hrefs in JSX (it cannot tell our own code from an injection), so the
  // DOM is written directly through a ref after mount. And it has to be a real href — dragging to
  // the bookmarks bar cannot be replaced by an onClick.
  useEffect(() => {
    if (origin && link.current) link.current.href = bookmarkletSource(origin);
  }, [origin]);

  return (
    <p className="bookmarklet-strip">
      <span>{t("Got a page open in your browser?")}</span>
      <span className="bookmarklet-wrap">
        <a ref={link} className="bookmarklet-drag" href={BOOKMARKLET_TARGET_PATH} draggable>
          <Bookmark size={13} /> {t("Publish this page")}
        </a>
        <span className="bookmarklet-tip" role="tooltip">
          <b>{t("Drag it to your bookmarks bar")}</b>
          {t("Then click it on any page to publish that page as a link — even a local")} <code>file://</code>
          {" "}{t("file, with no trip back to Finder to find it.")}
          <em>{t("It only carries the current document; if the page references images or stylesheets next to it, you are told before publishing.")}</em>
        </span>
      </span>
    </p>
  );
}
