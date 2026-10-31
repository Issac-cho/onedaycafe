\encoding UTF8
\set ON_ERROR_STOP on
SELECT set_config('test.uid','00000000-0000-0000-0000-000000000001',false);
SELECT set_config('test.mode', :'mode', false), set_config('test.request_id', :'request_id', false);
DO $$
DECLARE req uuid:=current_setting('test.request_id')::uuid;
  items jsonb:='[{"menu_id":"00000000-0000-0000-0000-000000000003","quantity":1,"unit_price":3000}]';
BEGIN
  CASE current_setting('test.mode')
    WHEN 'spend' THEN
      BEGIN
        PERFORM public.submit_customer_order(req,'00000000-0000-0000-0000-000000000002','동시차감','쿠폰',items,'개척자','동시테스트','',3000,0);
      EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM NOT LIKE '%잔액이 부족%' THEN RAISE; END IF;
      END;
    WHEN 'charge' THEN
      PERFORM public.manage_coupon_account(req,'00000000-0000-0000-0000-000000000002','개척자','동시테스트','',1000,false);
    WHEN 'credit' THEN
      PERFORM public.submit_customer_order(req,'00000000-0000-0000-0000-000000000002','동시적립','현금',items,'외부자','동시생성','',0,4000);
  END CASE;
END; $$;
