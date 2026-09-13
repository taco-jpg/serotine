/** Landing-only enhancement. No identity, relay, storage, analytics, or crypto imports. */
export const MAX_DEMO_NOTES = 8
export const MAX_NOTE_LENGTH = 280

export function replyFor(note: string, turn: number): string {
  const text = note.trim().toLowerCase()
  if (/\b(hello|hi|hey)\b/.test(text)) return "Hello. There’s no rush here."
  if (/\b(thanks|thank you)\b/.test(text)) return "A small exchange. Sometimes that’s enough."
  if (/\b(ai|bot|human|real|person)\b/.test(text)) return "Just a few written replies. No person or AI on the other side of this demo."
  if (/\b(private|privacy|encrypt|encryption|safe)\b/.test(text)) return "This room stays in this page. It isn’t an encryption test; the notes below explain the real app’s limits."
  if (/\b(help|commands)\b/.test(text)) return "Try hello, a thought about your day, or 1976. “Start again” clears this room."
  if (/\b1976\b/.test(text)) return "A small nod to New Directions in Cryptography. There’s a reference in the page’s margin note."
  if (/\b(home|walk|outside)\b/.test(text)) return "Sometimes the long way is the better part of the day."
  const replies = ["A thought doesn’t have to be finished to be shared.", "There’s room for the next thought, too.", "The real conversation starts with someone you know."]
  return replies[Math.abs(Math.trunc(turn)) % replies.length]
}

export function storyProgress(top: number, height: number, viewport: number): number {
  return Math.max(0, Math.min(1, -top / Math.max(1, height - viewport)))
}

