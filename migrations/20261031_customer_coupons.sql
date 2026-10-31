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
