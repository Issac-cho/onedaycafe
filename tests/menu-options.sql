\encoding UTF8
\set ON_ERROR_STOP on
\ir ../migrations/20261103_menu_options.sql
BEGIN;
INSERT INTO public.menus(id,store_id,name,price,category,kitchen_group,menu_type,option_groups) VALUES
('00000000-0000-0000-0000-000000002001','00000000-0000-0000-0000-000000000002','아메리카노',5000,'음료',7,'single','[{"name":"온도","count":1,"choices":["아이스","핫"]}]'),
('00000000-0000-0000-0000-000000002002','00000000-0000-0000-0000-000000000002','탄산음료',0,'구성품',7,'component','[{"name":"종류","count":1,"choices":["콜라","사이다"]}]');
INSERT INTO public.menus(id,store_id,name,price,category,kitchen_group,menu_type,set_components) VALUES
('00000000-0000-0000-0000-000000002003','00000000-0000-0000-0000-000000000002','탄산 2잔',5000,'음료',1,'set','[{"menu_id":"00000000-0000-0000-0000-000000002002","quantity":2}]');
SET ROLE anon;
DO $$
DECLARE r jsonb; before_count int;
BEGIN
  r:=public.submit_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','온도','현금',
    '[{"menu_id":"00000000-0000-0000-0000-000000002001","quantity":2,"unit_price":5000,"selections":[{"menu_id":"00000000-0000-0000-0000-000000002001","groups":[["아이스"]]}]},{"menu_id":"00000000-0000-0000-0000-000000002001","quantity":1,"unit_price":5000,"selections":[{"menu_id":"00000000-0000-0000-0000-000000002001","groups":[["핫"]]}]}]');
  ASSERT (SELECT count(*) FROM public.order_sales WHERE order_id=(r->>'id')::uuid)=2;
  ASSERT (SELECT sum(menu_price*quantity) FROM public.order_sales WHERE order_id=(r->>'id')::uuid)=15000;
  ASSERT EXISTS(SELECT 1 FROM public.order_items WHERE order_id=(r->>'id')::uuid AND menu_name LIKE '%아이스%' AND quantity=2);
  r:=public.submit_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','탄산선택','현금',
    '[{"menu_id":"00000000-0000-0000-0000-000000002003","quantity":1,"unit_price":5000,"components":[{"menu_id":"00000000-0000-0000-0000-000000002002","quantity":2}],"selections":[{"menu_id":"00000000-0000-0000-0000-000000002002","groups":[["콜라","사이다"]]}]}]');
  ASSERT (SELECT quantity FROM public.order_items WHERE order_id=(r->>'id')::uuid)=2;
  ASSERT (SELECT option_summary LIKE '%콜라%' AND option_summary LIKE '%사이다%' FROM public.order_sales WHERE order_id=(r->>'id')::uuid);
  ASSERT public.format_menu_options('[{"name":"맛","count":2,"choices":["팥","슈","피자"]}]','[["팥","팥"]]',1) LIKE '%팥 / 팥%';
  SELECT count(*) INTO before_count FROM public.orders;
  BEGIN
    PERFORM public.submit_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','누락','현금','[{"menu_id":"00000000-0000-0000-0000-000000002001","quantity":1,"unit_price":5000}]');
    RAISE EXCEPTION '필수 옵션 누락 허용';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.format_menu_options('[{"name":"온도","count":1,"choices":["아이스","핫"]}]','[["미등록"]]',1);
    RAISE EXCEPTION '미등록 옵션 허용';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.format_menu_options('[{"name":"종류","count":1,"choices":["콜라"]}]','[["콜라"]]',2);
    RAISE EXCEPTION '세트 선택 개수 부족 허용';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  ASSERT (SELECT count(*) FROM public.orders)=before_count;
END; $$;
RESET ROLE;
ROLLBACK;
