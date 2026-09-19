import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare"

if (process.env.NODE_ENV === "development") {
  // Browser smoke suites use an isolated local database with no remote bindings.
  // Production and normal development continue to use the project configuration.
  const testConfig = process.env.SEROTINE_LOCAL_TEST_CONFIG
  await initOpenNextCloudflareForDev(testConfig ? {
    configPath: testConfig,
    remoteBindings: false,
    persist: { path: process.env.SEROTINE_LOCAL_TEST_STATE },
  } : undefined)
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
      { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
    ] }]
  },
}
export default nextConfig
