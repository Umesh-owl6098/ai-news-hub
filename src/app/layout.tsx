import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { PopstateRefresh } from "@/components/PopstateRefresh";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI News Hub",
  description: "Curated. Summarized. Stay Ahead.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <PopstateRefresh />
        {children}
      </body>
    </html>
  );
}
