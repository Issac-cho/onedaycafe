import type { QueueItem } from "./useOrderQueue";

export function groupServingOrders(items: QueueItem[]) {
  const orders = new Map<string, { order: QueueItem["order"]; items: QueueItem[]; allServed: boolean }>();
  for (const item of items) {
    const group = orders.get(item.order.id) ?? { order: item.order, items: [], allServed: true };
    group.items.push(item);
    group.allServed = group.allServed && item.status === "served";
    orders.set(item.order.id, group);
  }
  return [...orders.values()];
}
