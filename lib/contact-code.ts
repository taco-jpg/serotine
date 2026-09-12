import { validateAddress } from "@/lib/identity"

/** Decode contact data only. An invitation's URL is never opened or fetched. */
export async function parseContactCode(value: string): Promise<string> {
  if (value.length > 2048) throw new Error("This is too long to be a Serotine contact code.")
  let address = value.trim()
  if (/^https?:\/\//i.test(address)) {
    try {
      const invitation = new URL(address)
      const addresses = new URLSearchParams(invitation.hash.slice(1)).getAll("invite")
      if (addresses.length !== 1) throw new Error("Missing or ambiguous invitation")
      address = addresses[0]
    } catch {
      throw new Error("This QR code or link does not contain a Serotine contact address.")
    }
  }
  try { return await validateAddress(address) }
  catch { throw new Error("Use a Serotine contact QR code, full public address, or invite link.") }
}
