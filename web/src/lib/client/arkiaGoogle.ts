"use client";
// Connects arkia.buzz for an account that signs in with Google: a throwaway
// Firebase app signs in to arkia in a popup, hands the refresh token to the
// Jarvis server, and is deleted. Nothing is kept in this browser.

export async function arkiaGoogleToken(): Promise<{ refreshToken: string; email: string }> {
  const [{ initializeApp, deleteApp }, auth] = await Promise.all([import("firebase/app"), import("firebase/auth")]);
  const app = initializeApp(
    {
      apiKey: process.env.NEXT_PUBLIC_ARKIA_API_KEY,
      authDomain: process.env.NEXT_PUBLIC_ARKIA_AUTH_DOMAIN,
      projectId: process.env.NEXT_PUBLIC_ARKIA_PROJECT_ID,
    },
    `arkia-connect-${Date.now()}`,
  );
  try {
    const a = auth.getAuth(app);
    await auth.setPersistence(a, auth.inMemoryPersistence);
    const cred = await auth.signInWithPopup(a, new auth.GoogleAuthProvider());
    return { refreshToken: cred.user.refreshToken, email: cred.user.email || "" };
  } catch (err) {
    const code = (err as { code?: string }).code || "";
    if (code.includes("unauthorized-domain")) {
      throw new Error(`Add ${location.hostname} to arkia's Firebase Authentication > Settings > Authorized domains, then try again.`);
    }
    if (code.includes("popup-closed")) throw new Error("The Google window was closed before sign-in finished.");
    if (code.includes("popup-blocked")) throw new Error("The browser blocked the Google window. Allow pop-ups for this site.");
    throw new Error((err as Error).message || "Google sign-in failed.");
  } finally {
    await deleteApp(app).catch(() => undefined);
  }
}
