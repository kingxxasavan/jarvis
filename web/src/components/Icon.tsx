// A small stroke icon set, so the HUD needs no icon library.
const PATHS: Record<string, string> = {
  mic: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  send: "M5 12h13M13 6l6 6-6 6",
  stop: "M7 7h10v10H7z",
  speaker: "M4 10v4h4l5 4V6L8 10H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12",
  mute: "M4 10v4h4l5 4V6L8 10H4zM17 9l5 6M22 9l-5 6",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  min: "M6 12h12",
  play: "M8 5l11 7-11 7z",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  code: "M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14",
  terminal: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5",
  folder: "M3 7h7l2 2h9v10H3z",
  tasks: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2",
  brain: "M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3V4zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3V4z",
  gear: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1",
  logout: "M10 5H5v14h5M14 8l4 4-4 4M18 12H9",
  check: "M5 12l5 5 9-10",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  wave: "M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4",
  shield: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z",
  memory: "M6 4h12v16H6zM9 8h6M9 12h6M9 16h4",
  device: "M4 5h16v11H4zM8 20h8M12 16v4",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  youtube: "M3 8.5C3 7 4 6 5.5 5.9 8 5.6 10 5.5 12 5.5s4 .1 6.5.4C20 6 21 7 21 8.5v7c0 1.5-1 2.5-2.5 2.6-2.5.3-4.5.4-6.5.4s-4-.1-6.5-.4C4 18 3 17 3 15.5zM10 9.5v5l4.5-2.5z",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  chat: "M4 5h16v11H9l-5 4z",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
};

export function Icon({ name, size = 16, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name] || PATHS.spark} />
    </svg>
  );
}
