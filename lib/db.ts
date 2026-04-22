// lib/db.ts
import { getRequestContext } from '@cloudflare/next-on-pages'

export function getDB() {
  const { env } = getRequestContext()
  return (env as any).serotine_db as D1Database
}