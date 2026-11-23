import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alhan DJ — Dual Deck Audio Studio",
  description: "A browser-based dual-deck DJ mixer with 8D spatial effects.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
