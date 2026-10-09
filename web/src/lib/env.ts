// Server configuration, read lazily so a missing value fails the request that
// needs it with a clear message instead of failing the whole build.

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See web/.env.example.`);
  return v;
}

export const env = {
  supabaseUrl: () => need("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseKey: () => need("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
  ownerEmail: () => need("OWNER_EMAIL").trim().toLowerCase(),
  ownerName: () => process.env.OWNER_NAME || "Sir",
  timezone: () => process.env.OWNER_TIMEZONE || "America/New_York",
  nvidiaKey: () => process.env.NVIDIA_API_KEY || "",
  nvidiaModel: () => process.env.NVIDIA_MODEL || "nvidia/nemotron-3-super-120b-a12b",
  embedModel: () => process.env.NVIDIA_EMBED_MODEL || "nvidia/llama-3.2-nv-embedqa-1b-v1",
  ollamaKey: () => process.env.OLLAMA_API_KEY || "",
  ollamaModel: () => process.env.OLLAMA_MODEL || "gpt-oss:120b",
  encryptionKey: () => need("APP_ENCRYPTION_KEY"),
  arkiaApiKey: () => need("NEXT_PUBLIC_ARKIA_API_KEY"),
  arkiaDatabaseUrl: () => need("NEXT_PUBLIC_ARKIA_DATABASE_URL").replace(/\/+$/, ""),
};
