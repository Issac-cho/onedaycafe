\encoding UTF8
\set ON_ERROR_STOP on
BEGIN;
UPDATE public.menus SET is_deleted = true, is_hidden = true
WHERE id = '00000000-0000-0000-0000-000000000003';

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.order_items) = 1, '소프트 삭제로 주문 상세가 사라짐';
  ASSERT (SELECT sum(menu_price * quantity) FROM public.order_items) = 6000, '매출 기록이 변경됨';
  ASSERT (SELECT count(*) FROM public.order_items i JOIN public.menus m ON i.menu_id = m.id) = 1,
    '주방·서빙·CSV 조회의 메뉴 조인이 깨짐';
  ASSERT (SELECT count(*) FROM public.menus WHERE is_deleted = false) = 0,
    '판매 메뉴 목록에 삭제 메뉴가 남음';
  BEGIN
    DELETE FROM public.menus WHERE id = '00000000-0000-0000-0000-000000000003';
    RAISE EXCEPTION '주문 이력이 있는 메뉴의 물리 삭제를 허용함';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END;
$$;

-- 이전 화면에서 숨김이 해제되어도 삭제 표시는 별도로 새 주문을 막는다.
UPDATE public.menus SET is_hidden = false
WHERE id = '00000000-0000-0000-0000-000000000003';
SET ROLE anon;
DO $$
BEGIN
  -- 기존 요청 재확인은 삭제 이후에도 정상적으로 기존 주문을 반환한다.
  ASSERT public.submit_order('00000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000002', '3번', '현금',
    '[{"menu_id":"00000000-0000-0000-0000-000000000003","quantity":2,"unit_price":3000}]')->>'order_number' = '1';
  BEGIN
    PERFORM public.submit_order('00000000-0000-0000-0000-000000000008',
      '00000000-0000-0000-0000-000000000002', '4번', '현금',
      '[{"menu_id":"00000000-0000-0000-0000-000000000003","quantity":1,"unit_price":3000}]');
    RAISE EXCEPTION '삭제 메뉴의 새 주문을 수락함';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  UPDATE public.order_items SET status = 'served', cooked_quantity = quantity, served_quantity = quantity;
  ASSERT (SELECT sum(menu_price * quantity) FROM public.order_items) = 6000, '서빙 후 매출 소실';
END;
$$;
RESET ROLE;
ROLLBACK;
