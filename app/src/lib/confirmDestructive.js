// A single confirmation for deletes that remove more than the thing you clicked on.
//
// Two rules it exists to enforce:
//   1. State the blast radius in NUMBERS. "and its contents" hides how much is about to go.
//   2. Require the name typed back. A destructive bulk action should cost more than one OK,
//      and typing the name proves you know which container you are on.
//
// Returns true only on an exact (case-insensitive, trimmed) match.
export function confirmDestructive({ name, lines, restorable }) {
  const body = [
    `Delete "${name}" and everything inside it?`,
    '',
    ...lines,
    '',
    restorable
      ? 'Projects go to the Recycle Bin and can be restored for 7 days — they will reappear under "Unassigned".'
      : 'This cannot be undone.',
    '',
    `Type the name to confirm: ${name}`,
  ].join('\n')

  const typed = window.prompt(body)
  if (typed == null) return false
  return typed.trim().toLowerCase() === String(name).trim().toLowerCase()
}
