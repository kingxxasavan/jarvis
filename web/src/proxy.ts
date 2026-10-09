// Every page request passes through here first: the Supabase session is
// refreshed, strangers go to the login page, and a signed-in account that is
// not the owner is signed out. API routes repeat the owner check themselves.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseOrigin } from "./lib/supabase/url";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = supabaseOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return new NextResponse("JARVIS is not configured yet. See web/.env.example.", { status: 503 });

  const sb = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await sb.auth.getUser();
  const path = request.nextUrl.pathname;
  const isLogin = path === "/login";
  const isApi = path.startsWith("/api/");
  const owner = (process.env.OWNER_EMAIL || "").trim().toLowerCase();

  const redirect = (to: string) => {
    const r = NextResponse.redirect(new URL(to, request.url));
    response.cookies.getAll().forEach((c) => r.cookies.set(c));
    return r;
  };

  if (!data.user) {
    if (isLogin) return response;
    return isApi ? NextResponse.json({ error: "Sign in first." }, { status: 401 }) : redirect("/login");
  }
  if ((data.user.email || "").toLowerCase() !== owner) {
    await sb.auth.signOut();
    return isApi ? NextResponse.json({ error: "Not allowed." }, { status: 403 }) : redirect("/login?denied=1");
  }
  const { data: level } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  const needsMfa = level?.nextLevel === "aal2" && level.currentLevel !== "aal2";
  if (needsMfa && !isLogin) {
    return isApi ? NextResponse.json({ error: "Two-factor check required." }, { status: 401 }) : redirect("/login?mfa=1");
  }
  if (isLogin && !needsMfa) return redirect("/");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)"],
};
