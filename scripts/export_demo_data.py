"""Export catalog data and recorded assistant answers for the static GitHub Pages demo.

The static demo (frontend built with NEXT_PUBLIC_DEMO_MODE=1) has no backend. It reads
frontend/public/demo/data.json produced by this script from a locally running API + worker
in synthetic mode with the LLM disabled (the deterministic, grounded path).

    cd backend
    INTEGRATION_MODE=synthetic LLM_ENABLED=false .venv/bin/python -m uvicorn app.main:create_app --factory --port 8000
    INTEGRATION_MODE=synthetic LLM_ENABLED=false .venv/bin/python -m app.worker
    cd .. && backend/.venv/bin/python scripts/export_demo_data.py --base-url http://127.0.0.1:8000
"""
import argparse
import json
import shutil
import time
from pathlib import Path
from uuid import uuid4

import httpx

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "frontend" / "public" / "demo"

# Context-free prompts whose real backend answers are replayed verbatim in the demo.
RECORDED_PROMPTS = [
    "условия доставки",
    "как оплатить заказ?",
    "минимальная партия",
    "самовывоз",
    "возврат товара",
    "рассрочка",
    "delivery terms",
    "payment options",
    "жеткізу шарттары",
    "төлем қалай жасалады?",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--origin", default="http://127.0.0.1:3000")
    args = parser.parse_args()
    with httpx.Client(base_url=args.base_url.rstrip("/"), timeout=30) as client:
        def get(path, **params):
            while True:
                response = client.get(path, params=params or None)
                if response.status_code != 429:
                    break
                time.sleep(float(response.headers.get("retry-after", "5")))  # API rate limit per session
            response.raise_for_status()
            return response.json()["data"]

        session = client.post("/api/v1/session", headers={"Origin": args.origin})
        session.raise_for_status()
        headers = {"Origin": args.origin, "X-CSRF-Token": session.json()["data"]["csrf_token"]}

        def post(path, payload=None):
            response = client.post(path, headers={**headers, "Idempotency-Key": uuid4().hex},
                                   **({"json": payload} if payload is not None else {}))
            response.raise_for_status()
            return response.json()["data"]

        capabilities = get("/api/v1/capabilities")
        categories = get("/api/v1/catalog/categories")
        ids, page = [], 1
        while True:
            listing = get("/api/v1/catalog/products", page=page, page_size=24)
            ids.extend(item["id"] for item in listing["items"])
            if page >= listing["pages"]:
                break
            page += 1
        products = [get(f"/api/v1/products/{pid}") for pid in ids]
        alternatives = {}
        for pid in ids:
            result = get(f"/api/v1/products/{pid}/alternatives")
            alternatives[str(pid)] = {"ids": [item["id"] for item in result["items"]],
                                      "reasons": result.get("reasons", {}),
                                      "warnings": result.get("warnings", [])}

        recorded = {}
        for prompt in RECORDED_PROMPTS:
            conversation = post("/api/v1/conversations")
            turn = post(f"/api/v1/conversations/{conversation['id']}/turns",
                        {"text": prompt, "asset_ids": [], "language": "auto"})["turn"]
            deadline = time.monotonic() + 60
            while turn["status"] not in {"completed", "failed", "cancelled"} and time.monotonic() < deadline:
                time.sleep(0.5)
                turn = get(f"/api/v1/turns/{turn['id']}")
            if turn["status"] != "completed":
                raise SystemExit(f"Turn for {prompt!r} ended as {turn['status']}; is the worker running?")
            output = turn["output"]
            output["products"] = [item["id"] for item in output["products"]]
            recorded[prompt.casefold()] = output

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "data.json").write_text(json.dumps({
        "generated_at": int(time.time()), "capabilities": capabilities, "categories": categories,
        "products": products, "alternatives": alternatives, "recorded": recorded,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for folder, pattern in (("images", "*.svg"), ("certificates", "*.pdf")):
        target = OUT / folder
        target.mkdir(exist_ok=True)
        for source in (ROOT / "data" / "synthetic" / folder).glob(pattern):
            shutil.copy2(source, target / source.name)
    print(f"Exported {len(products)} products and {len(recorded)} recorded answers to {OUT}")


if __name__ == "__main__":
    main()