export function enhanceLanding(root: HTMLElement): () => void {
  const story = root.querySelector<HTMLElement>("[data-story]")
  const room = root.querySelector<HTMLDetailsElement>("[data-room]")
  const form = root.querySelector<HTMLFormElement>("[data-demo-form]")
  const fields = root.querySelector<HTMLFieldSetElement>("[data-demo-fields]")
  const note = root.querySelector<HTMLTextAreaElement>("#demo-note")
  const log = root.querySelector<HTMLElement>("[data-demo-log]")
  const viewport = root.querySelector<HTMLElement>("[data-demo-viewport]")
  const status = root.querySelector<HTMLElement>("[data-demo-status]")
  const reset = root.querySelector<HTMLButtonElement>("[data-demo-reset]")
  const still = root.querySelector<HTMLInputElement>("[data-still]")
  if (!story || !room || !form || !fields || !note || !log || !viewport || !status || !reset || !still) return () => {}

  const events = new AbortController()
  const signal = events.signal
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
  const compact = window.matchMedia("(max-width: 640px), (max-height: 520px)")
  let frame = 0, visible = true, count = 0, disposed = false
  let scrollEvents: AbortController | undefined
  const properties = ["--approach", "--rise", "--sealed", "--plain", "--context", "--reply", "--departure", "--between", "--arrival"]
  const clamp = (n: number) => Math.max(0, Math.min(1, n))

  function paint() {
    frame = 0
    if (disposed) return
    const box = story!.getBoundingClientRect()
    const p = compact.matches
      ? clamp((window.innerHeight * .9 - (box.top + box.height * .5)) / (window.innerHeight * .8))
      : storyProgress(box.top, box.height, window.innerHeight)
    const sealed = clamp((p - .16) / .16) * (1 - clamp((p - .48) / .16))
    const values: Record<string, number | string> = {
      "--approach": compact.matches ? 1 : .9 + .1 * clamp(p / .7),
      "--rise": compact.matches ? "0px" : `${18 * (1 - clamp(p / .7))}px`,
      "--sealed": sealed, "--plain": 1 - sealed,
      "--context": compact.matches ? 1 : clamp((p - .48) / .24),
      "--reply": compact.matches ? clamp((p - .5) / .18) : clamp((p - .69) / .15),
      "--departure": 1 - clamp(p / .22), "--between": sealed,
      "--arrival": clamp((p - .65) / .15),
    }
    for (const [key, value] of Object.entries(values)) story!.style.setProperty(key, String(value))
  }
  function schedule() {
    if (!disposed && visible && !frame) frame = requestAnimationFrame(paint)
  }
  function setMotion() {
    scrollEvents?.abort()
    cancelAnimationFrame(frame); frame = 0
    // Narrow/short viewports receive a shorter, unpinned composition, not a
    // shrunken desktop camera. Their message changes in normal document flow.
    // Reduced motion always gets the complete scene.
    const moving = !reduced.matches && !still!.checked
    story!.dataset.moving = String(moving)
    still!.disabled = reduced.matches
    if (!moving) {
      for (const property of properties) story!.style.removeProperty(property)
      return
    }
    scrollEvents = new AbortController()
    window.addEventListener("scroll", schedule, { passive: true, signal: scrollEvents.signal })
    window.addEventListener("resize", schedule, { passive: true, signal: scrollEvents.signal })
    // Initial / restored scroll position must not wait for another scroll event.
    paint()
  }
  const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
    visible = entries[0]?.isIntersecting ?? true
    if (visible && story!.dataset.moving === "true") schedule()
  }, { rootMargin: "100px" })
  observer?.observe(story)
  reduced.addEventListener("change", setMotion, { signal })
  compact.addEventListener("change", setMotion, { signal })
  still.addEventListener("change", setMotion, { signal })
  setMotion()

  function clearRoom(announce = false) {
    count = 0
    log!.replaceChildren()
    form!.reset()
    status!.textContent = announce ? "A fresh page." : ""
    fields!.disabled = false
    viewport!.scrollTop = 0
  }
  function append(speaker: string, text: string) {
    const message = document.createElement("div")
    message.dataset.demoMessage = speaker === "You" ? "outgoing" : "incoming"
    const author = document.createElement("span")
    author.textContent = speaker
    const content = document.createElement("p")
    content.textContent = text // Never interpret visitor input as HTML or Markdown.
    message.append(author, content)
    log!.append(message)
  }
  function send(event: Event) {
    event.preventDefault()
    if (disposed || !room!.open) return
    const text = note!.value.trim().slice(0, MAX_NOTE_LENGTH)
    if (!text) { status!.textContent = "A word or two is enough."; note!.focus({ preventScroll: true }); return }
    if (count >= MAX_DEMO_NOTES) { status!.textContent = "This little room is full. Start again for a fresh page."; return }
    const nearBottom = viewport!.scrollHeight - viewport!.clientHeight - viewport!.scrollTop < 48
    append("You", text)
    append("Room · scripted", replyFor(text, count))
    count += 1
    note!.value = ""
    status!.textContent = count === MAX_DEMO_NOTES ? "This little room is full. Start again for a fresh page." : ""
    if (nearBottom) viewport!.scrollTop = viewport!.scrollHeight
    note!.focus({ preventScroll: true })
  }
  form.addEventListener("submit", send, { signal })
  note.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); form.requestSubmit()
    }
  }, { signal })
  reset.addEventListener("click", () => { clearRoom(true); note.focus({ preventScroll: true }) }, { signal })
  room.addEventListener("toggle", () => { if (!room.open) clearRoom() }, { signal })
  window.addEventListener("pagehide", () => { clearRoom(); room.open = false }, { signal })
  fields.disabled = false
  root.dataset.enhanced = "true"

  return () => {
    disposed = true
    events.abort(); scrollEvents?.abort(); observer?.disconnect(); cancelAnimationFrame(frame)
    clearRoom(); room.open = false; fields.disabled = true
    for (const property of properties) story.style.removeProperty(property)
    delete story.dataset.moving
    delete root.dataset.enhanced
    // A client-side route change does not change the html class. Let the
    // existing provider's browser-chrome color resume after this route leaves.
    queueMicrotask(() => {
      const color = getComputedStyle(document.documentElement).getPropertyValue("--theme-chrome").trim()
      if (color) document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(meta => { meta.content = color })
    })
  }
}
