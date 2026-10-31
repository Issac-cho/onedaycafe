# OneDayCafe ☕

OneDayCafe는 물리적으로 공간이 분리된 동아리 일일카페, 푸드트럭, 팝업스토어 등에서 **주문-주방-서빙 간의 소통을 원활하게 하기 위한 실시간 웹 애플리케이션**입니다.

별도의 앱 설치 없이 웹 브라우저만으로 접속이 가능하며, 여러 팀(동아리)이 동시에 독립적으로 사용할 수 있는 SaaS(Multi-tenant) 아키텍처로 설계되었습니다.

## 🚀 주요 기능 (Features)

시스템은 역할에 따라 4가지 화면을 제공합니다.

1. **관리자 대시보드 (`/admin`)**
   - 회원가입 및 본인만의 매장(Store) 개설
   - 메뉴 카테고리, 가격, 담당 주방 구역 지정 및 등록
   - 메뉴 품절 및 숨김 처리 지원
   - **(New)** 직원 접속용 4자리 PIN 번호(보안) 설정 기능
   - **(New)** 실시간 매장 현황 모니터링 (총 누적 매출, 주문 건수, 조리/서빙 대기열 현황)

2. **주문 담당자 화면 (`/[store_id]/order`)**
   - 설정된 PIN 번호를 통한 안전한 직원 인증
   - 카테고리별 메뉴 확인 및 장바구니 담기
   - 테이블 번호 및 결제 방식(현금/쿠폰) 입력 후 주문 전송
   - 주문 전송 시 자동으로 고유 **주문번호** 발급 (손님 및 주방 공유용)

3. **주방 요리사 화면 (`/[store_id]/chef`)**
   - 설정된 PIN 번호를 통한 안전한 직원 인증
   - 주방 구역(예: 1구역 식사, 2구역 음료)별 주문 필터링
   - 새로고침 없이 실시간으로 대기 중인 주문 및 주문번호 확인 (Supabase Realtime)
   - 조리가 완료된 메뉴를 '조리 완료' 처리

4. **홀 서빙 담당자 화면 (`/[store_id]/server`)**
   - 설정된 PIN 번호를 통한 안전한 직원 인증
   - 주방에서 조리 완료된 메뉴들을 실시간으로 확인
   - 주문번호, 테이블 번호, 조리된 주방 구역 확인
   - 손님에게 요리 전달 후 '서빙 완료' 처리

## 🛠 기술 스택 (Tech Stack)

- **Frontend**: Next.js (App Router), React, TypeScript, Tailwind CSS, shadcn/ui
- **Backend & Database**: Supabase (PostgreSQL, Auth, Realtime)
- **Deployment**: Vercel (Recommended)

## 📦 설치 및 실행 방법 (Getting Started)

이 프로젝트를 로컬 환경에서 실행하거나 직접 호스팅하기 위한 가이드입니다.

### 1. 프로젝트 클론 및 패키지 설치
```bash
git clone https://github.com/your-username/onedaycafe.git
cd onedaycafe
npm install
```

