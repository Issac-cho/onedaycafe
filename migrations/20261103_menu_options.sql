-- 세트 메뉴 SQL 적용 후 실행. 기존 메뉴·주문·금액 보존.
BEGIN;
ALTER TABLE public.menus ADD COLUMN IF NOT EXISTS option_groups JSONB NOT NULL DEFAULT '[]';
ALTER TABLE public.order_sales ADD COLUMN IF NOT EXISTS option_summary TEXT NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION public.validate_menu_options() RETURNS TRIGGER LANGUAGE plpgsql SET search_path='' AS $$
DECLARE g jsonb;
BEGIN
  IF jsonb_typeof(NEW.option_groups)<>'array' OR jsonb_array_length(NEW.option_groups)>10
    OR (NEW.menu_type='set' AND NEW.option_groups<>'[]'::jsonb) THEN
    RAISE EXCEPTION '세부 선택은 일반 메뉴 또는 구성품에 10종까지 등록해 주세요.' USING ERRCODE='22023';
  END IF;
  FOR g IN SELECT value FROM jsonb_array_elements(NEW.option_groups) LOOP
    IF coalesce(btrim(g->>'name'),'')='' OR jsonb_typeof(g->'choices') IS DISTINCT FROM 'array'
      OR jsonb_typeof(g->'count') IS DISTINCT FROM 'number' OR (g->>'count')!~'^[1-9][0-9]*$' THEN
      RAISE EXCEPTION '선택 이름·항목·개수를 확인해 주세요.' USING ERRCODE='22023';
    END IF;
    IF (g->>'count')::numeric>10 OR jsonb_array_length(g->'choices') NOT BETWEEN 1 AND 30
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(g->'choices') c WHERE jsonb_typeof(c)<>'string' OR btrim(c#>>'{}')='')
      OR (SELECT count(DISTINCT c) FROM jsonb_array_elements(g->'choices') c)<>jsonb_array_length(g->'choices') THEN
      RAISE EXCEPTION '선택 항목은 중복 없이 1~30종, 선택 개수는 1~10개로 입력해 주세요.' USING ERRCODE='22023';
    END IF;
  END LOOP;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS validate_menu_options ON public.menus;
CREATE TRIGGER validate_menu_options BEFORE INSERT OR UPDATE ON public.menus FOR EACH ROW EXECUTE FUNCTION public.validate_menu_options();

CREATE OR REPLACE FUNCTION public.format_menu_options(p_definitions JSONB,p_values JSONB,p_multiplier INTEGER)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE g jsonb; vals jsonb; idx int:=0; result text:='';
BEGIN
  IF p_values IS NULL THEN p_values:='[]'; END IF;
  IF jsonb_typeof(p_values)<>'array' OR jsonb_array_length(p_values)<>jsonb_array_length(p_definitions) THEN
    RAISE EXCEPTION '필수 세부 선택이 누락되었거나 변경되었습니다.' USING ERRCODE='22023';
  END IF;
  FOR g IN SELECT value FROM jsonb_array_elements(p_definitions) LOOP
    vals:=p_values->idx;
    IF jsonb_typeof(vals) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '세부 선택 형식이 올바르지 않습니다.' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(vals)<>(g->>'count')::integer*p_multiplier OR jsonb_array_length(vals)>100
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(vals) v WHERE NOT (g->'choices' @> jsonb_build_array(v))) THEN
      RAISE EXCEPTION '세부 선택 항목과 개수를 다시 확인해 주세요.' USING ERRCODE='22023';
    END IF;
    result:=result||CASE WHEN result='' THEN '' ELSE ', ' END||(g->>'name')||': '||(SELECT string_agg(v#>>'{}',' / ' ORDER BY v#>>'{}') FROM jsonb_array_elements(vals) v);
    idx:=idx+1;
  END LOOP;
  RETURN result;
END; $$;
CREATE OR REPLACE FUNCTION public.submit_order(p_request_id UUID,p_store_id UUID,p_table_number TEXT,p_payment_method TEXT,p_items JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.orders%ROWTYPE; m public.menus%ROWTYPE; c public.menus%ROWTYPE;
  item JSONB; part JSONB; payload JSONB; qty INTEGER; parts JSONB; sale UUID; selections JSONB; selected JSONB; option_text TEXT; sale_options TEXT; validated INTEGER;
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
  IF (SELECT count(DISTINCT jsonb_build_array((p->>'menu_id')::uuid,coalesce(p->'selections','[]'::jsonb))) FROM jsonb_array_elements(p_items) p)<>jsonb_array_length(p_items) THEN
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
    selections:=coalesce(item->'selections','[]'::jsonb);
    IF jsonb_typeof(selections)<>'array' THEN RAISE EXCEPTION '세부 선택 목록이 올바르지 않습니다.' USING ERRCODE='22023'; END IF;
    IF (SELECT count(DISTINCT (s->>'menu_id')::uuid) FROM jsonb_array_elements(selections) s)<>jsonb_array_length(selections) THEN
      RAISE EXCEPTION '세부 선택 대상이 중복되었거나 누락되었습니다.' USING ERRCODE='22023'; END IF;
    parts:='[]'; sale_options:=''; option_text:=''; validated:=0;
    IF m.menu_type='set' THEN
      IF item->'components' IS DISTINCT FROM m.set_components THEN RAISE EXCEPTION '세트 구성이 변경되었습니다. 메뉴를 다시 확인해 주세요.' USING ERRCODE='22023'; END IF;
      FOR part IN SELECT value FROM jsonb_array_elements(m.set_components) LOOP
        SELECT * INTO c FROM public.menus WHERE id=(part->>'menu_id')::uuid AND store_id=p_store_id;
        IF NOT FOUND OR c.is_deleted OR c.is_hidden OR c.is_sold_out OR c.menu_type='set' THEN
          RAISE EXCEPTION '세트 구성품이 품절되었거나 판매 중단되었습니다.' USING ERRCODE='22023';
        END IF;
        SELECT s->'groups' INTO selected FROM jsonb_array_elements(selections) s WHERE (s->>'menu_id')::uuid=c.id;
        option_text:=public.format_menu_options(c.option_groups,selected,(part->>'quantity')::integer);
        IF jsonb_array_length(c.option_groups)>0 THEN validated:=validated+1; END IF;
        IF option_text<>'' THEN sale_options:=sale_options||CASE WHEN sale_options='' THEN '' ELSE ' · ' END||c.name||': '||option_text; END IF;
        parts:=parts||jsonb_build_array(jsonb_build_object('menu_id',c.id,'menu_name',c.name||CASE WHEN option_text='' THEN '' ELSE ' · '||option_text END,'quantity',(part->>'quantity')::integer,'kitchen_group',c.kitchen_group));
      END LOOP;
      IF jsonb_array_length(parts)=0 THEN RAISE EXCEPTION '세트 구성이 비어 있습니다.' USING ERRCODE='22023'; END IF;
    END IF;
    IF m.menu_type<>'set' THEN
      SELECT s->'groups' INTO selected FROM jsonb_array_elements(selections) s WHERE (s->>'menu_id')::uuid=m.id;
      option_text:=public.format_menu_options(m.option_groups,selected,1);
      sale_options:=option_text;
      IF jsonb_array_length(m.option_groups)>0 THEN validated:=1; END IF;
    END IF;
    IF jsonb_array_length(selections)<>validated THEN RAISE EXCEPTION '등록되지 않은 세부 선택이 포함되어 있습니다.' USING ERRCODE='22023'; END IF;
    INSERT INTO public.order_sales(order_id,menu_id,menu_name,menu_price,quantity,sale_type,components,option_summary)
    VALUES(o.id,m.id,m.name,m.price,qty,CASE WHEN m.menu_type='set' THEN 'set' ELSE 'single' END,parts,sale_options) RETURNING id INTO sale;
    IF m.menu_type='set' THEN
      FOR part IN SELECT value FROM jsonb_array_elements(parts) LOOP
        INSERT INTO public.order_items(order_id,menu_id,menu_name,menu_price,quantity,sale_line_id,set_name,sale_quantity)
        VALUES(o.id,(part->>'menu_id')::uuid,part->>'menu_name',0,qty*(part->>'quantity')::integer,sale,m.name,qty);
      END LOOP;
    ELSE
      INSERT INTO public.order_items(order_id,menu_id,menu_name,menu_price,quantity,sale_line_id)
      VALUES(o.id,m.id,m.name||CASE WHEN option_text='' THEN '' ELSE ' · '||option_text END,m.price,qty,sale);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('id',o.id,'order_number',o.order_number);
END; $$;

COMMIT;
