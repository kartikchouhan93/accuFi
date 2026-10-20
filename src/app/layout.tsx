import type { Metadata } from "next"
import { Bricolage_Grotesque, Geist } from "next/font/google"
import { THEME_SCRIPT } from "@/lib/theme"
import "./globals.css"

// Geist for everything you read and every figure: its tabular numerals keep a column of rupees aligned and it carries the
// rupee sign. Bricolage Grotesque only for the wordmark, headings and the net-worth figure, where its width and slightly
// odd letterforms are the personality.
const geist = Geist({ variable: "--font-geist", subsets: ["latin", "latin-ext"] })
const bricolage = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin", "latin-ext"] })

export const metadata: Metadata = {
  title: { default: "AccuFi", template: "%s · AccuFi" },
  description: "A personal ledger for everything you own, owe, earn and spend.",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // The font variables go on <html>, not <body>: --font-sans is declared on :root, and a variable can only be substituted
    // from where it is defined or above. Defined on <body>, the body's own font-family resolved to nothing and fell back to
    // the system stack, so the typeface was never applied to body text.
    <html lang="en" className={`${geist.variable} ${bricolage.variable}`} suppressHydrationWarning>
      <head>
        {/* Applies a saved theme choice before first paint, so dark never flashes light. suppressHydrationWarning above is for
            the attribute this sets, which React did not render. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  )
}
