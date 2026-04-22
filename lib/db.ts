import { getCloudflareContext } from '@opennextjs/cloudflare'

export async function getDB() {
  const { env } = await getCloudflareContext()
  return (env as any).serotine_db as D1Database
}