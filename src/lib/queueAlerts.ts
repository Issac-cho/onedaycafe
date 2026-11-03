type AlertItem = { id: string; cooked_quantity: number; served_quantity: number };

export function createQueueAlertTracker(mode: "chef" | "server") {
  let initialized = false;
  const seen = new Map<string, number>();
  return (items: AlertItem[]) => {
    let changed = false;
    for (const item of items) {
      const previous = seen.get(item.id);
      if (initialized && (mode === "chef" ? previous === undefined
        : item.cooked_quantity > (previous ?? 0) && item.cooked_quantity > item.served_quantity)) changed = true;
      seen.set(item.id, Math.max(previous ?? 0, item.cooked_quantity));
    }
    initialized = true;
    return changed;
  };
}
