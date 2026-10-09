// The Supabase project URL is only ever the origin (https://xxxx.supabase.co).
// A pasted REST endpoint such as ".../rest/v1/" would make every auth call hit
// "/rest/v1/auth/v1/..." and fail with "Invalid path specified in request URL".
export function supabaseOrigin(raw: string | undefined): string {
  const value = (raw || "").trim();
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, "");
  }
}
