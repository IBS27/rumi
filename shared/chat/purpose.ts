import type { DesignBrief, RoomSnapshot } from "../contracts";

// Purpose is often already present in the room name or in a casual sentence
// ("some furniture for my bedroom"). Keep this small and deterministic so the
// Spec flow cannot ask for information the user just supplied.
const PURPOSE_PATTERNS: { purpose: string; pattern: RegExp }[] = [
  { purpose: "bedroom", pattern: /\b(?:bed\s*room|primary bedroom|master bedroom|guest room)\b/i },
  { purpose: "living room", pattern: /\b(?:living room|family room|lounge)\b/i },
  {
    purpose: "home office",
    pattern:
      /(?:^office$|\bhome office\b|\boffice room\b|\bstudy\b|\b(?:my|our|the|this|an?|your) office\b)/i,
  },
  { purpose: "dining room", pattern: /\b(?:dining room|dining area)\b/i },
  { purpose: "nursery", pattern: /\bnursery\b/i },
  { purpose: "kitchen", pattern: /\bkitchen\b/i },
  { purpose: "bathroom", pattern: /\b(?:bathroom|washroom)\b/i },
];

export function inferPurpose(...sources: (string | null | undefined)[]): string | null {
  for (const source of sources) {
    if (!source) continue;
    const match = PURPOSE_PATTERNS.find(({ pattern }) => pattern.test(source));
    if (match) return match.purpose;
  }
  return null;
}

export function inferBriefPurpose(
  brief: DesignBrief,
  message: string,
  room: RoomSnapshot | null,
): DesignBrief {
  if (brief.purpose.trim()) return brief;
  const purpose = inferPurpose(message, room?.name);
  return purpose ? { ...brief, purpose } : brief;
}
