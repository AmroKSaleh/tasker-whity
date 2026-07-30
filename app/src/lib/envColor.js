// Environment badge colors. A user can pick a color per Environment (stored on
// environments.color); when unset we derive a stable hue from the id so every Environment is
// visually distinct without configuration. Shared by the Today badge, the switcher, and the
// Environments management page so they never disagree.
export const ENV_COLORS = [
  '#4B57D8', '#0E7C66', '#B4530A', '#8B2FB8',
  '#1F6FB2', '#A61B4A', '#2A9D8F', '#5B21B6',
]

export function envColorFor(id) {
  if (!id) return ENV_COLORS[0]
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return ENV_COLORS[h % ENV_COLORS.length]
}

// Resolve the color to render for an environment: the stored color wins, else the derived one.
export function envColor(env) {
  return env?.color || envColorFor(env?.id ?? '')
}
