import { PrismaClient } from '@prisma/client'
import { PrismaD1 } from '@prisma/adapter-d1'

// Use a proxy or a getter to handle lazy initialization
let _prisma: PrismaClient | null = null

export function getPrisma() {
  if (_prisma) return _prisma

  // Check if we have the D1 binding
  const d1 = (process.env as any).serotine_db

  if (d1) {
    const adapter = new PrismaD1(d1)
    _prisma = new PrismaClient({ adapter })
    return _prisma
  }

  // Local development fallback
  if (process.env.NODE_ENV === 'development') {
    _prisma = new PrismaClient()
    return _prisma
  }

  // Final fallback to prevent worker crash
  console.warn("D1 binding 'serotine_db' not found. Database operations will fail.")
  // We still need to return a client to avoid breaking typings, 
  // but this shouldn't happen if bindings are set correctly.
  _prisma = new PrismaClient() 
  return _prisma
}

const prisma = getPrisma()
export default prisma
