-- Supabase SQL Editor에서 실행. 기존 주문 데이터는 유지한다.
BEGIN;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS request_id UUID;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS request_payload JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS orders_store_request_id_key
  ON public.orders (store_id, request_id);

-- 기존 주문 화면을 포함해 매장별 주문번호 발급을 직렬화한다.
CREATE OR REPLACE FUNCTION public.set_store_order_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('order:' || NEW.store_id::text, 0));
  SELECT COALESCE(MAX(order_number), 0) + 1 INTO NEW.order_number
  FROM public.orders WHERE store_id = NEW.store_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_order(
  p_request_id UUID,
  p_store_id UUID,
  p_table_number TEXT,
  p_payment_method TEXT,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_menu public.menus%ROWTYPE;
  v_item JSONB;
  v_quantity INTEGER;
  v_payload JSONB;
BEGIN
  IF p_request_id IS NULL OR p_store_id IS NULL
     OR p_table_number IS NULL OR btrim(p_table_number) = ''
     OR p_payment_method IS NULL OR p_payment_method NOT IN ('현금', '쿠폰') THEN
    RAISE EXCEPTION '주문 정보가 올바르지 않습니다.' USING ERRCODE = '22023';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION '메뉴 목록이 올바르지 않습니다.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '주문할 메뉴가 없습니다.' USING ERRCODE = '22023';
  END IF;

  v_payload := jsonb_build_object('table_number', btrim(p_table_number),
    'payment_method', p_payment_method, 'items', p_items);
  PERFORM pg_advisory_xact_lock(hashtextextended('order:' || p_store_id::text, 0));

  SELECT * INTO v_order FROM public.orders
  WHERE store_id = p_store_id AND request_id = p_request_id;
  IF FOUND THEN
    IF v_order.request_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION '동일한 접수 요청의 내용이 변경되었습니다.' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number);
  END IF;

  IF (SELECT COUNT(DISTINCT (value->>'menu_id')::UUID) FROM jsonb_array_elements(p_items))
       <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION '메뉴가 중복되었거나 메뉴 ID가 없습니다.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.orders (store_id, table_number, payment_method, request_id, request_payload)
  VALUES (p_store_id, btrim(p_table_number), p_payment_method, p_request_id, v_payload)
  RETURNING * INTO v_order;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item->'quantity') IS DISTINCT FROM 'number'
       OR (v_item->>'quantity') !~ '^[1-9][0-9]*$'
       OR jsonb_typeof(v_item->'unit_price') IS DISTINCT FROM 'number'
       OR (v_item->>'unit_price') !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION '메뉴 수량 또는 가격이 올바르지 않습니다.' USING ERRCODE = '22023';
    END IF;
    v_quantity := (v_item->>'quantity')::INTEGER;
    SELECT * INTO v_menu FROM public.menus
    WHERE id = (v_item->>'menu_id')::UUID AND store_id = p_store_id;
    IF NOT FOUND OR v_menu.is_hidden OR v_menu.is_sold_out THEN
      RAISE EXCEPTION '판매할 수 없는 메뉴가 포함되어 있습니다. 메뉴를 다시 확인해 주세요.' USING ERRCODE = '22023';
    END IF;
    IF v_menu.price <> (v_item->>'unit_price')::INTEGER THEN
      RAISE EXCEPTION '메뉴 가격이 변경되었습니다. 메뉴를 다시 확인해 주세요.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.order_items (order_id, menu_id, menu_name, menu_price, quantity, status)
    VALUES (v_order.id, v_menu.id, v_menu.name, v_menu.price, v_quantity, 'pending');
  END LOOP;

  RETURN jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_order(UUID, UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_order(UUID, UUID, TEXT, TEXT, JSONB) TO anon, authenticated;

COMMIT;
