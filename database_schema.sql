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
    menu_id UUID NOT NULL REFERENCES public.menus(id) ON DELETE CASCADE,
    menu_name TEXT,
    menu_price INTEGER,
    quantity INTEGER NOT NULL,
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
