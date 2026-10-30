-- 먼저 20261030_served_quantity.sql을 적용한 뒤 Supabase SQL Editor에서 실행.
BEGIN;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS cooked_quantity INTEGER NOT NULL DEFAULT 0;

UPDATE public.order_items
SET cooked_quantity = CASE WHEN status IN ('cooked', 'served') THEN quantity
                          ELSE GREATEST(cooked_quantity, served_quantity) END;

ALTER TABLE public.order_items
  DROP CONSTRAINT IF EXISTS order_items_cooked_quantity_check;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_cooked_quantity_check
  CHECK (served_quantity <= cooked_quantity AND cooked_quantity <= quantity);

COMMIT;
