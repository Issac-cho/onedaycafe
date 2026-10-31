\encoding UTF8
\set ON_ERROR_STOP on
\ir ../migrations/20261031_customer_coupons.sql
INSERT INTO public.coupon_accounts(store_id,customer_type,customer_name,member_name,balance)
VALUES('00000000-0000-0000-0000-000000000002','지체 손님','기존손님','기존지체',1234);
\ir ../migrations/20261031_guest_name_only.sql
\ir ../migrations/20261031_friend_customer_entry.sql
BEGIN;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql AS
  'SELECT nullif(current_setting(''test.uid'',true),'''')::uuid';
SELECT set_config('test.uid','00000000-0000-0000-0000-000000000001',false);
CREATE TEMP TABLE coupon_fixture(id uuid, payload jsonb);
INSERT INTO coupon_fixture VALUES(gen_random_uuid(),'[{"menu_id":"00000000-0000-0000-0000-000000000003","quantity":2,"unit_price":3000}]');
GRANT SELECT ON coupon_fixture TO anon,authenticated;
SET ROLE authenticated;
DO $$
DECLARE result jsonb; req uuid:=gen_random_uuid();
BEGIN
  result:=public.manage_coupon_account(req,'00000000-0000-0000-0000-000000000002','개척자','홍길동','',10000,true);
  ASSERT (result->>'balance')::bigint=10000;
  ASSERT public.manage_coupon_account(req,'00000000-0000-0000-0000-000000000002','개척자','홍길동','',10000,true)=result;
  BEGIN
    PERFORM public.manage_coupon_account(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','개척자','홍길동','',0,true);
    RAISE EXCEPTION '중복 이름 허용';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  PERFORM public.manage_coupon_account(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','지체 손님','손님','',0,true);
  PERFORM public.manage_coupon_account(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','지체 손님','손님2','',0,true);
  ASSERT (public.lookup_coupon_account('00000000-0000-0000-0000-000000000002','지체 손님','기존손님','')->>'balance')::bigint=1234;
  ASSERT public.find_friend_accounts('00000000-0000-0000-0000-000000000002','기존손님')->0->>'member_name'='기존지체';
  PERFORM public.set_coupon_member_name((public.lookup_coupon_account('00000000-0000-0000-0000-000000000002','지체 손님','손님','')->>'id')::uuid,'홍지체');
  ASSERT public.lookup_coupon_account('00000000-0000-0000-0000-000000000002','지체 손님','손님','')->>'member_name'='홍지체';
  ASSERT (public.lookup_coupon_account('00000000-0000-0000-0000-000000000002','지체 손님','손님','')->>'balance')::bigint=0;
  BEGIN
    PERFORM public.manage_coupon_account(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','지체 손님','손님','다른지체',0,true);
    RAISE EXCEPTION '지체가 다르다는 이유로 손님 이름 중복 허용';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END; $$;
RESET ROLE;
SELECT set_config('test.uid','00000000-0000-0000-0000-000000000099',false);
SET ROLE authenticated;
DO $$ BEGIN
  BEGIN
    PERFORM public.manage_coupon_account(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','개척자','홍길동','',1000,false);
    RAISE EXCEPTION '다른 관리자 충전 허용';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.set_coupon_member_name((public.lookup_coupon_account('00000000-0000-0000-0000-000000000002','지체 손님','손님','')->>'id')::uuid,'잘못된수정');
    RAISE EXCEPTION '다른 관리자 지체 이름 수정 허용';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END; $$;
RESET ROLE;
SET ROLE anon;
DO $$
DECLARE r jsonb; req uuid; items jsonb; before_count int;
BEGIN
  SELECT id,payload INTO req,items FROM coupon_fixture;
  r:=public.submit_customer_order(req,'00000000-0000-0000-0000-000000000002','쿠폰테스트','쿠폰+현금',items,'개척자','홍길동','',4000,5000);
  ASSERT public.submit_customer_order(req,'00000000-0000-0000-0000-000000000002','쿠폰테스트','쿠폰+현금',items,'개척자','홍길동','',4000,5000)=r;
  ASSERT (public.lookup_coupon_account('00000000-0000-0000-0000-000000000002','개척자','홍길동','')->>'balance')::bigint=9000;
  -- 현금 초과 납부로 외부자 계정 생성.
  PERFORM public.submit_customer_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','외부자','현금',items,'외부자','새손님','',0,10000);
  ASSERT (public.lookup_coupon_account('00000000-0000-0000-0000-000000000002','외부자','새손님','')->>'balance')::bigint=4000;
  -- 외부자 적립액을 다음 주문에서 사용. 현금 빈값은 필요액을 수납.
  PERFORM public.submit_customer_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','외부자2','쿠폰+현금',items,'외부자','새손님','',4000,NULL);
  ASSERT (public.lookup_coupon_account('00000000-0000-0000-0000-000000000002','외부자','새손님','')->>'balance')::bigint=0;
  PERFORM public.submit_customer_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','지체표시','현금',items,'지체 손님','손님','잘못된클라이언트값',0,NULL);
  SELECT count(*) INTO before_count FROM public.orders;
  BEGIN
    PERFORM public.submit_customer_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','부족','쿠폰',items,'외부자','새손님','',6000,0);
    RAISE EXCEPTION '잔액 부족 접수';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.submit_customer_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','익명','현금',items,'외부자','','',0,10000);
    RAISE EXCEPTION '익명 적립 허용';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.submit_customer_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','부족현금','현금',items,'외부자','','',0,0);
    RAISE EXCEPTION '부족현금 허용';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  ASSERT (SELECT count(*) FROM public.orders)=before_count, '검증 실패 시 주문 롤백';
  BEGIN
    UPDATE public.coupon_accounts SET balance=999999;
    RAISE EXCEPTION '직접 잔액 변경 허용';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END; $$;
RESET ROLE;
DO $$ BEGIN
  ASSERT (SELECT coupon_credited FROM public.orders WHERE table_number='쿠폰테스트')=3000;
  ASSERT (SELECT member_name FROM public.orders WHERE table_number='지체표시')='홍지체';
  ASSERT (SELECT count(*) FROM public.coupon_transactions WHERE kind='사용')=2;
  ASSERT (SELECT count(*) FROM public.coupon_transactions WHERE kind='초과액 적립')=2;
  ASSERT (public.get_dashboard_totals('00000000-0000-0000-0000-000000000002')->>'couponUsed')::bigint=8000;
  ASSERT (public.get_dashboard_totals('00000000-0000-0000-0000-000000000002')->>'couponCredited')::bigint=7000;
  ASSERT (SELECT (t->>'cashReceived')::bigint-(t->>'cashDue')::bigint=7000
    AND (t->>'cashDue')::bigint+(t->>'couponUsed')::bigint=(t->>'totalRevenue')::bigint
    FROM (SELECT public.get_dashboard_totals('00000000-0000-0000-0000-000000000002') t) totals);
END; $$;
-- 원장 기록 실패는 신규 계정과 주문까지 모두 롤백해야 한다.
CREATE FUNCTION public.fail_coupon_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'injected ledger failure'; END; $$;
CREATE TRIGGER test_ledger_failure BEFORE INSERT ON public.coupon_transactions
FOR EACH ROW EXECUTE FUNCTION public.fail_coupon_ledger();
DO $$
DECLARE before_count int;
BEGIN
  SELECT count(*) INTO before_count FROM public.orders;
  BEGIN
    PERFORM public.submit_customer_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','실패테스트','현금',
      '[{"menu_id":"00000000-0000-0000-0000-000000000003","quantity":1,"unit_price":3000}]','외부자','롤백손님','',0,5000);
    RAISE EXCEPTION '실패가 발생하지 않음';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'injected ledger failure' THEN RAISE; END IF;
  END;
  ASSERT (SELECT count(*) FROM public.orders)=before_count;
  ASSERT NOT EXISTS(SELECT 1 FROM public.coupon_accounts WHERE customer_name='롤백손님');
END; $$;
ROLLBACK;
