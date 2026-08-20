"use client";

import { useEffect, useRef } from "react";
import { AccessCodeDialog } from "@/components/access-code-dialog";
import styles from "./velora-hero.module.css";

const VIDEO_SOURCE =
  "https://cdn.sceneai.art/Hero%20section%20video%20file%20(2)/37091057-3719-4207-815c-745ebf57aeb4.mp4";

export function VeloraHero() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const resume = () => {
      void video.play().catch(() => undefined);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") resume();
    };
    const events = ["pause", "ended", "loadedmetadata", "canplay"] as const;
    const interval = window.setInterval(() => {
      if (video.paused) resume();
    }, 1000);

    events.forEach((event) => video.addEventListener(event, resume));
    document.addEventListener("visibilitychange", onVisibilityChange);
    resume();

    return () => {
      window.clearInterval(interval);
      events.forEach((event) => video.removeEventListener(event, resume));
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return (
    <section id="hero" className={styles.hero} aria-label="Velora luxury car rental">
      <video
        ref={videoRef}
        className={styles.backgroundVideo}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
      >
        <source src={VIDEO_SOURCE} type="video/mp4" />
      </video>
      <div className={styles.overlay} aria-hidden="true" />

      <header className={styles.navbar}>
        <a className={styles.wordmark} href="#hero" aria-label="Exotic Vest home">
          Exotic <span>Vest</span>
        </a>

        <AccessCodeDialog className={styles.navButton}>
          <span>Browse cars</span>
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
        </AccessCodeDialog>
      </header>

      <div className={styles.heroCopy}>
        <h1>Make Every Exotic Car Decision Count</h1>
        <p>
          Exotic Vest turns real auction data into clear valuations, market signals, and smarter collector-car decisions.
        </p>
        <AccessCodeDialog className={styles.discoverButton}>
          <span>DISCOVER NOW</span>
          <span className={styles.arrow} aria-hidden="true">
            ↗
          </span>
        </AccessCodeDialog>
      </div>
    </section>
  );
}
