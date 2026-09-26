// A stuck action (for example a box that cannot open) is often retried many
// times in a row, and each attempt used to stack another identical toast until
// the screen filled with copies. Merging repeats into one toast with a count
// keeps the message visible without the wall of duplicates.
export function upsertToast(list, incoming) {
  const existing = (list || []).find((toast) => toast.message === incoming.message && toast.type === incoming.type)
  if (!existing) {
    const toast = { ...incoming, count: 1 }
    return { list: [...(list || []), toast], toast, merged: false }
  }
  const toast = { ...existing, count: (existing.count || 1) + 1, duration: incoming.duration ?? existing.duration }
  return { list: list.map((item) => (item.id === existing.id ? toast : item)), toast, merged: true }
}
