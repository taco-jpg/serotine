import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare"

if (process.env.NODE_ENV === "development") {
  await initOpenNextCloudflareForDev()
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
    ] }]
  },
}
export default nextConfig
