-- Supabase SQL Editor에서 실행. 기존 주문과 메뉴는 보존한다.
BEGIN;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS served_quantity INTEGER NOT NULL DEFAULT 0;

UPDATE public.order_items
SET served_quantity = quantity
WHERE status = 'served' AND served_quantity <> quantity;

ALTER TABLE public.order_items
  DROP CONSTRAINT IF EXISTS order_items_served_quantity_check;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_served_quantity_check
  CHECK (served_quantity >= 0 AND served_quantity <= quantity);

COMMIT;
