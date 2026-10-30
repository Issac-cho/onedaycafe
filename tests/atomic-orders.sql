\encoding UTF8
\set ON_ERROR_STOP on
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql AS 'SELECT NULL::uuid';
\ir ../database_schema.sql
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.stores, public.menus, public.orders, public.order_items TO anon, authenticated;
GRANT INSERT, UPDATE ON public.orders, public.order_items TO anon, authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001');
INSERT INTO public.stores (id, name, owner_id) VALUES
('00000000-0000-0000-0000-000000000002', 'test', '00000000-0000-0000-0000-000000000001');
INSERT INTO public.menus (id, store_id, name, price, category, kitchen_group) VALUES
('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', '커피', 3000, '음료', 1);

SET ROLE anon;
DO $$
DECLARE
  first_order JSONB;
  retry_order JSONB;
  order_count INTEGER;
  payload JSONB := '[{"menu_id":"00000000-0000-0000-0000-000000000003","quantity":2,"unit_price":3000}]';
BEGIN
  first_order := public.submit_order('00000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000002', '3번', '현금', payload);
  retry_order := public.submit_order('00000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000002', '3번', '현금', payload);
  ASSERT first_order = retry_order, '재시도 시 주문이 달라짐';
  SELECT count(*) INTO order_count FROM public.orders;
  ASSERT order_count = 1, '중복 주문 생성';
  ASSERT (SELECT count(*) FROM public.order_items) = 1, '주문 상세 중복';
  ASSERT (SELECT menu_price = 3000 AND quantity = 2 AND served_quantity = 0
    AND cooked_quantity = 0 FROM public.order_items LIMIT 1), '주문 스냅샷 오류';

  BEGIN
    PERFORM public.submit_order('00000000-0000-0000-0000-000000000004',
      '00000000-0000-0000-0000-000000000002', '다른 테이블', '현금', payload);
    RAISE EXCEPTION '변경된 요청을 수락함';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- 첫 메뉴를 저장한 뒤 두 번째 메뉴가 실패해도 주문과 상세가 모두 롤백되어야 한다.
  BEGIN
    PERFORM public.submit_order('00000000-0000-0000-0000-000000000005',
      '00000000-0000-0000-0000-000000000002', '4번', '현금', payload ||
      '[{"menu_id":"00000000-0000-0000-0000-000000000099","quantity":1,"unit_price":3000}]'::jsonb);
    RAISE EXCEPTION '존재하지 않는 메뉴를 수락함';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  ASSERT (SELECT count(*) FROM public.orders) = 1, '실패 후 빈 주문이 남음';
  ASSERT (SELECT count(*) FROM public.order_items) = 1, '실패 후 일부 메뉴가 남음';

  BEGIN
    PERFORM public.submit_order('00000000-0000-0000-0000-000000000006',
      '00000000-0000-0000-0000-000000000002', '4번', '현금',
      '[{"menu_id":"00000000-0000-0000-0000-000000000003","quantity":1,"unit_price":1}]');
    RAISE EXCEPTION '잘못된 가격을 수락함';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  ASSERT (SELECT count(*) FROM public.orders) = 1;
END;
$$;
RESET ROLE;

UPDATE public.menus SET is_sold_out = true;
SET ROLE anon;
DO $$
BEGIN
  -- 이미 접수된 요청은 품절 이후에도 기존 주문을 반환해야 한다.
  ASSERT public.submit_order('00000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000002', '3번', '현금',
    '[{"menu_id":"00000000-0000-0000-0000-000000000003","quantity":2,"unit_price":3000}]')->>'order_number' = '1';
  BEGIN
    PERFORM public.submit_order('00000000-0000-0000-0000-000000000007',
      '00000000-0000-0000-0000-000000000002', '4번', '현금',
      '[{"menu_id":"00000000-0000-0000-0000-000000000003","quantity":1,"unit_price":3000}]');
    RAISE EXCEPTION '품절 메뉴의 새 주문을 수락함';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$$;
RESET ROLE;
UPDATE public.menus SET is_sold_out = false;
-- 기존 주문이 있는 DB에 적용용 SQL을 재실행해도 데이터가 보존되어야 한다.
\ir ../migrations/20261030_soft_delete_menus.sql
\ir soft-delete-menus.sql
\ir dashboard-totals.sql
