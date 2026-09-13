import type React from "react"
import type { Metadata, Viewport } from "next"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { MobileViewport } from "@/components/mobile-viewport"

export const metadata: Metadata = {
  title: "Serotine | Secure Communication",
  description: "Private, end-to-end encrypted chats, groups, and file sharing.",
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eeefe7" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0e0b" },
  ],
  colorScheme: "light dark",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh font-sans antialiased">
        <MobileViewport />
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem enableColorScheme disableTransitionOnChange>
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
