# EKT Catalog & AI Shopping Assistant

**HACKALEM AI 2026 · team Hahathon Devs** — a storefront and chat assistant for an electrical-goods e-shop (the [ekt.kz](https://ekt.kz/) case).

**[Live demo →](https://goslinuly.github.io/hackalem-ekt-assistant/)** (static build, no backend or LLM; see [Demo mode](#live-demo-github-pages))

![Storefront](docs/screenshots/storefront.png)

## Problem

Customers of an electrical-goods store keep asking the same questions in chat or by phone: specifications for an article number, price and stock, a certificate, a replacement for an out-of-stock item, delivery and payment terms. Each answer means a manager looking up data that already exists in the catalog. While the customer waits, they compare prices elsewhere.

An LLM chatbot alone is risky here: it can invent a price, claim stock that does not exist, or add something to the cart the customer never approved.

## Solution

A storefront and an assistant that read **the same catalog source**, with the model kept away from facts and cart writes:

- **The model plans, the server answers.** The LLM (OpenAI Responses API, strict JSON plan) only picks the intent, product IDs from server-provided candidates, and search queries. Prices, stock, specifications, certificates and links are filled in by the server from the catalog. Product IDs the model invents are rejected.
- **Works without an LLM.** With the model disabled, a deterministic path still handles article lookup, search, analogs, purchase terms and cart proposals.
- **Analogs with an explanation.** For an out-of-stock item the server compares specifications within the category, drops candidates with contradicting data and explains every difference ("6 kA instead of 4.5 kA").
- **Cart only after explicit consent.** The assistant creates a *proposal*; the cart changes only after a button click or a standalone "yes, add". On confirmation the server rechecks price, stock, expiry, cart version and uses idempotency keys, so a retry never adds twice.
- **Attachments.** TXT, CSV, XLSX, DOCX, PDF, JPG/PNG specifications: type/size/structure checks, antivirus scan, isolated parser process, then every line is searched in the catalog. Photos and scans go to a vision model only with the customer's consent.
- **Three languages.** Russian, Kazakh and English; purchase terms are translated and checked against the source.
- **Security basics.** httpOnly session cookie, CSRF token and Origin check on every write, per-session rate limits, all data scoped to the session, payment card data rejected at input, API keys never reach the browser (Next.js server-side proxy).

| Assistant: lookup + analogs for an out-of-stock item | Assistant: cart proposal awaiting confirmation |
|---|---|
| ![Analogs](docs/screenshots/assistant-analogs.png) | ![Cart proposal](docs/screenshots/assistant-cart-proposal.png) |

![Catalog](docs/screenshots/catalog.png)

## Architecture

```mermaid
flowchart LR
  Browser["Storefront + chat<br/>(Next.js / React)"] --> Proxy["Next.js server proxy<br/>(no keys in browser)"]
  Proxy --> API["FastAPI<br/>sessions · CSRF · contracts"]
  API --> State[("SQLite<br/>sessions · turn queue · demo cart")]
  State --> Worker["Worker process<br/>(lease + timeouts)"]
  Worker --> Assistant["Grounded assistant<br/>orchestrator"]
  Assistant -. "JSON plan only" .-> LLM["OpenAI Responses API<br/>(optional)"]
  Assistant --> Catalog["Catalog port"]
  API --> Catalog
  Catalog --> PG[("PostgreSQL + pg_trgm<br/>EKT catalog")]
  Catalog --> Demo[("SQLite<br/>synthetic catalog")]
  Assistant --> Actions["Proposal → confirm<br/>(idempotent)"]
  Actions --> State
  API --> Files["Private uploads<br/>scanner + isolated parser"]
  Files --> Assistant
```

- API and worker run as separate processes; chat turns are persisted, leased and time-limited, so a slow model never blocks the storefront.
- Domain logic (catalog quality, search, analogs, actions, assistant) is separated from storage and providers by ports; the catalog source (`synthetic` SQLite or `catalog_db` PostgreSQL) and the LLM provider are swappable.
- Hybrid search: trigram/lexical search plus optional embeddings with reciprocal-rank fusion; query normalization for how customers write ("16 ампер" → "16А").

More: [architecture](docs/architecture.md) · [integration & layers](docs/backend-integration.md) · [domain contracts](docs/contracts.md) · [external EKT API](docs/api.md) · [data & DB](docs/data-and-db.md) · [assistant testing](docs/assistant-testing.md) · [OpenAPI](docs/openapi.json)

## Tech stack

| Layer | Technologies |
|---|---|
| Frontend | Next.js 15, React 19, TypeScript 5.9, plain CSS |
| Backend | Python 3.11+, FastAPI, Pydantic v2, Uvicorn, HTTPX |
| Data | PostgreSQL 14+ with `pg_trgm` (psycopg 3), SQLite for sessions/queue/demo |
| AI | OpenAI Responses API (structured JSON plan), optional NVIDIA/OpenAI OCR and embeddings, Anthropic provider adapter |
| Documents | pypdf, pypdfium2, openpyxl, python-docx, Pillow; ClamAV / Microsoft Defender as scanner |
| Testing | pytest (246 tests), Node test runner for the proxy, GitHub Actions |

## Run locally

Requirements: Python 3.11+, Node.js 22+. No keys, Docker or database needed for the default `synthetic` mode (281 demo products).

```bash
git clone https://github.com/Goslinuly/hackalem-ekt-assistant.git
cd hackalem-ekt-assistant
cp .env.example .env
cp frontend/.env.example frontend/.env.local

python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.lock -e './backend[dev]'
(cd frontend && npm ci)
```

Start three processes (each in its own terminal, from the repo root):

```bash
# 1. API  → http://127.0.0.1:8000/docs
cd backend && .venv/bin/python -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000
# 2. Worker (processes chat turns)
cd backend && .venv/bin/python -m app.worker
# 3. Frontend → http://127.0.0.1:3000
cd frontend && npm run dev
```

Try in the chat: `990100003_`, then `характеристики`; `990100015_` (out of stock → analogs); `условия доставки`; `Купить 990100003_ 2 шт`, then confirm.

Optional:

- **LLM:** set `LLM_API_KEY`, `LLM_ENABLED=true`, `LLM_DATA_POLICY_ACCEPTED=true` in `.env` (see `.env.example` for model and token budgets).
- **PostgreSQL catalog:** `INTEGRATION_MODE=catalog_db` and `DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/ekt`; an empty DB is migrated and seeded on start, a ready dump is in `data/db/ekt_catalog.sql` ([guide](data/db/README.md)).
- **File uploads:** require a real antivirus: `UPLOADS_ENABLED=true`, `SCANNER_COMMAND=["clamscan","--no-summary"]`. Ten test files with expected results are in [`test-files/`](test-files/README.md).

Full step-by-step guide (Windows/macOS/Linux, all env variables, troubleshooting) in Russian: [docs/setup-ru.md](docs/setup-ru.md).

### Tests

```bash
cd backend && .venv/bin/python -m pytest          # PostgreSQL tests run only with TEST_DATABASE_URL
cd frontend && npm run typecheck && npm run test:proxy && npm run build
backend/.venv/bin/python scripts/smoke_test.py   # end-to-end over HTTP with all three processes running
```

## Live demo (GitHub Pages)

**https://goslinuly.github.io/hackalem-ekt-assistant/**

> **Demo mode — responses are pre-recorded / mocked.** The Pages build has no backend and no LLM. The catalog (281 sample products), analogs and purchase-terms answers were exported from the real backend by [`scripts/export_demo_data.py`](scripts/export_demo_data.py); other chat turns are answered by a deterministic in-browser port of the backend's no-LLM path ([`frontend/src/lib/demo-backend.ts`](frontend/src/lib/demo-backend.ts)). The cart lives in session storage. File upload is disabled.

Build it yourself: `cd frontend && NEXT_PUBLIC_BASE_PATH=/hackalem-ekt-assistant npm run build:demo` → static site in `frontend/out`. Deployed by [`.github/workflows/pages.yml`](.github/workflows/pages.yml).

## Data

- `data/synthetic/ekt_products.json` — 281 demo cards: 68 fully synthetic, 213 based on names, images and specifications from the public ekt.kz catalog. **All IDs, article numbers, prices and stock are demo values**; certificates in `data/synthetic/certificates/` are fake PDFs marked as such.
- `data/curated/purchase_terms.json` — purchase terms collected from public ekt.kz pages with source URLs.
- The real EKT API (HTTP Basic Auth) is used only through env credentials, which are not part of this repository.

## Hackathon context

Built at **HACKALEM AI 2026** (September 2026) by team **Hahathon Devs** for the ekt.kz case: an AI assistant for the store's website chat that answers questions about articles, stock and analogs, explains purchase terms and assembles a cart only with explicit customer confirmation. Out of scope for the prototype: real checkout on ekt.kz (no cart API was provided), payments, B2B accounts and hand-off to a manager. The pitch deck is in [`presentation/`](presentation/ekt-assistant.pptx).

Author: Nursultan Dauletkan ([github.com/Goslinuly](https://github.com/Goslinuly)), as part of team Hahathon Devs.

## Русский

**ЭКТ — каталог и ИИ-ассистент.** Прототип команды Hahathon Devs (HACKALEM AI 2026) для сайта ekt.kz: витрина и чат-помощник на одном источнике каталога. Модель только определяет намерение и выбирает товары из найденных сервером кандидатов; цену, остаток, характеристики и ссылки подставляет сервер. Аналоги для отсутствующих товаров подбираются сравнением характеристик с объяснением отличий, корзина меняется только после явного подтверждения клиента. Поддерживаются вложения (Excel, Word, PDF, фото) и три языка: русский, казахский, английский.

Демо: https://goslinuly.github.io/hackalem-ekt-assistant/ (статическая сборка, ответы записаны заранее или формируются детерминированно в браузере). Подробная инструкция по запуску: [docs/setup-ru.md](docs/setup-ru.md).

## License

[MIT](LICENSE)
