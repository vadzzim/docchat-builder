import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DocChat",
  description: "Turn your company documentation into a useful website chatbot.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
