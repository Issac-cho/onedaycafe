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

-- 전체 데이터 통계 집계
-- 수량별 조리·서빙 SQL 적용 후 실행. 기존 데이터는 변경하지 않는다.
CREATE OR REPLACE FUNCTION public.get_dashboard_totals(p_store_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'totalRevenue', COALESCE(SUM(COALESCE(i.menu_price, m.price, 0)::BIGINT * i.quantity), 0),
    'totalOrders', COUNT(DISTINCT o.id),
    'pendingItems', COALESCE(SUM(GREATEST(i.quantity - i.cooked_quantity, 0)), 0),
    'cookedItems', COALESCE(SUM(GREATEST(i.cooked_quantity - i.served_quantity, 0)), 0)
  )
  FROM public.orders o
  LEFT JOIN public.order_items i ON i.order_id = o.id
  LEFT JOIN public.menus m ON m.id = i.menu_id
  WHERE o.store_id = p_store_id;
$$;

REVOKE ALL ON FUNCTION public.get_dashboard_totals(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_totals(UUID) TO anon, authenticated;


-- 기존 데이터 보존. 이전 원자적 주문·소프트 삭제·통계 마이그레이션 적용 후 실행.
BEGIN;
CREATE TABLE IF NOT EXISTS public.coupon_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  customer_type TEXT NOT NULL CHECK (customer_type IN ('외부자','개척자','지체 손님')),
  customer_name TEXT NOT NULL CHECK (customer_name = btrim(customer_name) AND customer_name <> ''),
  member_name TEXT NOT NULL DEFAULT '' CHECK (member_name = btrim(member_name)),
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  CHECK ((customer_type = '지체 손님' AND member_name <> '') OR (customer_type <> '지체 손님' AND member_name = '')),
  UNIQUE (store_id, customer_type, member_name, customer_name)
);
CREATE TABLE IF NOT EXISTS public.coupon_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.coupon_accounts(id),
  request_id UUID NOT NULL,
  order_id UUID REFERENCES public.orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('등록','충전','사용','초과액 적립')),
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id, kind)
);
-- 관리자 재시도 시 입력 변경도 검출한다.
CREATE TABLE IF NOT EXISTS public.coupon_admin_requests (
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  payload JSONB NOT NULL,
  result JSONB NOT NULL,
  PRIMARY KEY (store_id, request_id)
);
ALTER TABLE public.coupon_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupon_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupon_admin_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS coupon_accounts_owner_read ON public.coupon_accounts;
CREATE POLICY coupon_accounts_owner_read ON public.coupon_accounts FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.stores s WHERE s.id = store_id AND s.owner_id = auth.uid()));
DROP POLICY IF EXISTS coupon_transactions_owner_read ON public.coupon_transactions;
CREATE POLICY coupon_transactions_owner_read ON public.coupon_transactions FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.coupon_accounts a JOIN public.stores s ON s.id=a.store_id WHERE a.id=account_id AND s.owner_id=auth.uid()));
REVOKE ALL ON public.coupon_accounts, public.coupon_transactions, public.coupon_admin_requests FROM anon, authenticated;
GRANT SELECT ON public.coupon_accounts, public.coupon_transactions TO authenticated;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS customer_type TEXT,
  ADD COLUMN IF NOT EXISTS customer_name TEXT,
  ADD COLUMN IF NOT EXISTS member_name TEXT,
  ADD COLUMN IF NOT EXISTS coupon_account_id UUID REFERENCES public.coupon_accounts(id),
  ADD COLUMN IF NOT EXISTS coupon_used BIGINT CHECK (coupon_used >= 0),
  ADD COLUMN IF NOT EXISTS cash_due BIGINT CHECK (cash_due >= 0),
  ADD COLUMN IF NOT EXISTS cash_received BIGINT CHECK (cash_received >= 0),
  ADD COLUMN IF NOT EXISTS coupon_credited BIGINT CHECK (coupon_credited >= 0);

