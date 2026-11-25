import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alhan DJ — Dual Deck Audio Studio",
  description: "A browser-based dual-deck DJ mixer with 8D spatial effects.",
  manifest: "/manifest.json",
  icons: {
    icon: "/alhan-app-icon.png",
    apple: "/alhan-app-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#32d6cb",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
