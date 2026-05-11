import { getCloudflareContext } from '@opennextjs/cloudflare'

interface CloudflareEnv {
  serotine_db: unknown
}

export async function getDB() {
  const { env } = await getCloudflareContext()
  return (env as CloudflareEnv).serotine_db
}