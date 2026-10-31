-- 기존 주문·조리·서빙 수량을 변경하지 않는다. 과거 완료 시각은 추측해서 채우지 않는다.
BEGIN;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS cooked_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.record_cooking_completion()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.cooked_at := NULL;
    IF NEW.cooked_quantity = NEW.quantity THEN
      NEW.cooked_at := clock_timestamp();
    END IF;
  ELSE
    NEW.cooked_at := OLD.cooked_at;
    IF OLD.cooked_quantity < OLD.quantity AND NEW.cooked_quantity = NEW.quantity AND NEW.cooked_at IS NULL THEN
      NEW.cooked_at := clock_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS record_cooking_completion ON public.order_items;
CREATE TRIGGER record_cooking_completion BEFORE INSERT OR UPDATE ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.record_cooking_completion();
COMMIT;
