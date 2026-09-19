import { PUBLIC_KEY_PATTERN, ID_PATTERN } from "./protocol"
import { validateProfileMedia, type ProfileMedia } from "./profile-media"

export const PROFILE_FIELDS = ["avatar", "banner", "displayName", "bio", "status", "colors"] as const
export type ProfileField = typeof PROFILE_FIELDS[number]
export const PROFILE_LABELS: Record<ProfileField, string> = { avatar: "Profile picture", banner: "Banner", displayName: "Display name", bio: "About me", status: "Status", colors: "Profile colors" }
export interface ProfileValues { avatar?: ProfileMedia; banner?: ProfileMedia; displayName?: string; bio?: string; status?: string; colors?: { accent: string; background: string } }
export interface ProfileVersion { revision: number; device: string }
export interface ProfileState extends ProfileVersion { values: ProfileValues; valuesVersion: ProfileVersion; grants: Record<string, ProfileField[]>; grantVersions: Record<string, ProfileVersion>; grantConfirmedAt?: Record<string, number> }
export interface ReceivedProfile extends ProfileVersion { values: ProfileValues; receivedAt: number; sentAt?: number }
export type ProfileWire = { version: 1; type: "request"; token: string }
  | ({ version: 1; type: "revoke" } & ProfileVersion)
  | ({ version: 1; type: "data" | "sync"; token: string; transfer: string; index: number; total: number; data: string } & ProfileVersion)
// Renew explicitly before the seven-day relay window can lose a revocation.
export const PROFILE_GRANT_LEASE_MS = 6 * 24 * 60 * 60_000
export function freshProfileGrant(state: ProfileState, peer: string, now = Date.now()) {
  const confirmed = state.grantConfirmedAt?.[peer]
  return typeof confirmed === "number" && Number.isSafeInteger(confirmed) && confirmed > 0 && confirmed <= now + 60000 && now - confirmed < PROFILE_GRANT_LEASE_MS
}
export const PROFILE_CHUNK = 24000
export const PROFILE_MAX_TRANSFER = 800000
export function validProfileFields(value: unknown): value is ProfileField[] { return Array.isArray(value) && value.length <= PROFILE_FIELDS.length && new Set(value).size === value.length && value.every(field => PROFILE_FIELDS.includes(field as ProfileField)) }
export function validProfileValues(value: unknown): value is ProfileValues {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(field => !PROFILE_FIELDS.includes(field as ProfileField))) return false
  const p = value as ProfileValues
  return (p.avatar === undefined || validateProfileMedia(p.avatar)) && (p.banner === undefined || validateProfileMedia(p.banner))
    && (p.displayName === undefined || typeof p.displayName === "string" && p.displayName.length <= 60)
    && (p.bio === undefined || typeof p.bio === "string" && p.bio.length <= 500)
    && (p.status === undefined || typeof p.status === "string" && p.status.length <= 100)
    && (p.colors === undefined || !!p.colors && typeof p.colors === "object" && Object.keys(p.colors).length === 2 && /^#[\da-f]{6}$/i.test(p.colors.accent) && /^#[\da-f]{6}$/i.test(p.colors.background))
}
export function validProfileVersion(value: ProfileVersion) { return Number.isSafeInteger(value.revision) && value.revision > 0 && value.revision <= (Date.now() + 60000) * 1000 && typeof value.device === "string" && ID_PATTERN.test(value.device) }
export function validProfileState(value: unknown): value is ProfileState {
  if (!value || typeof value !== "object") return false
  const p = value as ProfileState
  return (p.grantConfirmedAt === undefined || !!p.grantConfirmedAt && typeof p.grantConfirmedAt === "object" && !Array.isArray(p.grantConfirmedAt) && Object.keys(p.grantConfirmedAt).length <= 100 && Object.entries(p.grantConfirmedAt).every(([pub, timestamp]) => PUBLIC_KEY_PATTERN.test(pub) && Number.isSafeInteger(timestamp) && timestamp > 0)) && validProfileVersion(p) && validProfileVersion(p.valuesVersion ?? {} as ProfileVersion) && !!p.grantVersions && typeof p.grantVersions === "object" && !Array.isArray(p.grantVersions) && Object.keys(p.grantVersions).length <= 100 && Object.entries(p.grantVersions).every(([pub, version]) => PUBLIC_KEY_PATTERN.test(pub) && validProfileVersion(version)) && validProfileValues(p.values) && !!p.grants && typeof p.grants === "object" && !Array.isArray(p.grants) && Object.keys(p.grants).length <= 100 && Object.entries(p.grants).every(([pub, fields]) => PUBLIC_KEY_PATTERN.test(pub) && validProfileFields(fields) && !!p.grantVersions[pub])
}
export function validProfileWire(value: unknown): value is ProfileWire {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const p = value as ProfileWire
  if (p.version !== 1) return false
  if (p.type === "request") return Object.keys(p).length === 3 && ID_PATTERN.test(p.token)
  if (!validProfileVersion(p)) return false
  if (p.type === "revoke") return Object.keys(p).length === 4
  return (p.type === "data" || p.type === "sync") && Object.keys(p).length === 9 && ID_PATTERN.test(p.token) && ID_PATTERN.test(p.transfer)
    && Number.isInteger(p.index) && Number.isInteger(p.total) && p.total > 0 && p.total <= Math.ceil(PROFILE_MAX_TRANSFER / PROFILE_CHUNK)
    && p.index >= 0 && p.index < p.total && typeof p.data === "string" && p.data.length > 0 && p.data.length <= PROFILE_CHUNK
}
export function newerProfile(left: ProfileVersion, right?: ProfileVersion) { return !right || left.revision > right.revision || left.revision === right.revision && left.device > right.device }
export function selectProfileFields(values: ProfileValues, fields: readonly ProfileField[]): ProfileValues {
  const selected: ProfileValues = {}
  for (const field of PROFILE_FIELDS) if (fields.includes(field) && values[field] !== undefined) Object.assign(selected, { [field]: values[field] })
  return selected
}
export const profileStorageKey = (owner: string) => `serotine.profile.v1:${owner}`
export const profileCacheKey = (owner: string) => `serotine.profile-cache.v1:${owner}`
export const emptyProfile = (): ProfileState => ({ revision: 1, device: "00000000-0000-4000-8000-000000000000", values: {}, valuesVersion: { revision: 1, device: "00000000-0000-4000-8000-000000000000" }, grants: {}, grantVersions: {} })
export function loadProfileState(owner: string): ProfileState {
  try { const value = JSON.parse(localStorage.getItem(profileStorageKey(owner)) || "null"); if (validProfileState(value)) return value } catch { /* Storage failure never grants field access. */ }
  return emptyProfile()
}
