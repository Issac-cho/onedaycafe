\encoding UTF8
\set ON_ERROR_STOP on
\ir ../migrations/20261102_set_menus.sql
BEGIN;
SELECT set_config('test.uid','00000000-0000-0000-0000-000000000001',false);
DO $$ BEGIN
  ASSERT NOT EXISTS(SELECT 1 FROM public.order_items WHERE sale_line_id IS NULL), '기존 판매 이력 누락';
  ASSERT (SELECT sum(menu_price*quantity) FROM public.order_sales)=(SELECT sum(coalesce(i.menu_price,m.price,0)::bigint*i.quantity) FROM public.order_items i LEFT JOIN public.menus m ON m.id=i.menu_id), '기존 매출 변경';
END; $$;
INSERT INTO public.menus(id,store_id,name,price,category,kitchen_group,menu_type) VALUES
('00000000-0000-0000-0000-000000001001','00000000-0000-0000-0000-000000000002','필라프',0,'구성품',1,'component'),
('00000000-0000-0000-0000-000000001002','00000000-0000-0000-0000-000000000002','콜라',0,'구성품',7,'component');
INSERT INTO public.menus(id,store_id,name,price,category,kitchen_group,menu_type,set_components) VALUES
('00000000-0000-0000-0000-000000001003','00000000-0000-0000-0000-000000000002','필라프 세트',15000,'식사',1,'set',
'[{"menu_id":"00000000-0000-0000-0000-000000001001","quantity":1},{"menu_id":"00000000-0000-0000-0000-000000001002","quantity":1}]'),
('00000000-0000-0000-0000-000000001004','00000000-0000-0000-0000-000000000002','콜라 2개',5000,'음료',1,'set',
'[{"menu_id":"00000000-0000-0000-0000-000000001002","quantity":2}]');
CREATE TEMP TABLE set_fixture(payload jsonb,request_id uuid,order_id uuid);
INSERT INTO set_fixture(payload,request_id) VALUES
('[{"menu_id":"00000000-0000-0000-0000-000000001003","quantity":2,"unit_price":15000,"components":[{"menu_id":"00000000-0000-0000-0000-000000001001","quantity":1},{"menu_id":"00000000-0000-0000-0000-000000001002","quantity":1}]},{"menu_id":"00000000-0000-0000-0000-000000001004","quantity":1,"unit_price":5000,"components":[{"menu_id":"00000000-0000-0000-0000-000000001002","quantity":2}]}]',gen_random_uuid());
GRANT SELECT,UPDATE ON set_fixture TO anon,authenticated;
SET ROLE anon;
DO $$
DECLARE r jsonb; p jsonb; req uuid;
BEGIN
  SELECT payload,request_id INTO p,req FROM set_fixture;
  r:=public.submit_customer_order(req,'00000000-0000-0000-0000-000000000002','세트검증','현금',p,'외부자','','',0,NULL);
  UPDATE set_fixture SET order_id=(r->>'id')::uuid;
  ASSERT public.submit_customer_order(req,'00000000-0000-0000-0000-000000000002','세트검증','현금',p,'외부자','','',0,NULL)=r;
  ASSERT (SELECT cash_due FROM public.orders WHERE id=(r->>'id')::uuid)=35000;
  ASSERT (SELECT count(*) FROM public.order_sales WHERE order_id=(r->>'id')::uuid)=2;
  ASSERT (SELECT sum(menu_price*quantity) FROM public.order_sales WHERE order_id=(r->>'id')::uuid)=35000;
  ASSERT (SELECT count(*) FROM public.order_items WHERE order_id=(r->>'id')::uuid)=3;
  ASSERT (SELECT sum(quantity) FROM public.order_items WHERE order_id=(r->>'id')::uuid AND menu_id='00000000-0000-0000-0000-000000001001')=2;
  ASSERT (SELECT sum(quantity) FROM public.order_items WHERE order_id=(r->>'id')::uuid AND menu_id='00000000-0000-0000-0000-000000001002')=4;
  ASSERT (SELECT count(DISTINCT set_name) FROM public.order_items WHERE order_id=(r->>'id')::uuid)=2;
  ASSERT (SELECT sum(menu_price) FROM public.order_items WHERE order_id=(r->>'id')::uuid)=0, '구성품 중복 매출 금지';
  BEGIN
    PERFORM public.submit_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','구성품단품','현금',
      '[{"menu_id":"00000000-0000-0000-0000-000000001002","quantity":1,"unit_price":0}]');
    RAISE EXCEPTION '구성 전용 메뉴 단품 주문 허용';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END; $$;
RESET ROLE;
SET ROLE authenticated;
SELECT public.manage_coupon_account(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','개척자','세트쿠폰','',50000,true);
RESET ROLE;
SET ROLE anon;
DO $$ BEGIN
  PERFORM public.submit_customer_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','세트쿠폰','쿠폰',
    (SELECT payload FROM set_fixture),'개척자','세트쿠폰','',35000,0);
  ASSERT (public.lookup_coupon_account('00000000-0000-0000-0000-000000000002','개척자','세트쿠폰','')->>'balance')::bigint=15000;
  PERFORM public.submit_customer_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','세트초과','현금',
    (SELECT payload FROM set_fixture),'외부자','세트초과손님','',0,40000);
  ASSERT (public.lookup_coupon_account('00000000-0000-0000-0000-000000000002','외부자','세트초과손님','')->>'balance')::bigint=5000;
  BEGIN
    UPDATE public.order_sales SET menu_price=1 WHERE order_id=(SELECT order_id FROM set_fixture);
    RAISE EXCEPTION '판매 이력 직접 변경 허용';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END; $$;
