"use client";

// The hero's eight-second loop (a page passing through a frame), pre-rendered to video by the
// design team. Muted, looping, playing only while visible and only when the person has not asked
// the OS for less motion — then it is the poster. Autoplay refusals fall back to the poster too.
import { useEffect, useRef } from "react";

export default function HeroMotion() {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let inView = true;
    let refused = false;
    const apply = () => {
      if (reduced.matches || refused || document.hidden || !inView) video.pause();
      else video.play().catch(() => { refused = true; });
    };
    const io = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; apply(); }, { threshold: 0.05 });
    io.observe(video);
    reduced.addEventListener("change", apply);
    document.addEventListener("visibilitychange", apply);
    apply();
    return () => { io.disconnect(); reduced.removeEventListener("change", apply); document.removeEventListener("visibilitychange", apply); };
  }, []);
  return (
    <div className="hero-art" aria-hidden="true">
      {/* Purely decorative (the wrapper is aria-hidden), so no accessible name. */}
      <video ref={ref} muted playsInline loop preload="metadata" poster="/brand/hero-motion-poster.jpg">
        <source src="/brand/hero-loop.mp4" type="video/mp4" />
        <source src="/brand/hero-loop.webm" type="video/webm" />
      </video>
    </div>
  );
}
