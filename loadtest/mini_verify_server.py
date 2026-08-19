r"""
실제 verify 엔드포인트의 최소 재현 서버 (로컬 부하테스트용).

- DB(usage_daily_stats, captchas 등)·site_key 인증은 뺐다 (부하테스트 목적상 병목이 아니고,
  로컬에 MySQL을 새로 세팅하는 건 오버킬).
- 대신 진짜 EnsemblePredictor(같은 가중치, 같은 코드)를 그대로 물려서, "HTTP 요청 -> JSON
  파싱 -> 실제 모델 추론 -> JSON 응답"이라는 실제 verify 요청의 핵심 비용은 그대로 재현한다.
- 즉 이 결과는 "DB 왕복이 없는 상태의 순수 API 처리량 상한"으로 봐야 한다. 실제 운영에서는
  MySQL 쓰기(usage_daily_stats, captcha_verifications insert) 비용이 추가로 붙는다.

사용 전 준비:
  pip install fastapi uvicorn numpy scipy

실행 (이 폴더에서):
  set ENSEMBLE_ML_DIR=C:\Users\cdkem\OneDrive\바탕 화면\Sniperfactory\최종 프로젝트-AI CAPTCHA\ensemble_CNN_biLSTM\ml
  python -m uvicorn mini_verify_server:app --host 127.0.0.1 --port 8000
  (워커 여러 개로 수평 확장 흉내: --workers 4 처럼 옵션 추가)
"""
import os
import sys

# ensemble_CNN_biLSTM/ml 폴더 경로. 환경변수로 지정하지 않으면 실제 프로젝트 폴더 기본 위치를 씀.
_DEFAULT_ML_DIR = (
    r"C:\Users\cdkem\OneDrive\바탕 화면\Sniperfactory\최종 프로젝트-AI CAPTCHA"
    r"\ensemble_CNN_biLSTM\ml"
)
ML_DIR = os.environ.get("ENSEMBLE_ML_DIR", _DEFAULT_ML_DIR)

if not os.path.isdir(ML_DIR):
    raise SystemExit(
        f"ensemble_CNN_biLSTM/ml 폴더를 못 찾았습니다: {ML_DIR}\n"
        "환경변수 ENSEMBLE_ML_DIR에 실제 경로를 지정해서 다시 실행하세요.\n"
        r'예: set ENSEMBLE_ML_DIR=C:\실제\경로\ensemble_CNN_biLSTM\ml'
    )

sys.path.insert(0, ML_DIR)
os.chdir(ML_DIR)  # checkpoints/ensemble_checkpoint.pkl 같은 상대경로 로딩 때문에 필요

from fastapi import FastAPI
from pydantic import BaseModel
from typing import Any

from ensemble_predictor import EnsemblePredictor

app = FastAPI()
ens = EnsemblePredictor.from_checkpoint("checkpoints/ensemble_checkpoint.pkl")


class VerifyBody(BaseModel):
    record: dict[str, Any]


@app.post("/verify")
def verify(body: VerifyBody):
    result = ens.predict_record(body.record)
    return {"is_bot": result["is_bot"], "score": result["ensemble_bot_score"]}


@app.get("/health")
def health():
    return {"ok": True}
