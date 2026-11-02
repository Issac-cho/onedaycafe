-- 기존 쿠폰·지인 정보·주방 완료 내역 SQL 적용 후 실행. 기존 주문과 금액 보존.
BEGIN;
ALTER TABLE public.menus
  ADD COLUMN IF NOT EXISTS menu_type TEXT NOT NULL DEFAULT 'single' CHECK (menu_type IN ('single','component','set')),
  ADD COLUMN IF NOT EXISTS set_components JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(set_components)='array');

CREATE OR REPLACE FUNCTION public.validate_set_menu()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path='' AS $$
DECLARE part JSONB; component public.menus%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.menu_type=OLD.menu_type AND NEW.set_components=OLD.set_components AND NEW.store_id=OLD.store_id THEN RETURN NEW; END IF;
  END IF;
  IF NEW.menu_type<>'set' THEN
    IF NEW.set_components<>'[]'::jsonb THEN RAISE EXCEPTION '일반 메뉴에 세트 구성을 지정할 수 없습니다.' USING ERRCODE='22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.menus m, jsonb_array_elements(m.set_components) p WHERE m.menu_type='set' AND NOT m.is_deleted AND p->>'menu_id'=NEW.id::text)
      AND (TG_OP='UPDATE' AND NEW.store_id<>OLD.store_id) THEN
      RAISE EXCEPTION '세트에서 사용하는 구성품의 유형·매장을 변경할 수 없습니다.' USING ERRCODE='22023';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.menus m, jsonb_array_elements(m.set_components) p WHERE m.menu_type='set' AND NOT m.is_deleted AND p->>'menu_id'=NEW.id::text) THEN
    RAISE EXCEPTION '세트 안에 다른 세트를 넣을 수 없습니다.' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(NEW.set_components) NOT BETWEEN 1 AND 50
    OR (SELECT count(DISTINCT (p->>'menu_id')::uuid) FROM jsonb_array_elements(NEW.set_components) p)<>jsonb_array_length(NEW.set_components) THEN
    RAISE EXCEPTION '구성품은 중복 없이 1~50종을 지정해 주세요.' USING ERRCODE='22023';
  END IF;
  FOR part IN SELECT value FROM jsonb_array_elements(NEW.set_components) LOOP
    IF jsonb_typeof(part->'quantity') IS DISTINCT FROM 'number' OR (part->>'quantity')!~'^[1-9][0-9]*$'
      OR (part->>'quantity')::numeric>1000 THEN
      RAISE EXCEPTION '구성품 수량은 1~1000개여야 합니다.' USING ERRCODE='22023';
    END IF;
    SELECT * INTO component FROM public.menus WHERE id=(part->>'menu_id')::uuid AND store_id=NEW.store_id;
    IF NOT FOUND OR component.menu_type='set' OR component.is_deleted OR component.id=NEW.id THEN
      RAISE EXCEPTION '같은 매장의 판매 중인 일반 메뉴·구성품을 선택해 주세요. 세트 중첩은 불가능합니다.' USING ERRCODE='22023';
    END IF;
  END LOOP;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS validate_set_menu ON public.menus;
CREATE TRIGGER validate_set_menu BEFORE INSERT OR UPDATE ON public.menus FOR EACH ROW EXECUTE FUNCTION public.validate_set_menu();

CREATE TABLE IF NOT EXISTS public.order_sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  menu_id UUID NOT NULL REFERENCES public.menus(id) ON DELETE NO ACTION,
  menu_name TEXT NOT NULL,
  menu_price BIGINT NOT NULL CHECK(menu_price>=0),
  quantity INTEGER NOT NULL CHECK(quantity>0),
  sale_type TEXT NOT NULL DEFAULT 'single' CHECK(sale_type IN ('single','set')),
  components JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.order_sales ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_sales_read ON public.order_sales;
CREATE POLICY order_sales_read ON public.order_sales FOR SELECT USING(true);
REVOKE ALL ON public.order_sales FROM anon,authenticated;
GRANT SELECT ON public.order_sales TO anon,authenticated;
CREATE INDEX IF NOT EXISTS order_sales_order_id_idx ON public.order_sales(order_id);
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS sale_line_id UUID REFERENCES public.order_sales(id),
  ADD COLUMN IF NOT EXISTS set_name TEXT,
  ADD COLUMN IF NOT EXISTS sale_quantity INTEGER;
