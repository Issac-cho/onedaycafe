BEGIN;

ALTER TABLE public.order_items ADD COLUMN kitchen_note TEXT;

CREATE FUNCTION public.clear_cooked_kitchen_note() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.status <> 'pending' THEN
    NEW.kitchen_note := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clear_cooked_kitchen_note BEFORE UPDATE OF status ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.clear_cooked_kitchen_note();

CREATE FUNCTION public.submit_order_with_kitchen_note(
  p_request_id UUID, p_store_id UUID, p_table_number TEXT, p_payment_method TEXT, p_items JSONB,
  p_kitchen_note TEXT, p_customer_type TEXT DEFAULT NULL, p_customer_name TEXT DEFAULT NULL,
  p_member_name TEXT DEFAULT NULL, p_coupon_used BIGINT DEFAULT NULL, p_cash_received BIGINT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result JSONB; already_submitted BOOLEAN; note TEXT := nullif(btrim(p_kitchen_note), '');
BEGIN
  IF char_length(note) > 200 THEN
    RAISE EXCEPTION '주방 요청 사항은 200자 이내로 입력해 주세요.' USING ERRCODE='22023';
  END IF;
  -- 기존 접수와 같은 잠금으로 재시도 시 이미 지운 요청 사항을 되살리지 않는다.
  PERFORM pg_advisory_xact_lock(hashtextextended('order:'||p_store_id::text,0));
  SELECT EXISTS (
    SELECT 1 FROM public.orders WHERE store_id=p_store_id AND request_id=p_request_id
  ) INTO already_submitted;

  IF p_customer_type IS NULL THEN
    result := public.submit_order(p_request_id,p_store_id,p_table_number,p_payment_method,p_items);
  ELSE
    result := public.submit_customer_order(p_request_id,p_store_id,p_table_number,p_payment_method,p_items,
      p_customer_type,p_customer_name,p_member_name,p_coupon_used,p_cash_received);
  END IF;

  IF NOT already_submitted AND note IS NOT NULL THEN
    UPDATE public.order_items SET kitchen_note=note WHERE order_id=(result->>'id')::uuid AND status='pending';
  END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_order_with_kitchen_note(UUID,UUID,TEXT,TEXT,JSONB,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_order_with_kitchen_note(UUID,UUID,TEXT,TEXT,JSONB,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT) TO anon,authenticated;

COMMIT;
