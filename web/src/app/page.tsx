import { Hud } from "@/components/Hud";
import { env } from "@/lib/env.ts";

// The proxy has already confirmed the owner is signed in.
export const dynamic = "force-dynamic";

export default function Home() {
  const initial = (process.env.OWNER_NAME || env.ownerEmail()).trim().charAt(0).toUpperCase() || "J";
  return <Hud initial={initial} />;
}
