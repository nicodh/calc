// How a device comes to share one workbook with the rest of the chat.
//
// The collaborative engine drops a commit that is older than the replica
// applying it: every replica creates its default sheet itself, and a write
// stamped before that sheet's creation is taken for a previous incarnation of
// it. A device that creates its own empty workbook and then receives the
// chat's history would silently lose all of it. So a workbook is never
// created next to one the chat already has. Instead it starts from a peer's
// snapshot, which carries that peer's clock along.
//
// A device opening the app for the first time cannot know whether the chat
// already holds a workbook: webxdc replays the update log but never says when
// it is done. So it creates one and keeps it `provisional` - shown read-only
// and silent - until either a snapshot arrives (and is adopted) or the log has
// stayed quiet long enough (and the device publishes its own).
//
// Two devices can still both end up publishing one, if neither has seen the
// other yet. The earliest-created workbook then wins everywhere. Every diff any
// device sends was written after its own workbook's creation, so after the
// earliest one's, and therefore applies cleanly on top of it. A device whose
// workbook turns out not to be the earliest restores the earlier snapshot and
// replays every diff it has sent or applied since its own base. To be able to
// do that it keeps a journal of them.

export type Phase = "provisional" | "established";

// Which workbook a device's state descends from: when it was created, and by
// which session. Ordered by creation time, then session, the same on every
// device.
export type Base = { createdAt: number; session: number };

const PHASE_KEY = "bootstrap_phase";
const CREATED_KEY = "bootstrap_created";
const BASE_KEY = "bootstrap_base";
const JOURNAL_KEY = "bootstrap_journal";

export function getPhase(): Phase {
  return localStorage.getItem(PHASE_KEY) === "provisional"
    ? "provisional"
    : "established";
}

// Records a workbook created on this device that may still be replaced.
export function markProvisional(createdAt: number) {
  localStorage.setItem(PHASE_KEY, "provisional");
  localStorage.setItem(CREATED_KEY, String(createdAt));
}

// When this device created its own workbook, for publishing it.
export function getCreatedAt(): number {
  return Number(localStorage.getItem(CREATED_KEY)) || Date.now();
}

export function getBase(): Base | null {
  try {
    const base = JSON.parse(localStorage.getItem(BASE_KEY) ?? "null");
    if (base && typeof base.createdAt === "number" && typeof base.session === "number") {
      return base;
    }
  } catch {
    // An unreadable base is treated as unknown.
  }
  return null;
}

// Settles the device on `base`, with an empty journal: nothing has been sent
// or applied on top of it yet. `null` is a base we cannot name (a snapshot
// from a build that did not say), which any named one counts as earlier than.
export function markEstablished(base: Base | null) {
  localStorage.setItem(PHASE_KEY, "established");
  localStorage.setItem(BASE_KEY, JSON.stringify(base));
  localStorage.setItem(JOURNAL_KEY, "[]");
}

// Moves the device onto an earlier `base`, keeping the journal: what was done
// on top of the old base is replayed on top of the new one, and stays needed
// should an even earlier one turn up.
export function rebaseOnto(base: Base) {
  localStorage.setItem(BASE_KEY, JSON.stringify(base));
}

// Whether `a` was created before `b`, by the order every device agrees on.
// An unknown base loses to any known one.
export function isEarlier(a: Base | null, b: Base | null): boolean {
  if (!a) {
    return false;
  }
  if (!b) {
    return true;
  }
  return a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.session < b.session);
}

export function journalEntries(): string[] {
  try {
    const entries = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? "[]");
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

// Appends one diff (base64, as it travels) to the journal. Returns false when
// storage is full: the diff is still applied and sent, but a later rebase
// could not replay it.
export function journalAppend(data: string): boolean {
  const entries = journalEntries();
  entries.push(data);
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries));
    return true;
  } catch (error) {
    console.error("[calc] the diff journal no longer fits into storage", error);
    return false;
  }
}
