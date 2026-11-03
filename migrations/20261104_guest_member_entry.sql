-- 미등록 지체 손님의 지체 이름을 주문과 신규 적립 계정에 보존한다. 기존 계정 정보는 변경하지 않는다.
BEGIN;
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
  SELECT coalesce(sum(menu_price::bigint*quantity),0) INTO total FROM public.order_sales WHERE order_id=o.id;
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
    VALUES(p_store_id,p_customer_type,btrim(p_customer_name),CASE WHEN p_customer_type='지체 손님' THEN coalesce(btrim(p_member_name),'') ELSE '' END) RETURNING * INTO a;
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
    customer_name=coalesce(btrim(p_customer_name),''),member_name=CASE WHEN p_customer_type='지체 손님' THEN coalesce(a.member_name,btrim(p_member_name),'') ELSE '' END,
    coupon_account_id=a.id,coupon_used=p_coupon_used,cash_due=due,cash_received=received,
    coupon_credited=credited,request_payload=payload WHERE id=o.id;
  RETURN result;
END; $$;
COMMIT;
