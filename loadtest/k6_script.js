// 실제 운영/스테이징 verify 엔드포인트를 겨냥한 k6 부하테스트 스크립트.
// DB 왕복(usage_daily_stats, captchas insert 등)과 site_key 인증까지 전부 포함된
// "진짜" /challenge -> /verify 흐름을 그대로 재현한다.
//
// !! 실제 프로덕션(vlur.site)에 진짜 트래픽을 만드는 스크립트다 !!
//   - 호출마다 실제 DB에 행이 쌓이고(captchas, captcha_verifications), 사용량 집계(usage_daily_stats)에도
//     반영된다 — 요금제에 월 호출 한도가 있다면 그 한도를 갉아먹는다.
//   - 그래서 기본값은 5 VU · 15초짜리 작은 테스트로 맞춰뒀다. 규모를 키우기 전에 반드시 이 작은
//     테스트로 먼저 인증(Site Key/Origin)이 맞는지, 200이 오는지부터 확인할 것.
//   - 티켓팅 스파이크(수백 VU) 시나리오를 쓰려면 아래 SCENARIO=spike 환경변수로 명시적으로 켜야 한다.
//
// 실행 전 준비물:
//   1. 마이페이지 > API Key 관리에서 Site Key 발급 (X-Site-Key 헤더로 보냄)
//   2. 그 Site Key에 등록한 도메인과 아래 ORIGIN 값이 정확히 일치해야 한다. 서버가 Origin/Referer
//      헤더의 호스트명을 등록 도메인과 그대로 비교하기 때문에(backend/auth/site_key.py), 이게 안 맞으면
//      403(허용 도메인 불일치)이 난다. 테스트용으로는 등록 도메인을 "localhost"로 해두는 게 제일 간단.
//
// 실행 (작은 테스트, 기본값 — 먼저 이걸로):
//   $env:BASE_URL="https://vlur.site"
//   $env:SITE_KEY="실제_사이트키"
//   $env:ORIGIN="http://localhost"      # Site Key에 등록한 도메인과 맞출 것
//   k6 run k6_script.js
//
// 실행 (규모를 키운 스파이크 시나리오, 위 작은 테스트로 200 확인 후에만):
//   $env:SCENARIO="spike"
//   k6 run k6_script.js
//
// 실행 (동시성/시간 직접 지정, 작은 테스트 기본 시나리오에 한해 CLI로 덮어쓰기 가능):
//   k6 run --vus 20 --duration 30s k6_script.js

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "https://vlur.site"; // 스테이징/로컬로 바꿔서 사용
const SITE_KEY = __ENV.SITE_KEY || "여기에_실제_사이트키";
const ORIGIN = __ENV.ORIGIN || "http://localhost"; // Site Key에 등록한 도메인과 반드시 일치해야 함
const SCENARIO = __ENV.SCENARIO || "small";

const SCENARIOS = {
  // 기본값: 인증·기본 동작 확인용 소규모 테스트. 실제 DB에 몇십 건만 쌓인다.
  small: {
    smoke: {
      executor: "constant-vus",
      vus: 5,
      duration: "15s",
    },
  },
  // 명시적으로 SCENARIO=spike로 켰을 때만 사용하는 티켓팅 오픈 스파이크 재현.
  spike: {
    ticketing_spike: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 50 },   // 예매 오픈 직전 완만한 증가
        { duration: "5s", target: 300 },   // 오픈 순간 급격한 스파이크
        { duration: "20s", target: 300 },  // 스파이크 유지
        { duration: "10s", target: 0 },    // 감소
      ],
    },
  },
};

export const options = {
  scenarios: SCENARIOS[SCENARIO] || SCENARIOS.small,
  thresholds: {
    http_req_failed: ["rate<0.01"],     // 실패율 1% 미만 목표
    http_req_duration: ["p(95)<1000"],  // 95%가 1초 안에 응답
  },
};

export default function () {
  // 1) 챌린지 발급
  const challengeRes = http.post(
    `${BASE_URL}/api/v1/captcha/challenge`,
    JSON.stringify({ captcha_type: "type1_drag", theme_mode: "light" }),
    { headers: { "Content-Type": "application/json", "X-Site-Key": SITE_KEY, "Origin": ORIGIN } }
  );
  const challengeOk = check(challengeRes, { "challenge 200": (r) => r.status === 200 });
  if (!challengeOk) {
    // 첫 실행에서 401/403이 나면 대부분 Site Key 오타 또는 ORIGIN이 등록 도메인과 안 맞는 경우다.
    console.error(`challenge 실패: status=${challengeRes.status} body=${challengeRes.body}`);
    sleep(1);
    return;
  }
  const challenge = challengeRes.json();

  // 2) 검증 요청 — drag_trace는 실제 사람 드래그를 흉내 낸 최소 샘플.
  //    실제 부하테스트에서는 sample_records.json 같은 실제 궤적 데이터를 여러 개 섞어서 랜덤 선택하는 게
  //    모델 연산 비용(궤적 길이에 따라 달라짐)을 더 현실적으로 재현한다.
  const dragTrace = [];
  for (let t = 0; t <= 500; t += 20) {
    dragTrace.push({ x: 100 + t * 0.4, y: 100 + t * 0.2, t });
  }

  const verifyRes = http.post(
    `${BASE_URL}/api/v1/captcha/verify`,
    JSON.stringify({
      challenge_token: challenge.challenge_token,
      selected_option_id: challenge.options[0].option_id,
      drag_trace: dragTrace,
      pointer_type: "mouse",
      response_time_ms: 900,
    }),
    { headers: { "Content-Type": "application/json", "X-Site-Key": SITE_KEY, "Origin": ORIGIN } }
  );
  check(verifyRes, { "verify 200": (r) => r.status === 200 });

  sleep(Math.random() * 0.5);
}
