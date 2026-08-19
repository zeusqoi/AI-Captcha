# 부하테스트

`검증 처리량 25~40건/초` 주장을 검증하기 위한 스크립트 모음.

## 준비

```
pip install fastapi uvicorn numpy scipy httpx
```

`ensemble_CNN_biLSTM/ml` 폴더 경로가 기본값(OneDrive의 실제 프로젝트 폴더)과 다르면 실행 전에:

```
set ENSEMBLE_ML_DIR=C:\실제\경로\ensemble_CNN_biLSTM\ml
```

## 로컬 서버로 빠르게 재현 (DB 없이, 검증 로직만)

```
python -m uvicorn mini_verify_server:app --host 127.0.0.1 --port 8000
```

다른 터미널에서:

```
python concurrent_http_loadtest.py
```

동시 사용자 1/10/20/40/80/160명 구간별 처리량·지연시간을 순서대로 찍어준다. 옵션으로 조절 가능:

```
python concurrent_http_loadtest.py --levels 1,50,100   # 동시성 레벨 직접 지정
python concurrent_http_loadtest.py --duration 10        # 레벨당 부하 시간(초)
python concurrent_http_loadtest.py --url http://127.0.0.1:8000/verify
```

`--workers`는 이 스크립트가 아니라 **서버(uvicorn) 쪽** 옵션이다. 워커 수를 늘려 수평 확장 효과를 보려면 서버를 내렸다 다시 띄워야 한다:

```
python -m uvicorn mini_verify_server:app --host 127.0.0.1 --port 8000 --workers 4
```

물리 코어 수(`python -c "import os; print(os.cpu_count())"`)를 넘겨서 워커를 늘려도 그 이상은 효과가 없다.

Locust로 같은 걸 하고 싶으면(`pip install locust` 후):

```
locust -f locustfile.py --host http://127.0.0.1:8000
```

브라우저에서 `http://localhost:8089` 열어서 동시 사용자 수·시간 입력 후 시작.

## 실제 운영 엔드포인트 (DB·인증 포함, k6)

k6는 [k6.io](https://k6.io/docs/get-started/installation/)에서 설치(Windows는 `winget install k6.k6`도 가능).

**주의**: 이건 실제 프로덕션(vlur.site)에 진짜 요청을 보내는 스크립트다. 호출마다 실제 DB에 행이 쌓이고 요금제 월 호출 한도도 소모된다. 그래서 기본 시나리오는 5 VU·15초짜리 작은 테스트로 맞춰뒀다 — 먼저 이걸로 인증이 맞는지부터 확인할 것.

준비물:
1. 마이페이지 > API Key 관리에서 Site Key 발급
2. 그 Site Key에 등록한 도메인을 확인 — 테스트 편하게 하려면 "localhost"로 등록해두기
3. `ORIGIN` 환경변수를 그 등록 도메인과 정확히 맞추기 (서버가 Origin/Referer 헤더로 도메인을 검증함, `backend/auth/site_key.py`)

```
$env:BASE_URL="https://vlur.site"
$env:SITE_KEY="실제_사이트키"
$env:ORIGIN="http://localhost"   # Site Key에 등록한 도메인과 일치해야 함
k6 run k6_script.js
```

`challenge 실패` 로그가 뜨면 대부분 Site Key 오타이거나 ORIGIN이 등록 도메인과 안 맞는 경우다 — 콘솔에 실제 status/body가 같이 출력된다.

작은 테스트로 200이 잘 나오는 걸 확인한 뒤에만, 티켓팅 오픈 스파이크(최대 300 VU) 시나리오를 명시적으로 켤 수 있다:

```
$env:SCENARIO="spike"
k6 run k6_script.js
```

## 참고 — 실측 결과 (2026-08-19)

DB 없이 순수 검증 로직만, HTTP 엔드포인트 기준:

| 환경 | 워커 수 | 처리량 상한 | 비고 |
|---|---|---|---|
| 샌드박스 | 1개 | 초당 20~35건 | 동시 요청을 늘려도 이 이상 안 늘고 지연시간만 증가 |
| 샌드박스 | 2개(=코어 수) | 초당 56~64건 | 워커 1개 대비 약 2배 (거의 선형 확장) |
| 실제 배포 대상 하드웨어 | 1개 | 초당 17.7~20.5건 | 동시 사용자 1~80명 전 구간에서 이 범위에 고정 — 하드웨어별 절대값은 다르지만 "프로세스 1개 상한" 현상은 동일하게 재현 |

DB 쓰기(usage_daily_stats, captcha_verifications insert)는 포함 안 된 수치라 실제 운영 상한은 이보다 낮을 수 있음 — k6로 실제 엔드포인트를 때려서 재검증 필요.