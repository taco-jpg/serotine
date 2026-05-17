import { getCloudflareContext } from '@opennextjs/cloudflare'
import type { D1Database } from '@cloudflare/workers-types/experimental'

interface CloudflareEnv {
  serotine_db: D1Database
}

export async function getDB() {
  const { env } = await getCloudflareContext()
  return (env as CloudflareEnv).serotine_db
}