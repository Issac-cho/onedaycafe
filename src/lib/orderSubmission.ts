import type { Customer } from "./couponPayment";

export type PendingOrder = {
  requestId: string;
  storeId: string;
  tableNumber: string;
  paymentMethod: string;
  customer?: Customer;
  couponUsed?: number;
  cashReceived?: number | null;
  items: { menu_id: string; quantity: number; unit_price: number }[];
};

const storageKey = (storeId: string) => `pending_order_${storeId}`;

export function readPendingOrder(storage: Storage, storeId: string): PendingOrder | null {
  const saved = storage.getItem(storageKey(storeId));
  if (!saved) return null;
  const order = JSON.parse(saved) as PendingOrder;
  if (!order || typeof order.requestId !== "string" || order.storeId !== storeId
      || typeof order.tableNumber !== "string" || typeof order.paymentMethod !== "string"
      || !Array.isArray(order.items) || !order.items.length
      || order.items.some(item => !item || typeof item.menu_id !== "string"
        || !Number.isInteger(item.quantity) || item.quantity <= 0
        || !Number.isInteger(item.unit_price) || item.unit_price < 0)) {
    throw new Error("미확인 주문 데이터를 읽을 수 없습니다. 관리자에게 접수 상태를 확인해 주세요.");
  }
  if (order.customer && (!["외부자", "개척자", "지체 손님"].includes(order.customer.type)
    || typeof order.customer.name !== "string" || typeof order.customer.member !== "string"
    || !Number.isSafeInteger(order.couponUsed) || order.couponUsed! < 0
    || (order.cashReceived !== null && (!Number.isSafeInteger(order.cashReceived) || order.cashReceived! < 0)))) {
    throw new Error("저장된 손님·결제 정보를 확인할 수 없습니다.");
  }
  return order;
}

export function savePendingOrder(storage: Storage, order: PendingOrder) {
  storage.setItem(storageKey(order.storeId), JSON.stringify(order));
}

export function clearPendingOrder(storage: Storage, storeId: string) {
  storage.removeItem(storageKey(storeId));
}

export function orderRpcArgs(order: PendingOrder) {
  return {
    p_request_id: order.requestId,
    p_store_id: order.storeId,
    p_table_number: order.tableNumber,
    p_payment_method: order.paymentMethod,
    p_items: order.items,
    ...(order.customer ? {
      p_customer_type: order.customer.type, p_customer_name: order.customer.name,
      p_member_name: order.customer.member, p_coupon_used: order.couponUsed,
      p_cash_received: order.cashReceived,
    } : {}),
  };
}

// DB가 명시적으로 거절한 경우에만 내용을 수정해 새 요청으로 접수한다.
export function isRejectedOrder(code?: string) {
  return !!code && /^(22|23|42|PGRST)/.test(code);
}
