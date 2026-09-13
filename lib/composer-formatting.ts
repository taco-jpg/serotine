export interface ComposerSelection { start: number; end: number }
export interface FormattedInsertion extends ComposerSelection { content: string; caret: number }

/** Keep the exact replacement range so mention recipients survive edits elsewhere. */
export function insertFormattedContent(content: string, selection: ComposerSelection, formatted: string, block: boolean, maxLength: number): FormattedInsertion {
  const { start, end } = selection
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > content.length) {
    throw new Error("The message selection changed. Close this editor and try again.")
  }
  const before = content.slice(0, start), after = content.slice(end)
  const leading = block && before && !before.endsWith("\n") ? "\n" : ""
  const trailing = block && !after.startsWith("\n") ? "\n" : ""
  const inserted = leading + formatted + trailing
  const next = before + inserted + after
  if (next.length > maxLength) throw new Error("There is not enough room. Shorten the message or this selection before inserting it.")
  return { content: next, caret: start + inserted.length + (block && after.startsWith("\n") ? 1 : 0), start, end }
}