RESET ROLE;
UPDATE public.menus SET is_sold_out=true WHERE id='00000000-0000-0000-0000-000000001002';
SET ROLE anon;
DO $$
DECLARE before_orders int; before_sales int;
BEGIN
  SELECT count(*) INTO before_orders FROM public.orders;
  SELECT count(*) INTO before_sales FROM public.order_sales;
  BEGIN
    PERFORM public.submit_customer_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','품절','현금',
      (SELECT payload FROM set_fixture),'외부자','','',0,NULL);
    RAISE EXCEPTION '품절 구성품 주문 허용';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  ASSERT (SELECT count(*) FROM public.orders)=before_orders;
  ASSERT (SELECT count(*) FROM public.order_sales)=before_sales, '실패한 세트 판매 행 잔존';
  -- 접수 성공한 요청은 품절 이후에도 재시도 가능.
  ASSERT (public.submit_customer_order((SELECT request_id FROM set_fixture),'00000000-0000-0000-0000-000000000002','세트검증','현금',
    (SELECT payload FROM set_fixture),'외부자','','',0,NULL)->>'id')::uuid=(SELECT order_id FROM set_fixture);
END; $$;
RESET ROLE;
UPDATE public.menus SET is_sold_out=false,name='변경된 콜라' WHERE id='00000000-0000-0000-0000-000000001002';
DO $$
DECLARE flag text;
BEGIN
  FOREACH flag IN ARRAY ARRAY['is_hidden','is_deleted'] LOOP
    EXECUTE format('UPDATE public.menus SET %I=true WHERE id=''00000000-0000-0000-0000-000000001002''',flag);
    BEGIN
      PERFORM public.submit_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','판매중단','현금',jsonb_build_array((SELECT payload->1 FROM set_fixture)));
      RAISE EXCEPTION '숨김·삭제 구성품 주문 허용';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
    EXECUTE format('UPDATE public.menus SET %I=false WHERE id=''00000000-0000-0000-0000-000000001002''',flag);
  END LOOP;
END; $$;
UPDATE public.menus SET name='변경된 세트',set_components='[{"menu_id":"00000000-0000-0000-0000-000000001001","quantity":1},{"menu_id":"00000000-0000-0000-0000-000000001002","quantity":2}]'
WHERE id='00000000-0000-0000-0000-000000001003';
SET ROLE anon;
DO $$ BEGIN
  ASSERT (SELECT components->1->>'menu_name' FROM public.order_sales WHERE order_id=(SELECT order_id FROM set_fixture) AND menu_id='00000000-0000-0000-0000-000000001003')='콜라';
  ASSERT (SELECT menu_name FROM public.order_sales WHERE order_id=(SELECT order_id FROM set_fixture) AND menu_id='00000000-0000-0000-0000-000000001003')='필라프 세트';
  BEGIN
    PERFORM public.submit_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','구성변경','현금',(SELECT payload FROM set_fixture));
    RAISE EXCEPTION '오래된 세트 구성 허용';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  -- 구성품은 준비되는 대로 부분 서빙 가능하다.
  UPDATE public.order_items SET cooked_quantity=1 WHERE order_id=(SELECT order_id FROM set_fixture) AND menu_id='00000000-0000-0000-0000-000000001001';
  UPDATE public.order_items SET served_quantity=1 WHERE order_id=(SELECT order_id FROM set_fixture) AND menu_id='00000000-0000-0000-0000-000000001001';
END; $$;
RESET ROLE;
DO $$ BEGIN
  BEGIN
    UPDATE public.menus SET set_components='[{"menu_id":"00000000-0000-0000-0000-000000001003","quantity":1}]' WHERE id='00000000-0000-0000-0000-000000001004';
    RAISE EXCEPTION '세트 중첩 허용';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    UPDATE public.menus SET set_components='[{"menu_id":"00000000-0000-0000-0000-000000001002","quantity":1},{"menu_id":"00000000-0000-0000-0000-000000001002","quantity":2}]' WHERE id='00000000-0000-0000-0000-000000001004';
    RAISE EXCEPTION '중복 구성품 허용';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    UPDATE public.menus SET set_components='[{"menu_id":"00000000-0000-0000-0000-000000001002","quantity":0}]' WHERE id='00000000-0000-0000-0000-000000001004';
    RAISE EXCEPTION '잘못된 구성품 수량 허용';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  ASSERT (public.get_dashboard_totals('00000000-0000-0000-0000-000000000002')->>'totalRevenue')::bigint=
    (SELECT sum(s.menu_price*s.quantity) FROM public.order_sales s JOIN public.orders o ON o.id=s.order_id WHERE o.store_id='00000000-0000-0000-0000-000000000002');
END; $$;
ROLLBACK;
