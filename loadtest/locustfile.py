"""
locust -f locustfile.py --headless -u <동시사용자수> -r <초당 spawn> -t <시간> --host http://127.0.0.1:8000
로 실행. sample_records.json(실제 사람 드래그 레코드 100건)에서 매 요청마다 하나씩 뽑아 POST.
"""
import json
import random

from locust import HttpUser, task, between

with open("sample_records.json", encoding="utf-8") as f:
    RECORDS = json.load(f)


class VerifyUser(HttpUser):
    wait_time = between(0, 0)  # 사용자 사이 텀 없이 최대 부하

    @task
    def verify(self):
        rec = random.choice(RECORDS)
        self.client.post("/verify", json={"record": rec})
