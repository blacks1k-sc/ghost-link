import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GHOST-LINK C2",
  description: "Multi-Domain Command & Control Digital Twin",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-black text-white antialiased">{children}</body>
    </html>
  );
}
