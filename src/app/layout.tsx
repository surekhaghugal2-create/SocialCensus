import type { Metadata } from "next";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Social Census — Plan. Schedule. Publish.",
  description:
    "A self-hostable social publishing workspace for planning, approvals, server-side scheduling and configured provider integrations.",
  keywords: [
    "social media management",
    "content scheduling",
    "social media analytics",
    "AI content creation",
    "buffer alternative",
    "Social Census",
  ],
  authors: [{ name: "Social Census" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "Social Census — Plan. Schedule. Publish.",
    description:
      "Plan, review, schedule and publish social content from one collaborative workspace.",
    siteName: "Social Census",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Social Census — Plan. Schedule. Publish.",
    description:
      "Plan, review, schedule and publish social content from one collaborative workspace.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
        >
          {children}
          <Toaster />
          <SonnerToaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
