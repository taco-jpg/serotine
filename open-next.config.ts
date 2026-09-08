import { defineCloudflareConfig } from "@opennextjs/cloudflare"

const cloudflareConfig = defineCloudflareConfig()

export default {
  ...cloudflareConfig,
  // The Cloudflare Workers build trigger invokes `npm run build`. Since OpenNext
  // also invokes that script to compile Next.js, give OpenNext an explicit inner
  // command so the outer build can produce `.open-next` without recursing.
  buildCommand: "npm run build:next",
}