-- 이름을 정확히 입력한 계정만 조회한다. 직원에게 전체 이름 목록은 공개하지 않는다.
CREATE OR REPLACE FUNCTION public.lookup_coupon_account(p_store_id UUID, p_customer_type TEXT, p_customer_name TEXT, p_member_name TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', id, 'balance', balance) FROM public.coupon_accounts
  WHERE store_id=p_store_id AND customer_type=p_customer_type
    AND customer_name=btrim(p_customer_name) AND member_name=coalesce(btrim(p_member_name),'');
$$;

CREATE OR REPLACE FUNCTION public.manage_coupon_account(p_request_id UUID, p_store_id UUID,
  p_customer_type TEXT, p_customer_name TEXT, p_member_name TEXT, p_amount BIGINT, p_create BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.coupon_accounts%ROWTYPE; payload JSONB; previous public.coupon_admin_requests%ROWTYPE; result JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE id=p_store_id AND owner_id=auth.uid()) THEN
    RAISE EXCEPTION '매장 관리자만 충전할 수 있습니다.' USING ERRCODE='42501';
  END IF;
  IF p_request_id IS NULL OR p_customer_type IS NULL OR p_customer_type NOT IN ('외부자','개척자','지체 손님')
    OR coalesce(btrim(p_customer_name),'')='' OR p_amount IS NULL OR p_amount < 0 OR p_amount > 1000000000
    OR p_create IS NULL OR (NOT p_create AND p_amount=0)
    OR (p_customer_type='지체 손님' AND coalesce(btrim(p_member_name),'')='')
    OR (p_customer_type<>'지체 손님' AND coalesce(btrim(p_member_name),'')<>'') THEN
    RAISE EXCEPTION '이름과 충전 금액을 확인해 주세요.' USING ERRCODE='22023';
  END IF;
  payload := jsonb_build_object('type',p_customer_type,'name',btrim(p_customer_name),'member',coalesce(btrim(p_member_name),''),'amount',p_amount,'create',p_create);
  -- 주문과 충전 모두 같은 매장 락을 사용한다. 일일카페 규모에서 단순하고 안전한 직렬화.
  PERFORM pg_advisory_xact_lock(hashtextextended('order:'||p_store_id::text,0));
  SELECT * INTO previous FROM public.coupon_admin_requests WHERE store_id=p_store_id AND request_id=p_request_id;
  IF FOUND THEN
    IF previous.payload IS DISTINCT FROM payload THEN RAISE EXCEPTION '같은 충전 요청의 내용이 변경되었습니다.' USING ERRCODE='22023'; END IF;
    RETURN previous.result;
  END IF;
  SELECT * INTO a FROM public.coupon_accounts WHERE store_id=p_store_id AND customer_type=p_customer_type
    AND customer_name=btrim(p_customer_name) AND member_name=coalesce(btrim(p_member_name),'') FOR UPDATE;
  IF p_create THEN
    IF FOUND THEN RAISE EXCEPTION '이미 등록된 이름입니다. 동명이인은 이름 뒤에 숫자를 붙여 구분해 주세요.' USING ERRCODE='22023'; END IF;
    INSERT INTO public.coupon_accounts(store_id,customer_type,customer_name,member_name)
    VALUES(p_store_id,p_customer_type,btrim(p_customer_name),coalesce(btrim(p_member_name),'')) RETURNING * INTO a;
  ELSIF NOT FOUND THEN RAISE EXCEPTION '등록된 계정이 없습니다.' USING ERRCODE='22023'; END IF;
  UPDATE public.coupon_accounts SET balance=balance+p_amount WHERE id=a.id RETURNING * INTO a;
  INSERT INTO public.coupon_transactions(account_id,request_id,kind,amount,balance_after)
  VALUES(a.id,p_request_id,CASE WHEN p_create THEN '등록' ELSE '충전' END,p_amount,a.balance);
  result := jsonb_build_object('id',a.id,'balance',a.balance);
  INSERT INTO public.coupon_admin_requests VALUES(p_store_id,p_request_id,payload,result);
  RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.submit_customer_order(p_request_id UUID, p_store_id UUID,
  p_table_number TEXT, p_payment_method TEXT, p_items JSONB, p_customer_type TEXT,
  p_customer_name TEXT, p_member_name TEXT, p_coupon_used BIGINT, p_cash_received BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.coupon_accounts%ROWTYPE; o public.orders%ROWTYPE; payload JSONB; result JSONB;
  total BIGINT; due BIGINT; received BIGINT; credited BIGINT;
BEGIN
  IF p_request_id IS NULL OR p_store_id IS NULL OR p_customer_type IS NULL
    OR p_customer_type NOT IN ('외부자','개척자','지체 손님')
    OR p_payment_method IS NULL OR p_payment_method NOT IN ('현금','쿠폰','쿠폰+현금')
    OR (p_customer_type<>'외부자' AND coalesce(btrim(p_customer_name),'')='')
    OR (p_customer_type='지체 손님' AND coalesce(btrim(p_member_name),'')='')
    OR (p_customer_type<>'지체 손님' AND coalesce(btrim(p_member_name),'')<>'')
    OR p_coupon_used IS NULL OR p_coupon_used<0 THEN
    RAISE EXCEPTION '손님 정보와 결제 금액을 확인해 주세요.' USING ERRCODE='22023';
  END IF;
  payload := jsonb_build_object('table_number',btrim(p_table_number),'payment_method',p_payment_method,'items',p_items,
    'customer_type',p_customer_type,'customer_name',coalesce(btrim(p_customer_name),''),
    'member_name',coalesce(btrim(p_member_name),''),'coupon_used',p_coupon_used,'cash_received',p_cash_received);
  PERFORM pg_advisory_xact_lock(hashtextextended('order:'||p_store_id::text,0));
  SELECT * INTO o FROM public.orders WHERE store_id=p_store_id AND request_id=p_request_id;
  IF FOUND THEN
    IF o.request_payload IS DISTINCT FROM payload THEN RAISE EXCEPTION '같은 주문 요청의 내용이 변경되었습니다.' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('id',o.id,'order_number',o.order_number);
  END IF;
  -- 기존 메뉴 검증·주문번호 생성·상세 저장 로직을 그대로 사용한다. 아래 실패도 함께 롤백된다.
  result := public.submit_order(p_request_id,p_store_id,p_table_number,'현금',p_items);
  SELECT * INTO o FROM public.orders WHERE id=(result->>'id')::uuid;
  SELECT coalesce(sum(menu_price::bigint*quantity),0) INTO total FROM public.order_items WHERE order_id=o.id;
  due := total-p_coupon_used;
  received := coalesce(p_cash_received,due);
  IF due<0 OR received<due OR received<0 OR received>1000000000
    OR (p_payment_method='현금' AND p_coupon_used<>0)
    OR (p_payment_method='쿠폰' AND (due<>0 OR received<>0))
    OR (p_payment_method='쿠폰+현금' AND (p_coupon_used=0 OR due=0)) THEN
    RAISE EXCEPTION '쿠폰 사용액 또는 받은 현금이 올바르지 않습니다.' USING ERRCODE='22023';
  END IF;
  credited := received-due;
  SELECT * INTO a FROM public.coupon_accounts WHERE store_id=p_store_id AND customer_type=p_customer_type
    AND customer_name=coalesce(btrim(p_customer_name),'') AND member_name=coalesce(btrim(p_member_name),'') FOR UPDATE;
  IF coalesce(a.balance,0)<p_coupon_used THEN RAISE EXCEPTION '쿠폰 잔액이 부족합니다. 잔액을 다시 확인해 주세요.' USING ERRCODE='22023'; END IF;
  IF credited>0 AND coalesce(btrim(p_customer_name),'')='' THEN
    RAISE EXCEPTION '초과액을 적립할 손님 이름을 입력해 주세요.' USING ERRCODE='22023';
  END IF;
  IF credited>0 AND a.id IS NULL THEN
    INSERT INTO public.coupon_accounts(store_id,customer_type,customer_name,member_name)
    VALUES(p_store_id,p_customer_type,btrim(p_customer_name),coalesce(btrim(p_member_name),'')) RETURNING * INTO a;
  END IF;
  IF p_coupon_used>0 THEN
    UPDATE public.coupon_accounts SET balance=balance-p_coupon_used WHERE id=a.id RETURNING * INTO a;
    INSERT INTO public.coupon_transactions(account_id,request_id,order_id,kind,amount,balance_after)
    VALUES(a.id,p_request_id,o.id,'사용',-p_coupon_used,a.balance);
  END IF;
  IF credited>0 THEN
    UPDATE public.coupon_accounts SET balance=balance+credited WHERE id=a.id RETURNING * INTO a;
    INSERT INTO public.coupon_transactions(account_id,request_id,order_id,kind,amount,balance_after)
    VALUES(a.id,p_request_id,o.id,'초과액 적립',credited,a.balance);
  END IF;
  UPDATE public.orders SET payment_method=p_payment_method,customer_type=p_customer_type,
    customer_name=coalesce(btrim(p_customer_name),''),member_name=coalesce(btrim(p_member_name),''),
    coupon_account_id=a.id,coupon_used=p_coupon_used,cash_due=due,cash_received=received,
    coupon_credited=credited,request_payload=payload WHERE id=o.id;
  RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.get_dashboard_totals(p_store_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  WITH per_order AS (
    SELECT o.id,o.coupon_used,o.cash_due,o.cash_received,o.coupon_credited,o.payment_method,
      coalesce(sum(coalesce(i.menu_price,m.price,0)::bigint*i.quantity),0) AS total,
      coalesce(sum(greatest(i.quantity-i.cooked_quantity,0)),0) AS pending,
      coalesce(sum(greatest(i.cooked_quantity-i.served_quantity,0)),0) AS cooked
    FROM public.orders o LEFT JOIN public.order_items i ON i.order_id=o.id LEFT JOIN public.menus m ON m.id=i.menu_id
    WHERE o.store_id=p_store_id GROUP BY o.id
  ) SELECT jsonb_build_object('totalRevenue',coalesce(sum(total),0),'totalOrders',count(*),
    'pendingItems',coalesce(sum(pending),0),'cookedItems',coalesce(sum(cooked),0),
    'couponUsed',coalesce(sum(coalesce(coupon_used,CASE WHEN payment_method='쿠폰' THEN total ELSE 0 END)),0),
    'cashDue',coalesce(sum(coalesce(cash_due,CASE WHEN payment_method='현금' THEN total ELSE 0 END)),0),
    'cashReceived',coalesce(sum(coalesce(cash_received,CASE WHEN payment_method='현금' THEN total ELSE 0 END)),0),
    'couponCredited',coalesce(sum(coupon_credited),0)) FROM per_order;
$$;
CREATE OR REPLACE FUNCTION public.get_coupon_admin_totals(p_store_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE id=p_store_id AND owner_id=auth.uid()) THEN
    RAISE EXCEPTION '매장 관리자만 조회할 수 있습니다.' USING ERRCODE='42501';
  END IF;
  RETURN (SELECT jsonb_build_object('registered',coalesce(sum(t.amount) FILTER (WHERE t.kind='등록'),0),
    'charged',coalesce(sum(t.amount) FILTER (WHERE t.kind='충전'),0))
    FROM public.coupon_transactions t JOIN public.coupon_accounts a ON a.id=t.account_id WHERE a.store_id=p_store_id);
END; $$;
REVOKE ALL ON FUNCTION public.get_coupon_admin_totals(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_coupon_admin_totals(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.lookup_coupon_account(UUID,TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.manage_coupon_account(UUID,UUID,TEXT,TEXT,TEXT,BIGINT,BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_customer_order(UUID,UUID,TEXT,TEXT,JSONB,TEXT,TEXT,TEXT,BIGINT,BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_coupon_account(UUID,TEXT,TEXT,TEXT) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.manage_coupon_account(UUID,UUID,TEXT,TEXT,TEXT,BIGINT,BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_customer_order(UUID,UUID,TEXT,TEXT,JSONB,TEXT,TEXT,TEXT,BIGINT,BIGINT) TO anon,authenticated;
COMMIT;

-- 20261031_customer_coupons.sql 적용 후 실행. 계정·잔액·기존 주문 스냅샷 보존.
BEGIN;
LOCK TABLE public.coupon_accounts IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.coupon_accounts GROUP BY store_id,customer_type,customer_name HAVING count(*)>1) THEN
    RAISE EXCEPTION '같은 유형의 손님 이름이 중복됩니다. coupon_accounts에서 별개 손님 이름을 홍길동2처럼 구분한 뒤 다시 실행해 주세요. 잔액은 합쳐지지 않았습니다.' USING ERRCODE='22023';
  END IF;
END; $$;
-- 기존 지체 이름은 이력으로 남기되 새 계정에는 필요하지 않다.
ALTER TABLE public.coupon_accounts DROP CONSTRAINT IF EXISTS coupon_accounts_check;
CREATE UNIQUE INDEX IF NOT EXISTS coupon_accounts_customer_name_key
  ON public.coupon_accounts(store_id,customer_type,customer_name);

CREATE OR REPLACE FUNCTION public.lookup_coupon_account(p_store_id UUID, p_customer_type TEXT, p_customer_name TEXT, p_member_name TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', id, 'balance', balance) FROM public.coupon_accounts
  WHERE store_id=p_store_id AND customer_type=p_customer_type
    AND customer_name=btrim(p_customer_name);
$$;

CREATE OR REPLACE FUNCTION public.manage_coupon_account(p_request_id UUID, p_store_id UUID,
  p_customer_type TEXT, p_customer_name TEXT, p_member_name TEXT, p_amount BIGINT, p_create BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.coupon_accounts%ROWTYPE; payload JSONB; previous public.coupon_admin_requests%ROWTYPE; result JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE id=p_store_id AND owner_id=auth.uid()) THEN
    RAISE EXCEPTION '매장 관리자만 충전할 수 있습니다.' USING ERRCODE='42501';
  END IF;
  IF p_request_id IS NULL OR p_customer_type IS NULL OR p_customer_type NOT IN ('외부자','개척자','지체 손님')
    OR coalesce(btrim(p_customer_name),'')='' OR p_amount IS NULL OR p_amount < 0 OR p_amount > 1000000000
    OR p_create IS NULL OR (NOT p_create AND p_amount=0)
    THEN
    RAISE EXCEPTION '이름과 충전 금액을 확인해 주세요.' USING ERRCODE='22023';
  END IF;
  payload := jsonb_build_object('type',p_customer_type,'name',btrim(p_customer_name),'member',coalesce(btrim(p_member_name),''),'amount',p_amount,'create',p_create);
  -- 주문과 충전 모두 같은 매장 락을 사용한다. 일일카페 규모에서 단순하고 안전한 직렬화.
  PERFORM pg_advisory_xact_lock(hashtextextended('order:'||p_store_id::text,0));
  SELECT * INTO previous FROM public.coupon_admin_requests WHERE store_id=p_store_id AND request_id=p_request_id;
  IF FOUND THEN
    IF previous.payload IS DISTINCT FROM payload THEN RAISE EXCEPTION '같은 충전 요청의 내용이 변경되었습니다.' USING ERRCODE='22023'; END IF;
    RETURN previous.result;
  END IF;
  SELECT * INTO a FROM public.coupon_accounts WHERE store_id=p_store_id AND customer_type=p_customer_type
    AND customer_name=btrim(p_customer_name) FOR UPDATE;
  IF p_create THEN
    IF FOUND THEN RAISE EXCEPTION '이미 등록된 이름입니다. 동명이인은 이름 뒤에 숫자를 붙여 구분해 주세요.' USING ERRCODE='22023'; END IF;
    INSERT INTO public.coupon_accounts(store_id,customer_type,customer_name,member_name)
    VALUES(p_store_id,p_customer_type,btrim(p_customer_name),'') RETURNING * INTO a;
  ELSIF NOT FOUND THEN RAISE EXCEPTION '등록된 계정이 없습니다.' USING ERRCODE='22023'; END IF;
  UPDATE public.coupon_accounts SET balance=balance+p_amount WHERE id=a.id RETURNING * INTO a;
  INSERT INTO public.coupon_transactions(account_id,request_id,kind,amount,balance_after)
  VALUES(a.id,p_request_id,CASE WHEN p_create THEN '등록' ELSE '충전' END,p_amount,a.balance);
  result := jsonb_build_object('id',a.id,'balance',a.balance);
  INSERT INTO public.coupon_admin_requests VALUES(p_store_id,p_request_id,payload,result);
  RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.submit_customer_order(p_request_id UUID, p_store_id UUID,
  p_table_number TEXT, p_payment_method TEXT, p_items JSONB, p_customer_type TEXT,
  p_customer_name TEXT, p_member_name TEXT, p_coupon_used BIGINT, p_cash_received BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.coupon_accounts%ROWTYPE; o public.orders%ROWTYPE; payload JSONB; result JSONB;
  total BIGINT; due BIGINT; received BIGINT; credited BIGINT;
BEGIN
  IF p_request_id IS NULL OR p_store_id IS NULL OR p_customer_type IS NULL
    OR p_customer_type NOT IN ('외부자','개척자','지체 손님')
    OR p_payment_method IS NULL OR p_payment_method NOT IN ('현금','쿠폰','쿠폰+현금')
    OR (p_customer_type<>'외부자' AND coalesce(btrim(p_customer_name),'')='')
    OR p_coupon_used IS NULL OR p_coupon_used<0 THEN
    RAISE EXCEPTION '손님 정보와 결제 금액을 확인해 주세요.' USING ERRCODE='22023';
  END IF;
  payload := jsonb_build_object('table_number',btrim(p_table_number),'payment_method',p_payment_method,'items',p_items,
    'customer_type',p_customer_type,'customer_name',coalesce(btrim(p_customer_name),''),
    'member_name',coalesce(btrim(p_member_name),''),'coupon_used',p_coupon_used,'cash_received',p_cash_received);
  PERFORM pg_advisory_xact_lock(hashtextextended('order:'||p_store_id::text,0));
  SELECT * INTO o FROM public.orders WHERE store_id=p_store_id AND request_id=p_request_id;
  IF FOUND THEN
    IF o.request_payload IS DISTINCT FROM payload THEN RAISE EXCEPTION '같은 주문 요청의 내용이 변경되었습니다.' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('id',o.id,'order_number',o.order_number);
  END IF;
  -- 기존 메뉴 검증·주문번호 생성·상세 저장 로직을 그대로 사용한다. 아래 실패도 함께 롤백된다.
  result := public.submit_order(p_request_id,p_store_id,p_table_number,'현금',p_items);
  SELECT * INTO o FROM public.orders WHERE id=(result->>'id')::uuid;
  SELECT coalesce(sum(menu_price::bigint*quantity),0) INTO total FROM public.order_items WHERE order_id=o.id;
  due := total-p_coupon_used;
  received := coalesce(p_cash_received,due);
  IF due<0 OR received<due OR received<0 OR received>1000000000
    OR (p_payment_method='현금' AND p_coupon_used<>0)
    OR (p_payment_method='쿠폰' AND (due<>0 OR received<>0))
    OR (p_payment_method='쿠폰+현금' AND (p_coupon_used=0 OR due=0)) THEN
    RAISE EXCEPTION '쿠폰 사용액 또는 받은 현금이 올바르지 않습니다.' USING ERRCODE='22023';
  END IF;
  credited := received-due;
  SELECT * INTO a FROM public.coupon_accounts WHERE store_id=p_store_id AND customer_type=p_customer_type
    AND customer_name=coalesce(btrim(p_customer_name),'') FOR UPDATE;
  IF coalesce(a.balance,0)<p_coupon_used THEN RAISE EXCEPTION '쿠폰 잔액이 부족합니다. 잔액을 다시 확인해 주세요.' USING ERRCODE='22023'; END IF;
  IF credited>0 AND coalesce(btrim(p_customer_name),'')='' THEN
    RAISE EXCEPTION '초과액을 적립할 손님 이름을 입력해 주세요.' USING ERRCODE='22023';
  END IF;
  IF credited>0 AND a.id IS NULL THEN
    INSERT INTO public.coupon_accounts(store_id,customer_type,customer_name,member_name)
    VALUES(p_store_id,p_customer_type,btrim(p_customer_name),'') RETURNING * INTO a;
  END IF;
  IF p_coupon_used>0 THEN
    UPDATE public.coupon_accounts SET balance=balance-p_coupon_used WHERE id=a.id RETURNING * INTO a;
    INSERT INTO public.coupon_transactions(account_id,request_id,order_id,kind,amount,balance_after)
    VALUES(a.id,p_request_id,o.id,'사용',-p_coupon_used,a.balance);
  END IF;
  IF credited>0 THEN
    UPDATE public.coupon_accounts SET balance=balance+credited WHERE id=a.id RETURNING * INTO a;
    INSERT INTO public.coupon_transactions(account_id,request_id,order_id,kind,amount,balance_after)
    VALUES(a.id,p_request_id,o.id,'초과액 적립',credited,a.balance);
  END IF;
  UPDATE public.orders SET payment_method=p_payment_method,customer_type=p_customer_type,
    customer_name=coalesce(btrim(p_customer_name),''),member_name=coalesce(btrim(p_member_name),''),
    coupon_account_id=a.id,coupon_used=p_coupon_used,cash_due=due,cash_received=received,
    coupon_credited=credited,request_payload=payload WHERE id=o.id;
  RETURN result;
END; $$;

COMMIT;