### 2. Supabase 데이터베이스 세팅
이 프로젝트는 Supabase를 백엔드로 사용합니다.
1. [Supabase](https://supabase.com/)에 회원가입 후 새로운 프로젝트를 생성합니다.
2. 프로젝트 대시보드 좌측 메뉴에서 **SQL Editor**로 이동합니다.
3. 이 저장소에 포함된 `database_schema.sql` 파일의 전체 내용을 복사하여 SQL Editor에 붙여넣고 **Run(실행)** 버튼을 누릅니다.
   - *참고: 테이블 생성, PIN 번호 및 주문번호(주문 발급 고유번호) 컬럼, RLS 보안 정책, Realtime 구독 설정이 모두 자동으로 구성됩니다.*
4. **Authentication -> Providers -> Email** 설정에서 **Confirm email(이메일 인증)** 옵션을 꺼주시면(비활성화) 테스트와 가입이 훨씬 수월합니다.

### 3. 환경 변수 설정
프로젝트 루트 디렉토리에 `.env.local` 파일을 생성하고, Supabase 대시보드(Project Settings -> API)에서 얻은 값을 입력합니다.

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

### 4. 로컬 서버 실행
```bash
npm run dev
```
브라우저를 열고 [http://localhost:3000](http://localhost:3000)으로 접속하여 "새로운 매장 계정 만들기"를 통해 관리자 계정을 생성하고 테스트를 시작하세요!

### 기존 DB에 수량별 서빙 기능 적용

앱 업데이트 전에 Supabase SQL Editor에서 `migrations/20261030_served_quantity.sql`을 실행하세요.
기존 데이터를 보존하면서 서빙 수량 컬럼을 추가하며, 이미 서빙 완료된 항목은 전체 수량을 반영합니다.
그다음 앱을 배포하고 직원 화면을 새로고침하세요. 이 업데이트에 `database_schema.sql` 전체를 실행하면 안 됩니다.

### 기존 DB에 수량별 조리 기능 적용

수량별 서빙 SQL을 먼저 적용한 뒤 `migrations/20261030_cooked_quantity.sql`을 실행하세요.
기존 조리·서빙 완료 내역을 보존합니다. 조리 버튼을 한 번 누르면 한 개가 준비되며,
서빙 화면에서는 준비된 수량까지만 전달할 수 있습니다. SQL 적용 후 앱을 배포하고 모든 직원 화면을 새로고침하세요.

### 기존 DB에 원자적 주문 접수 적용

앱 업데이트 전에 Supabase SQL Editor에서 `migrations/20261030_atomic_orders.sql`을 실행하세요.
주문과 상세를 한 트랜잭션으로 저장하고, 같은 요청의 재시도는 기존 주문번호를 반환합니다.
매장별 동시 접수의 번호 발급도 직렬화합니다. 기존 주문 데이터는 보존됩니다.
접수 결과가 불명확할 때는 해당 탭을 유지하고 ‘접수 확인 / 재시도’를 사용하세요.
같은 탭의 새로고침 후에도 이어서 확인할 수 있습니다. 탭 종료·사이트 저장소 삭제 후에는 복원되지 않습니다.

검증: `node --test src/lib/*.test.mjs`.
PostgreSQL이 설치된 Windows에서는 `./tests/test-atomic-orders.ps1`로 격리된 임시 DB 검증을 실행할 수 있습니다.
이 스크립트는 운영 DB에 접속하지 않습니다.

### 기존 DB에 메뉴 소프트 삭제 적용

원자적 주문 접수 SQL을 먼저 적용한 뒤 `migrations/20261030_soft_delete_menus.sql`을 실행하세요.
메뉴 삭제는 관리·주문 목록에서만 제외하며, 진행 중인 주문과 과거 매출·CSV 내역은 유지됩니다.
주문 이력이 있는 메뉴의 물리 삭제도 DB에서 차단합니다. 이미 삭제된 과거 내역을 복구하는 작업은 포함하지 않습니다.
SQL 적용 후 앱을 배포하고 직원 화면을 새로고침하세요.

### 기존 DB에 전체 통계 집계 적용

수량별 조리·서빙 SQL 적용 후 `migrations/20261030_dashboard_totals.sql`을 실행하세요.
통계는 DB에서 전체 데이터를 집계하며 CSV는 500행씩 조회해 1,000행이 넘어도 모두 내려받습니다.
다운로드 버튼 옆 ⓘ를 누르면 안내를 볼 수 있습니다. 정확한 정산을 위해 주문·조리·서빙 작업을 중지한 뒤 다운로드하세요.
다운로드 시점의 스냅샷은 별도로 만들지 않습니다.

### 자동 리허설

노트북 한 대에서 주문 담당 6명·주방 7팀·서빙 1대를 API 작업자로 재현할 수 있습니다.
준비와 실행 방법은 [자동 리허설 안내](docs/rehearsal.md)를 참고하세요.

### 손님 정보·쿠폰 잔액·혼합 결제 적용

기존 원자적 주문·소프트 삭제·통계 SQL 적용 후 `migrations/20261031_customer_coupons.sql`을 Supabase SQL Editor에서 실행하고 앱을 배포하세요.
이어서 `migrations/20261031_guest_name_only.sql`을 실행하세요. 지체 손님도 손님 이름만으로 계정을 구분합니다.
기존 DB에서 초기화용 `database_schema.sql`을 실행하면 안 됩니다.
손님 유형·이름별 쿠폰 잔액, 관리자 추가 충전, 쿠폰/현금/혼합 결제, 초과 현금의 쿠폰 적립을 지원합니다.
미확인 주문을 먼저 해소하고 업데이트한 뒤 모든 직원 화면을 새로고침하세요.
자세한 정책과 적용 순서는 [손님·쿠폰 기획 및 적용 안내](docs/customer-coupon-plan.md)를 참고하세요.

## 📄 License
This project is licensed under the MIT License.
