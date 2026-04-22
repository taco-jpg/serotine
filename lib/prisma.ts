import { PrismaClient } from '@prisma/client/edge'
import { PrismaD1 } from '@prisma/adapter-d1'
import { getRequestContext } from '@cloudflare/next-on-pages'

export function getPrisma(): PrismaClient {
  if (process.env.NODE_ENV === 'development') {
    return new PrismaClient()
  }
  const { env } = getRequestContext()
  const d1 = (env as any).serotine_db
  if (!d1) {
    throw new Error("D1 binding 'serotine_db' not found in Cloudflare env. Check your wrangler.toml / Pages dashboard.")
  }
  const adapter = new PrismaD1(d1)
  return new PrismaClient({ adapter })
}

export default getPrisma
