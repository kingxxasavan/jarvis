import type { Metadata, Viewport } from "next";
import { Exo_2, Inter } from "next/font/google";
import "./globals.css";

const display = Exo_2({ subsets: ["latin"], weight: ["300", "400", "500"], variable: "--font-display" });
const body = Inter({ subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "JARVIS",
  description: "Personal AI assistant",
  robots: { index: false, follow: false },
  other: { google: "notranslate" },
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#03080d",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // translate="no": browser translation rewrites the page's text behind React's back,
    // which crashes the page on the next big update (such as switching tabs).
    <html lang="en" translate="no" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
