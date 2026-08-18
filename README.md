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

## 📄 License
This project is licensed under the MIT License.
