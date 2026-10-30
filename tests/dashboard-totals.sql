\encoding UTF8
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.stores (id, name, owner_id) VALUES
('00000000-0000-0000-0000-000000000010', '통계 테스트', '00000000-0000-0000-0000-000000000001');
INSERT INTO public.menus (id, store_id, name, price, category, kitchen_group, is_deleted) VALUES
('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000010', '삭제 메뉴', 500, '음료', 1, true);
INSERT INTO public.orders (store_id, table_number, payment_method)
SELECT '00000000-0000-0000-0000-000000000010'::uuid, n::text, '현금' FROM generate_series(1, 1205) n;
INSERT INTO public.order_items (order_id, menu_id, menu_name, menu_price, quantity, cooked_quantity, served_quantity)
SELECT o.id, '00000000-0000-0000-0000-000000000011'::uuid, '삭제 메뉴',
  CASE WHEN n = 1 THEN 500 ELSE NULL END, 2, 1, 0
FROM public.orders o CROSS JOIN generate_series(1, 2) n
WHERE o.store_id = '00000000-0000-0000-0000-000000000010';
-- 상세가 없는 예전 주문도 주문 건수에는 포함해야 한다.
INSERT INTO public.orders (store_id, table_number, payment_method)
VALUES ('00000000-0000-0000-0000-000000000010', '빈 주문', '현금');
\ir ../migrations/20261030_dashboard_totals.sql
SET ROLE anon;
DO $$
DECLARE totals JSONB;
BEGIN
  totals := public.get_dashboard_totals('00000000-0000-0000-0000-000000000010');
  ASSERT (totals->>'totalOrders')::integer = 1206, '1000건 초과 주문 누락';
  ASSERT (totals->>'totalRevenue')::bigint = 2410000, '매출 합계 누락';
  ASSERT (totals->>'pendingItems')::integer = 2410, '조리 대기 수량 오류';
  ASSERT (totals->>'cookedItems')::integer = 2410, '서빙 대기 수량 오류';
  totals := public.get_dashboard_totals('00000000-0000-0000-0000-000000000099');
  ASSERT totals = '{"totalRevenue":0,"totalOrders":0,"pendingItems":0,"cookedItems":0}'::jsonb, '빈 매장의 통계가 0이 아님';
  totals := public.get_dashboard_totals('00000000-0000-0000-0000-000000000002');
  ASSERT (totals->>'totalOrders')::integer = 1, '다른 매장의 주문이 섞임';
END;
$$;
RESET ROLE;
ROLLBACK;
