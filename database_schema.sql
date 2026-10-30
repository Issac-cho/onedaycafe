-- 기존 테이블 및 설정 완전 초기화 (새 프로젝트일 경우만 실행)
DROP PUBLICATION IF EXISTS supabase_realtime;
DROP TABLE IF EXISTS public.order_items CASCADE;
DROP TABLE IF EXISTS public.orders CASCADE;
DROP TABLE IF EXISTS public.menus CASCADE;
DROP TABLE IF EXISTS public.stores CASCADE;

-- Create tables
CREATE TABLE public.stores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    order_pin TEXT,
    chef_pin TEXT,
    server_pin TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.menus (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    category TEXT NOT NULL,
    kitchen_group INTEGER NOT NULL,
    is_sold_out BOOLEAN NOT NULL DEFAULT false,
    is_hidden BOOLEAN NOT NULL DEFAULT false,
    is_deleted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
    table_number TEXT NOT NULL,
    order_number SERIAL,
    payment_method TEXT NOT NULL, -- 'cash', 'coupon'
    status TEXT NOT NULL DEFAULT 'received', -- 'received', 'preparing', 'completed'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    menu_id UUID NOT NULL REFERENCES public.menus(id) ON DELETE NO ACTION,
    menu_name TEXT,
    menu_price INTEGER,
    quantity INTEGER NOT NULL,
    served_quantity INTEGER NOT NULL DEFAULT 0
      CHECK (served_quantity >= 0 AND served_quantity <= quantity),
    cooked_quantity INTEGER NOT NULL DEFAULT 0
      CHECK (served_quantity <= cooked_quantity AND cooked_quantity <= quantity),
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'cooked', 'served'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

-- Policies for stores
CREATE POLICY "Anyone can view stores" ON public.stores FOR SELECT USING (true);
CREATE POLICY "Store owners can insert" ON public.stores FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Store owners can update" ON public.stores FOR UPDATE USING (auth.uid() = owner_id);
CREATE POLICY "Store owners can delete" ON public.stores FOR DELETE USING (auth.uid() = owner_id);

-- Policies for menus
CREATE POLICY "Anyone can view menus" ON public.menus FOR SELECT USING (true);
CREATE POLICY "Store owners can insert menus" ON public.menus FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.stores WHERE public.stores.id = menus.store_id AND public.stores.owner_id = auth.uid())
);
CREATE POLICY "Store owners can update menus" ON public.menus FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.stores WHERE public.stores.id = menus.store_id AND public.stores.owner_id = auth.uid())
);
CREATE POLICY "Store owners can delete menus" ON public.menus FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.stores WHERE public.stores.id = menus.store_id AND public.stores.owner_id = auth.uid())
);

-- Policies for orders and order_items (MVP: Anyone can insert/update with PIN lock handled at application layer)
CREATE POLICY "Anyone can view orders" ON public.orders FOR SELECT USING (true);
CREATE POLICY "Anyone can insert orders" ON public.orders FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update orders" ON public.orders FOR UPDATE USING (true);

CREATE POLICY "Anyone can view order items" ON public.order_items FOR SELECT USING (true);
CREATE POLICY "Anyone can insert order items" ON public.order_items FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update order items" ON public.order_items FOR UPDATE USING (true);

-- Enable Realtime for specific tables
BEGIN;
  DROP PUBLICATION IF EXISTS supabase_realtime;
  CREATE PUBLICATION supabase_realtime;
COMMIT;
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.menus;

-- Auto-increment order_number per store_id
CREATE OR REPLACE FUNCTION set_store_order_number()
RETURNS TRIGGER 
SET search_path = public
AS $$
BEGIN
  SELECT COALESCE(MAX(order_number), 0) + 1
  INTO NEW.order_number
  FROM public.orders
  WHERE store_id = NEW.store_id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_order_number_trigger ON public.orders;
CREATE TRIGGER set_order_number_trigger
BEFORE INSERT ON public.orders
FOR EACH ROW
EXECUTE FUNCTION set_store_order_number();

-- 원자적 주문 접수 및 재시도 중복 방지
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

-- 메뉴 소프트 삭제 및 이력 보존
-- 기존 주문 데이터는 보존한다. 원자적 주문 접수 SQL 적용 후 실행.
BEGIN;

ALTER TABLE public.menus ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;

-- 이전 앱의 DELETE 요청도 주문 이력을 지우지 못하도록 차단한다.
DROP POLICY IF EXISTS "Store owners can delete menus" ON public.menus;
ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_menu_id_fkey;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_menu_id_fkey
  FOREIGN KEY (menu_id) REFERENCES public.menus(id) ON DELETE NO ACTION;

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
    IF NOT FOUND OR v_menu.is_deleted OR v_menu.is_hidden OR v_menu.is_sold_out THEN
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
