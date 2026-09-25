import { apiFetch } from "../native/shared/transport"
import type { Identity } from "./identity"
import { createRequestProof } from "./request-auth"
import { isSummaryMessages, SUMMARY_ACTION, SUMMARY_MAX_OUTPUT, SUMMARY_TIMEOUT_MS, type SummaryMessage } from "./ai-summary"

/** Call only after showing and confirming this exact messages snapshot. There
 * is one attempt: cancellations, timeouts and failures never trigger a retry. */
export async function requestAiSummary(identity: Identity, messages: readonly SummaryMessage[], signal?: AbortSignal, isAllowed: () => boolean = () => true): Promise<string> {
  if (!isSummaryMessages(messages)) throw new Error("There is no valid ordinary text to summarize. Review the preview again.")
  const data = { messages: messages.map(message => ({ speaker: message.speaker, text: message.text })) }
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  if (signal?.aborted) cancel()
  signal?.addEventListener("abort", cancel, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, SUMMARY_TIMEOUT_MS + 5_000)
  try {
    controller.signal.throwIfAborted()
    if (!isAllowed()) throw new Error("AI summary access changed. Review the plugin settings and preview again.")
    const proof = await createRequestProof(SUMMARY_ACTION, data, identity.privateKey, identity.publicKey)
    controller.signal.throwIfAborted()
    // Signing is asynchronous. Re-read consent/scope immediately before the
    // network export so a disable or identity switch cannot race that await.
    if (!isAllowed()) throw new Error("AI summary access changed. Review the plugin settings and preview again.")
    const response = await apiFetch("/api/plugins/summary", { method: "POST", credentials: "same-origin", cache: "no-store",
      redirect: "error", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ version: 1, action: SUMMARY_ACTION, data, proof }) }, () => {
        if (!isAllowed()) throw new Error("AI summary access changed. Review the plugin settings and preview again.")
      })
    const value: unknown = await response.json()
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI summary returned an invalid response. Your conversation is unchanged.")
    const result = value as Record<string, unknown>
    if (!response.ok || result.success !== true) {
      // Only our bounded first-party error messages are displayed. Provider
      // exceptions and request content are never reflected by the endpoint.
      throw new Error(typeof result.error === "string" && result.error.length <= 500 ? result.error : "AI summary is unavailable. Try again later.")
    }
    if (typeof result.summary !== "string" || !result.summary.trim() || result.summary.length > SUMMARY_MAX_OUTPUT) {
      throw new Error("AI summary returned an invalid response. Your conversation is unchanged.")
    }
    controller.signal.throwIfAborted()
    return result.summary
  } catch (error) {
    if (timedOut) throw new Error("AI summary took too long. You can try again later.", { cause: error })
    if (signal?.aborted) throw new DOMException("AI summary was cancelled.", "AbortError")
    if (error instanceof TypeError) throw new Error("AI summary could not connect. Check your connection and try again.", { cause: error })
    throw error
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel) }
}
