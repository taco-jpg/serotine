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
  if (/\b(home|walk|outside|sky)\b/.test(text)) return "Sometimes the long way is the better part of the day."
  const replies = ["A thought doesn’t have to be finished to be shared.", "There’s room for the next thought, too.", "The real conversation starts with someone you know."]
  const index = Number.isFinite(turn) ? Math.abs(Math.trunc(turn)) % replies.length : 0
  return replies[index]
}

const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))
const ease = (n: number) => { const p = clamp(n); return p * p * (3 - 2 * p) }

export function storyProgress(top: number, height: number, viewport: number): number {
  return clamp(-top / Math.max(1, height - viewport))
}

/** Reversible, bounded choreography: gathering → representation → reply. */
export function storyFrame(progress: number) {
  const p = clamp(progress)
  return {
    p,
    gather: ease(p / .42),
    seal: ease((p - .25) / .15) * (1 - ease((p - .54) / .16)),
    arrive: ease((p - .61) / .2),
    leave: ease(p / .5),
  }
}

export function enhanceLanding(root: HTMLElement): () => void {
  const story = root.querySelector<HTMLElement>("[data-story]")
  const stage = root.querySelector<HTMLElement>("[data-stage]")
  const conversation = root.querySelector<HTMLElement>("[data-conversation]")
  const continuation = root.querySelector<HTMLElement>("[data-continuation]")
  const room = root.querySelector<HTMLDetailsElement>("[data-room]")
  const identity = root.querySelector<HTMLDetailsElement>("[data-identity]")
  const form = root.querySelector<HTMLFormElement>("[data-demo-form]")
  const fields = root.querySelector<HTMLFieldSetElement>("[data-demo-fields]")
  const note = root.querySelector<HTMLTextAreaElement>("#demo-note")
  const log = root.querySelector<HTMLElement>("[data-demo-log]")
  const viewport = root.querySelector<HTMLElement>("[data-demo-viewport]")
  const status = root.querySelector<HTMLElement>("[data-demo-status]")
  const reset = root.querySelector<HTMLButtonElement>("[data-demo-reset]")
  const still = root.querySelector<HTMLInputElement>("[data-still]")
  const edge = root.querySelector<HTMLElement>("[data-edge-copy]")
  const echo = root.querySelector<HTMLElement>("[data-echo]")
  const echoCaption = root.querySelector<HTMLElement>("[data-echo-caption]")
  if (!story || !stage || !conversation || !continuation || !room || !identity || !form || !fields || !note || !log || !viewport || !status || !reset || !still || !edge || !echo || !echoCaption) return () => {}

  const events = new AbortController()
  const signal = events.signal
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
  const desktop = window.matchMedia("(min-width: 801px) and (min-height: 700px)")
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)")
  const defaultEcho = echo.textContent || ""
  const defaultEchoCaption = echoCaption.textContent || ""
  let frame = 0, count = 0, disposed = false, keyboard = false
  let storyVisible = true, continuationVisible = true
  let point: { x: number; y: number } | null = null
  let scrollEvents: AbortController | undefined
  const properties = ["--p", "--gather", "--seal", "--arrive", "--leave", "--intro-fade", "--camera-y", "--camera-scale", "--px", "--py"]
  const moving = () => !reduced.matches && !still.checked
  const interacting = () => room.open || identity.open || (keyboard && conversation.contains(document.activeElement))

  function paint() {
    frame = 0
    if (disposed || document.hidden) return
    const active = interacting()
    story!.dataset.interacting = String(active)
    const box = story!.getBoundingClientRect()
    const endBox = continuation!.getBoundingClientRect()
    const p = !moving() || active ? 1 : desktop.matches
      ? storyProgress(box.top, box.height, window.innerHeight)
      : clamp((window.innerHeight * .1 - box.top) / Math.max(1, box.height * .8))
    const state = storyFrame(p)
    const px = point && finePointer.matches && moving() && !active ? clamp(point.x) * 6 - 3 : 0
    const py = point && finePointer.matches && moving() && !active ? clamp(point.y) * 4 - 2 : 0
    const values: Record<string, string | number> = {
      "--p": state.p, "--gather": state.gather, "--seal": state.seal,
      "--arrive": active || !moving() ? 1 : state.arrive, "--leave": state.leave,
      "--intro-fade": moving() && !active ? 1 - state.leave * .72 : 1,
      "--camera-y": `${moving() && !active ? -state.leave * 12 : 0}px`,
      "--camera-scale": moving() && !active ? 1 + state.gather * .18 : 1,
      "--px": `${px}px`, "--py": `${py}px`,
    }
    for (const [key, value] of Object.entries(values)) story!.style.setProperty(key, String(value))
    const caption = active ? "A little room, for you." : p < .25 ? "A thought, on its way." : p < .65 ? "A little distance between." : "And then, a conversation."
    if (edge!.textContent !== caption) edge!.textContent = caption
    const reveal = moving() ? ease((window.innerHeight * .92 - endBox.top) / (window.innerHeight * .6)) : 1
    continuation!.style.setProperty("--reveal", String(reveal))
  }
  function schedule() {
    if (!disposed && !document.hidden && !frame && (storyVisible || continuationVisible)) frame = requestAnimationFrame(paint)
  }
  function setMotion() {
    scrollEvents?.abort(); cancelAnimationFrame(frame); frame = 0; point = null
    story!.dataset.moving = String(moving())
    still!.disabled = reduced.matches
    if (moving()) {
      scrollEvents = new AbortController()
      window.addEventListener("scroll", schedule, { passive: true, signal: scrollEvents.signal })
      window.addEventListener("resize", schedule, { passive: true, signal: scrollEvents.signal })
    }
    // Apply restored scroll position immediately; no timer or continuous RAF.
    paint()
  }
  const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.target === story) storyVisible = entry.isIntersecting
      if (entry.target === continuation) continuationVisible = entry.isIntersecting
    }
    schedule()
  }, { rootMargin: "120px" })
  observer?.observe(story); observer?.observe(continuation)
  reduced.addEventListener("change", setMotion, { signal })
  desktop.addEventListener("change", setMotion, { signal })
  finePointer.addEventListener("change", setMotion, { signal })
  still.addEventListener("change", setMotion, { signal })
  stage.addEventListener("pointermove", event => {
    if (!finePointer.matches || !moving() || interacting() || event.pointerType === "touch") return
    const box = stage.getBoundingClientRect()
    point = { x: (event.clientX - box.left) / Math.max(1, box.width), y: (event.clientY - box.top) / Math.max(1, box.height) }
    schedule()
  }, { passive: true, signal })
  stage.addEventListener("pointerleave", () => { point = null; schedule() }, { signal })
  root.addEventListener("pointerdown", () => { keyboard = false }, { passive: true, signal })
  document.addEventListener("keydown", event => { if (event.key === "Tab") keyboard = true }, { signal })
  conversation.addEventListener("focusin", schedule, { signal })
  conversation.addEventListener("focusout", schedule, { signal })
  identity.addEventListener("toggle", schedule, { signal })
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; point = null }
    else paint()
  }, { signal })
  window.addEventListener("pageshow", paint, { signal })

  function clearRoom(announce = false) {
    count = 0; log!.replaceChildren(); form!.reset()
    status!.textContent = announce ? "A fresh page." : ""
    fields!.disabled = false; viewport!.scrollTop = 0
    echo!.textContent = defaultEcho; echoCaption!.textContent = defaultEchoCaption
  }
  function append(speaker: string, text: string) {
    const message = document.createElement("div")
    message.dataset.demoMessage = speaker === "You" ? "outgoing" : "incoming"
    const author = document.createElement("span"); author.textContent = speaker
    const content = document.createElement("p"); content.textContent = text
    message.append(author, content); log!.append(message)
  }
  function send(event: Event) {
    event.preventDefault()
    if (disposed || !room!.open) return
    const text = note!.value.trim().slice(0, MAX_NOTE_LENGTH)
    if (!text) { status!.textContent = "A word or two is enough."; note!.focus({ preventScroll: true }); return }
    if (count >= MAX_DEMO_NOTES) { status!.textContent = "This little room is full. Start again for a fresh page."; return }
    const nearBottom = viewport!.scrollHeight - viewport!.clientHeight - viewport!.scrollTop < 48
    append("You", text); append("Room · scripted", replyFor(text, count)); count++
    note!.value = ""
    echo!.textContent = text; echoCaption!.textContent = "Your note, still only on this page."
    status!.textContent = count === MAX_DEMO_NOTES ? "This little room is full. Start again for a fresh page." : "Note added. Your words continue further down the page."
    if (nearBottom) viewport!.scrollTop = viewport!.scrollHeight
    note!.focus({ preventScroll: true })
  }
  form.addEventListener("submit", send, { signal })
  note.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); form.requestSubmit() }
    if (event.key === "Escape" && !event.isComposing) { room.open = false; room.querySelector("summary")?.focus({ preventScroll: true }) }
  }, { signal })
  note.addEventListener("input", () => {
    if (count < MAX_DEMO_NOTES) status.textContent = note.value.trim() ? "Draft · only on this page." : ""
  }, { signal })
  reset.addEventListener("click", () => { clearRoom(true); note.focus({ preventScroll: true }) }, { signal })
  room.addEventListener("toggle", () => { if (!room.open) clearRoom(); schedule() }, { signal })
  window.addEventListener("pagehide", () => { clearRoom(); room.open = false; identity.open = false }, { signal })
  fields.disabled = false; root.dataset.enhanced = "true"; setMotion()

  return () => {
    disposed = true
    events.abort(); scrollEvents?.abort(); observer?.disconnect(); cancelAnimationFrame(frame)
    clearRoom(); room.open = false; identity.open = false; fields.disabled = true
    for (const property of properties) story.style.removeProperty(property)
    continuation.style.removeProperty("--reveal")
    delete story.dataset.moving; delete story.dataset.interacting; delete root.dataset.enhanced
    queueMicrotask(() => {
      const color = getComputedStyle(document.documentElement).getPropertyValue("--theme-chrome").trim()
      if (color) document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(meta => { meta.content = color })
    })
  }
}