CREATE INDEX IF NOT EXISTS order_items_sale_line_id_idx ON public.order_items(sale_line_id);
-- 기존 주문은 상세별 판매 행을 만든다. 조리·서빙 수량은 변경하지 않는다.
INSERT INTO public.order_sales(id,order_id,menu_id,menu_name,menu_price,quantity,created_at)
SELECT i.id,i.order_id,i.menu_id,coalesce(i.menu_name,m.name,'삭제된 메뉴'),coalesce(i.menu_price,m.price,0),i.quantity,i.created_at
FROM public.order_items i LEFT JOIN public.menus m ON m.id=i.menu_id WHERE i.sale_line_id IS NULL
ON CONFLICT(id) DO NOTHING;
UPDATE public.order_items SET sale_line_id=id WHERE sale_line_id IS NULL;

CREATE OR REPLACE FUNCTION public.submit_order(p_request_id UUID,p_store_id UUID,p_table_number TEXT,p_payment_method TEXT,p_items JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.orders%ROWTYPE; m public.menus%ROWTYPE; c public.menus%ROWTYPE;
  item JSONB; part JSONB; payload JSONB; qty INTEGER; parts JSONB; sale UUID;
BEGIN
  IF p_request_id IS NULL OR p_store_id IS NULL OR coalesce(btrim(p_table_number),'')=''
    OR p_payment_method IS NULL OR p_payment_method NOT IN ('현금','쿠폰') THEN
    RAISE EXCEPTION '주문 정보가 올바르지 않습니다.' USING ERRCODE='22023';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' THEN RAISE EXCEPTION '메뉴 목록이 올바르지 않습니다.' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_items)=0 OR jsonb_array_length(p_items)>100 THEN RAISE EXCEPTION '메뉴는 1~100종을 주문해 주세요.' USING ERRCODE='22023'; END IF;
  payload:=jsonb_build_object('table_number',btrim(p_table_number),'payment_method',p_payment_method,'items',p_items);
  PERFORM pg_advisory_xact_lock(hashtextextended('order:'||p_store_id::text,0));
  SELECT * INTO o FROM public.orders WHERE store_id=p_store_id AND request_id=p_request_id;
  IF FOUND THEN
    IF o.request_payload IS DISTINCT FROM payload THEN RAISE EXCEPTION '동일한 접수 요청의 내용이 변경되었습니다.' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('id',o.id,'order_number',o.order_number);
  END IF;
  IF (SELECT count(DISTINCT (p->>'menu_id')::uuid) FROM jsonb_array_elements(p_items) p)<>jsonb_array_length(p_items) THEN
    RAISE EXCEPTION '메뉴가 중복되었거나 메뉴 ID가 없습니다.' USING ERRCODE='22023';
  END IF;
  -- 가격·구성·품절 정보를 확인하는 동안 변경되지 않도록 메뉴를 고정한다.
  LOCK TABLE public.menus IN SHARE MODE;
  INSERT INTO public.orders(store_id,table_number,payment_method,request_id,request_payload)
  VALUES(p_store_id,btrim(p_table_number),p_payment_method,p_request_id,payload) RETURNING * INTO o;
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(item->'quantity') IS DISTINCT FROM 'number' OR (item->>'quantity')!~'^[1-9][0-9]*$'
      OR jsonb_typeof(item->'unit_price') IS DISTINCT FROM 'number' OR (item->>'unit_price')!~'^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION '메뉴 수량 또는 가격이 올바르지 않습니다.' USING ERRCODE='22023';
    END IF;
    qty:=(item->>'quantity')::integer;
    SELECT * INTO m FROM public.menus WHERE id=(item->>'menu_id')::uuid AND store_id=p_store_id;
    IF NOT FOUND OR m.is_deleted OR m.is_hidden OR m.is_sold_out OR m.menu_type='component' THEN
      RAISE EXCEPTION '판매할 수 없는 메뉴가 포함되어 있습니다. 메뉴를 다시 확인해 주세요.' USING ERRCODE='22023';
    END IF;
    IF m.price<>(item->>'unit_price')::bigint THEN RAISE EXCEPTION '메뉴 가격이 변경되었습니다. 메뉴를 다시 확인해 주세요.' USING ERRCODE='22023'; END IF;
    parts:='[]';
    IF m.menu_type='set' THEN
      IF item->'components' IS DISTINCT FROM m.set_components THEN RAISE EXCEPTION '세트 구성이 변경되었습니다. 메뉴를 다시 확인해 주세요.' USING ERRCODE='22023'; END IF;
      FOR part IN SELECT value FROM jsonb_array_elements(m.set_components) LOOP
        SELECT * INTO c FROM public.menus WHERE id=(part->>'menu_id')::uuid AND store_id=p_store_id;
        IF NOT FOUND OR c.is_deleted OR c.is_hidden OR c.is_sold_out OR c.menu_type='set' THEN
          RAISE EXCEPTION '세트 구성품이 품절되었거나 판매 중단되었습니다.' USING ERRCODE='22023';
        END IF;
        parts:=parts||jsonb_build_array(jsonb_build_object('menu_id',c.id,'menu_name',c.name,'quantity',(part->>'quantity')::integer,'kitchen_group',c.kitchen_group));
      END LOOP;
      IF jsonb_array_length(parts)=0 THEN RAISE EXCEPTION '세트 구성이 비어 있습니다.' USING ERRCODE='22023'; END IF;
    END IF;
    INSERT INTO public.order_sales(order_id,menu_id,menu_name,menu_price,quantity,sale_type,components)
    VALUES(o.id,m.id,m.name,m.price,qty,CASE WHEN m.menu_type='set' THEN 'set' ELSE 'single' END,parts) RETURNING id INTO sale;
    IF m.menu_type='set' THEN
      FOR part IN SELECT value FROM jsonb_array_elements(parts) LOOP
        INSERT INTO public.order_items(order_id,menu_id,menu_name,menu_price,quantity,sale_line_id,set_name,sale_quantity)
        VALUES(o.id,(part->>'menu_id')::uuid,part->>'menu_name',0,qty*(part->>'quantity')::integer,sale,m.name,qty);
      END LOOP;
    ELSE
      INSERT INTO public.order_items(order_id,menu_id,menu_name,menu_price,quantity,sale_line_id)
      VALUES(o.id,m.id,m.name,m.price,qty,sale);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('id',o.id,'order_number',o.order_number);
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
    customer_name=coalesce(btrim(p_customer_name),''),member_name=CASE WHEN p_customer_type='지체 손님' THEN coalesce(a.member_name,'') ELSE '' END,
    coupon_account_id=a.id,coupon_used=p_coupon_used,cash_due=due,cash_received=received,
    coupon_credited=credited,request_payload=payload WHERE id=o.id;
  RETURN result;
END; $$;


CREATE OR REPLACE FUNCTION public.get_dashboard_totals(p_store_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
  WITH sales AS (SELECT s.order_id,sum(s.menu_price*s.quantity) total FROM public.order_sales s JOIN public.orders o ON o.id=s.order_id WHERE o.store_id=p_store_id GROUP BY s.order_id),
  work AS (SELECT i.order_id,sum(greatest(i.quantity-i.cooked_quantity,0)) pending,
    sum(greatest(i.cooked_quantity-i.served_quantity,0)) cooked FROM public.order_items i JOIN public.orders o ON o.id=i.order_id WHERE o.store_id=p_store_id GROUP BY i.order_id),
  per_order AS (SELECT o.*,coalesce(s.total,0) total,coalesce(w.pending,0) pending,coalesce(w.cooked,0) cooked
    FROM public.orders o LEFT JOIN sales s ON s.order_id=o.id LEFT JOIN work w ON w.order_id=o.id WHERE o.store_id=p_store_id)
  SELECT jsonb_build_object('totalRevenue',coalesce(sum(total),0),'totalOrders',count(*),
    'pendingItems',coalesce(sum(pending),0),'cookedItems',coalesce(sum(cooked),0),
    'couponUsed',coalesce(sum(coalesce(coupon_used,CASE WHEN payment_method='쿠폰' THEN total ELSE 0 END)),0),
    'cashDue',coalesce(sum(coalesce(cash_due,CASE WHEN payment_method='현금' THEN total ELSE 0 END)),0),
    'cashReceived',coalesce(sum(coalesce(cash_received,CASE WHEN payment_method='현금' THEN total ELSE 0 END)),0),
    'couponCredited',coalesce(sum(coupon_credited),0)) FROM per_order;
$$;

COMMIT;
