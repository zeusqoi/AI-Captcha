"""
locust/k6이 sandbox 패키지 충돌(system zope 패키지가 gevent 네임스페이스를 깨뜨림)로
못 돌아가서, 개념적으로 동일한(동시 가상 사용자 -> 실제 HTTP 엔드포인트 -> 응답시간/처리량
집계) 부하테스트를 표준 라이브러리 스레드풀 + httpx로 재현.

사용법:
  python concurrent_http_loadtest.py                     # 기본 동시성 레벨(1,10,20,40,80,160)
  python concurrent_http_loadtest.py --levels 1,50,100    # 원하는 레벨 직접 지정
  python concurrent_http_loadtest.py --duration 10        # 레벨당 부하 시간(초) 조절
  python concurrent_http_loadtest.py --url http://127.0.0.1:8000/verify
"""
import argparse
import json
import time
import random
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx

with open("sample_records.json", encoding="utf-8") as f:
    RECORDS = json.load(f)


def worker(client, url, stop_at, latencies, errors):
    while time.perf_counter() < stop_at:
        rec = random.choice(RECORDS)
        t0 = time.perf_counter()
        try:
            r = client.post(url, json={"record": rec}, timeout=15.0)
            r.raise_for_status()
            latencies.append(time.perf_counter() - t0)
        except Exception as e:
            errors.append(str(e))


def run(concurrency, url, duration_sec):
    stop_at = time.perf_counter() + duration_sec
    latencies = []
    errors = []
    with httpx.Client() as client:
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futs = [pool.submit(worker, client, url, stop_at, latencies, errors) for _ in range(concurrency)]
            for f in as_completed(futs):
                f.result()
    total = len(latencies) + len(errors)
    rps = len(latencies) / duration_sec
    p50 = statistics.median(latencies) * 1000 if latencies else float("nan")
    p95 = (statistics.quantiles(latencies, n=20)[18] * 1000) if len(latencies) >= 20 else max(latencies, default=0) * 1000
    print(f"동시 가상 사용자 {concurrency:>3}명 | 성공 {len(latencies):>5}건 | 오류 {len(errors):>3}건 | "
          f"처리량 {rps:>6.1f} req/s | p50 {p50:>6.1f}ms | p95 {p95:>6.1f}ms")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--levels", default="1,10,20,40,80,160",
                         help="쉼표로 구분한 동시 가상 사용자 수 목록")
    parser.add_argument("--duration", type=float, default=15,
                         help="레벨당 부하를 거는 시간(초)")
    parser.add_argument("--url", default="http://127.0.0.1:8000/verify")
    args = parser.parse_args()

    levels = [int(x) for x in args.levels.split(",")]
    print(f"각 동시성 레벨마다 {args.duration:.0f}초씩 부하를 건다. (대상: {args.url})\n")
    for c in levels:
        run(c, args.url, args.duration)
