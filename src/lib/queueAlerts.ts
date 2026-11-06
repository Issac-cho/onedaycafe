export type AlertItem = { id: string; cooked_quantity?: number; served_quantity?: number };
export type AlertMode = "chef" | "server" | "accounting";

export function createQueueAlertTracker(mode: AlertMode) {
  let initialized = false;
  const seen = new Map<string, number>();
  return (items: AlertItem[]) => {
    let changed = false;
    for (const item of items) {
      const previous = seen.get(item.id);
      const cooked = item.cooked_quantity ?? 0;
      if (initialized && (mode === "server"
        ? cooked > (previous ?? 0) && cooked > (item.served_quantity ?? 0)
        : previous === undefined)) changed = true;
      seen.set(item.id, Math.max(previous ?? 0, cooked));
    }
    initialized = true;
    return changed;
  };
}
