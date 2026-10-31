\encoding UTF8
\set ON_ERROR_STOP on
\ir ../migrations/20261031_kitchen_history.sql
BEGIN;
ALTER TABLE public.order_items DISABLE TRIGGER record_cooking_completion;
INSERT INTO public.order_items(id,order_id,menu_id,quantity,cooked_quantity,served_quantity,status)
SELECT '00000000-0000-0000-0000-000000000201',id,'00000000-0000-0000-0000-000000000003',2,2,0,'cooked'
FROM public.orders WHERE store_id='00000000-0000-0000-0000-000000000002' LIMIT 1;
ALTER TABLE public.order_items ENABLE TRIGGER record_cooking_completion;
INSERT INTO public.order_items(id,order_id,menu_id,quantity)
SELECT '00000000-0000-0000-0000-000000000202',id,'00000000-0000-0000-0000-000000000003',2
FROM public.orders WHERE store_id='00000000-0000-0000-0000-000000000002' LIMIT 1;
SET ROLE anon;
DO $$
DECLARE completed timestamptz;
BEGIN
  UPDATE public.order_items SET cooked_quantity=1 WHERE id='00000000-0000-0000-0000-000000000202';
  ASSERT (SELECT cooked_at IS NULL FROM public.order_items WHERE id='00000000-0000-0000-0000-000000000202');
  UPDATE public.order_items SET cooked_quantity=2,status='cooked' WHERE id='00000000-0000-0000-0000-000000000202';
  SELECT cooked_at INTO completed FROM public.order_items WHERE id='00000000-0000-0000-0000-000000000202';
  ASSERT completed IS NOT NULL;
  UPDATE public.order_items SET served_quantity=2,status='served',cooked_at='2000-01-01' WHERE id='00000000-0000-0000-0000-000000000202';
  ASSERT (SELECT cooked_at=completed FROM public.order_items WHERE id='00000000-0000-0000-0000-000000000202');
  UPDATE public.order_items SET served_quantity=2,status='served' WHERE id='00000000-0000-0000-0000-000000000201';
  ASSERT (SELECT cooked_at IS NULL FROM public.order_items WHERE id='00000000-0000-0000-0000-000000000201'), '과거 완료 시각 추측 금지';
END; $$;
RESET ROLE;
ROLLBACK;
