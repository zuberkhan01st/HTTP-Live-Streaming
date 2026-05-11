import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HLS dashboard",
  description: "Upload videos and play HLS output from the Bun API",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
