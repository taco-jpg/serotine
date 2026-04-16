import { PrismaClient } from '@prisma/client'
import { PrismaD1 } from '@prisma/adapter-d1'

const prismaClientSingleton = () => {
  // Check if we are in a Cloudflare environment with D1 binding
  if (typeof process !== 'undefined' && (process.env as any).serotine_db) {
    const adapter = new PrismaD1((process.env as any).serotine_db)
    return new PrismaClient({ adapter })
  }
  // Fallback to standard client for local development/migrations
  return new PrismaClient()
}

declare global {
  var prisma: undefined | ReturnType<typeof prismaClientSingleton>
}

const prisma = globalThis.prisma ?? prismaClientSingleton()

export default prisma

if (process.env.NODE_ENV !== 'production') globalThis.prisma = prisma
