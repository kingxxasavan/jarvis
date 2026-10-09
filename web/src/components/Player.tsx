"use client";
// A floating YouTube window. Videos Jarvis picks were already checked for
// embedding, so they play here; anything else opens on YouTube.
import { useState } from "react";
import type { VideoRef } from "@/lib/ai/events";
import { api } from "@/lib/client/api";
import { Icon } from "./Icon";

type Result = { id: string; title: string; channel: string; duration?: string };

export function Player({ video, onPlay, onClose }: {
  video: VideoRef | null;
  onPlay: (v: VideoRef) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [small, setSmall] = useState(false);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    try {
      const { videos } = await api<{ videos: Result[] }>(`/api/youtube?q=${encodeURIComponent(query.trim())}`);
      setResults(videos);
      if (!videos.length) setError("Nothing found.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const pick = (r: Result) => {
    const v = { id: r.id, title: r.title, channel: r.channel, embeddable: true };
    onPlay(v);
    setResults([]);
    void api("/api/youtube", { method: "POST", json: { played: v } }).catch(() => undefined);
  };

  return (
    <div className={`player ${small ? "small" : ""}`} role="dialog" aria-label="YouTube">
      <div className="player-bar">
        <Icon name="youtube" />
        <span className="grow clip">{video ? video.title : "YouTube"}</span>
        <button className="icon-btn" onClick={() => setSmall(!small)} title={small ? "Expand" : "Shrink"} aria-label="Resize">
          <Icon name="min" />
        </button>
        <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close player">
          <Icon name="close" />
        </button>
      </div>
      {!small && (
        <form className="player-search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
          <Icon name="search" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search YouTube" aria-label="Search YouTube" />
          {searching && <i className="spin" />}
        </form>
      )}
      {results.length > 0 && !small ? (
        <ul className="player-results">
          {results.map((r) => (
            <li key={r.id}>
              <button onClick={() => pick(r)}>
                <img src={`https://i.ytimg.com/vi/${r.id}/mqdefault.jpg`} alt="" loading="lazy" />
                <span className="grow">
                  <span className="clip strong">{r.title}</span>
                  <span className="muted small">{r.channel}{r.duration ? ` · ${r.duration}` : ""}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : video ? (
        video.embeddable ? (
          <div className="frame">
            <iframe
              key={video.id}
              src={`https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0&playsinline=1`}
              title={video.title}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
        ) : (
          <div className="noembed">
            <img src={`https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`} alt="" />
            <p>The owner of this video only allows it on YouTube.</p>
            <a className="btn primary" href={`https://www.youtube.com/watch?v=${video.id}`} target="_blank" rel="noreferrer noopener">
              <Icon name="external" size={14} /> Open on YouTube
            </a>
          </div>
        )
      ) : (
        !small && <p className="empty pad">{error || "Search, or just ask Jarvis to play something."}</p>
      )}
      {error && results.length === 0 && video && <p className="err pad small">{error}</p>}
    </div>
  );
}
