import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Workflows",
  description: "Chat-driven document workflow canvas",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
