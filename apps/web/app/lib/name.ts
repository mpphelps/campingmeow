export type SplitName = { firstName: string; lastName: string | null };

export function splitName(name: string): SplitName {
  const trimmed = name.trim();
  if (!trimmed) return { firstName: "Unknown", lastName: null };
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) return { firstName: trimmed, lastName: null };
  return {
    firstName: trimmed.substring(0, firstSpace),
    lastName: trimmed.substring(firstSpace + 1).trim() || null,
  };
}

