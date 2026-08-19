// 실제 운영/스테이징 verify 엔드포인트를 겨냥한 k6 부하테스트 스크립트.
// DB 왕복(usage_daily_stats, captchas insert 등)과 site_key 인증까지 전부 포함된
// "진짜" /challenge -> /verify 흐름을 그대로 재현한다.
//
// 실행 전 준비물:
//   1. 마이페이지 > API Key 관리에서 발급받은 Site Key (X-Site-Key 헤더 or 문서 확인해서 실제 헤더명 맞추기)
//   2. 등록된 도메인과 origin 헤더가 맞아야 CORS/검증 통과 (staging이면 localhost 등록해서 사용)
//
// 실행:
//   k6 run --vus 20 --duration 30s k6_script.js
//   (동시 사용자 수·시간은 필요에 맞게 --vus, --duration으로 조절)
//
// 참고: k6는 Go 런타임 기반이라 Locust(Python)보다 가상 사용자당 오버헤드가 훨씬 작다.
// 실제 티켓팅 오픈런처럼 "짧은 시간에 수천 VU가 동시에 몰리는" 시나리오를 재현하려면
// k6가 더 적합하고, ramping-vus 시나리오(아래 옵션 참고)로 순간 스파이크도 흉내낼 수 있다.

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "https://vlur.site"; // 스테이징/로컬로 바꿔서 사용
const SITE_KEY = __ENV.SITE_KEY || "여기에_실제_사이트키";

export const options = {
  // 고정 동시성 대신, 실제 티켓팅 오픈 순간처럼 짧게 스파이크를 주는 시나리오.
  // vus/duration을 CLI로 넘기면 이 scenarios 대신 그 값이 우선 적용된다.
  scenarios: {
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
    { headers: { "Content-Type": "application/json", "X-Site-Key": SITE_KEY } }
  );
  const challengeOk = check(challengeRes, { "challenge 200": (r) => r.status === 200 });
  if (!challengeOk) {
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
    { headers: { "Content-Type": "application/json", "X-Site-Key": SITE_KEY } }
  );
  check(verifyRes, { "verify 200": (r) => r.status === 200 });

  sleep(Math.random() * 0.5);
}
