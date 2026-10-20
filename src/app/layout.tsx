import type { Metadata } from "next"
import { Bricolage_Grotesque, IBM_Plex_Sans } from "next/font/google"
import "./globals.css"

// Plex for everything you read and every figure (it has tabular numerals and the rupee sign); Bricolage Grotesque only
// for the wordmark and headings, where its width and slightly odd letterforms are the personality.
const plex = IBM_Plex_Sans({ variable: "--font-plex", subsets: ["latin", "latin-ext"], weight: ["400", "500", "600"] })
const bricolage = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin", "latin-ext"] })

export const metadata: Metadata = {
  title: { default: "AccuFi", template: "%s · AccuFi" },
  description: "A personal ledger for everything you own, owe, earn and spend.",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${plex.variable} ${bricolage.variable} antialiased`}>{children}</body>
    </html>
  )
}
