import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The development badge defaults to the bottom-left corner, which is where the sidebar's Sign out button sits, so under
  // `next dev` it covers the button and swallows the click. It has no business on top of the app's own navigation.
  devIndicators: { position: "bottom-right" },
}

export default nextConfig
