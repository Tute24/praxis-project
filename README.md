# Praxis P1 — agente de clima com streaming SSE

Um agente LangGraph com uma única tool de clima, exposto por uma API que transmite a execução em
tempo real, e um chat que pinta essa execução conforme ela acontece.

```
apps/api   FastAPI + LangGraph. POST /agent/execute devolve text/event-stream.
apps/web   Next.js (App Router). Lê o stream e pinta a corrida evento a evento.
fixtures/  Uma corrida real gravada do fio. É a entrada dos testes do front.
docs/      CONTEXT.md (glossário), docs/adr/ (decisões), docs/research/ (leituras).
```

## Antes de tudo: o segredo

O `OPENAI_API_KEY` vive no `.env` da **raiz** do repo (AC-09), que é gitignored.

```bash
cp .env.example .env
# edite o .env e ponha a sua chave
```

A API lê esse arquivo na subida. Se a chave faltar, o app **não sobe** — o grafo é construído no
`lifespan`, de propósito, para a falha aparecer no start e não no primeiro request.

## Subir a API

Precisa do [uv](https://docs.astral.sh/uv/). Ele resolve o Python e as dependências sozinho.

```bash
cd apps/api
uv run uvicorn main:app --reload --port 8000
```

Dá para conferir o stream sem front nenhum:

```bash
curl -N -X POST http://127.0.0.1:8000/agent/execute \
  -H "content-type: application/json" \
  -d '{"message":"Qual o clima em São Paulo?"}'
```

Cada frame sai como `event: <tipo>` + `data: <o StreamEvent inteiro>` (AC-05).

## Subir o front

Precisa do Node 20+.

```bash
cd apps/web
npm install
npm run dev
```

Abre em <http://localhost:3000>. Ele fala com a API **direto** (sem proxy), para o stream aparecer
cru no devtools. Se a API estiver em outro lugar:

```bash
cp .env.example .env.local   # dentro de apps/web
# NEXT_PUBLIC_API_URL=http://127.0.0.1:8000
```

A API já libera `localhost:3000` no CORS; para outra origem, passe `CORS_ORIGINS` no ambiente dela.

## Testes

```bash
cd apps/api && uv run pytest    # rota, encoder SSE
cd apps/web && npm test         # reducer dos steps, borda do transporte
```

Nenhum deles chama o modelo nem precisa de chave: os dois correm contra a corrida gravada em
`fixtures/`.

## Como ler o código

O caminho curto, na ordem em que um evento viaja:

1. `apps/api/agent/graph.py` — o grafo: modelo, `ToolNode`, ida e volta (AC-03).
2. `apps/api/agent/runner.py` — o port do agente. É ele que chama `astream_events(version="v2")`
   (AC-02, AC-04); HTTP não aparece aqui.
3. `apps/api/sse.py` — o evento vira um frame no fio (AC-05).
4. `apps/api/main.py` — a rota. Ela só liga os dois: não monta grafo e não itera o stream (AC-01).
5. `apps/web/src/transporte/sse.ts` — a borda do cliente: `fetch` + `ReadableStream`, parser SSE e o
   desembrulho do envelope do LangChain.
6. `apps/web/src/corrida/steps.ts` — o reducer puro: a corrida vira uma lista de steps tipados, com
   dispatch por tipo e erro no tipo desconhecido (AC-06, AC-07).
7. `apps/web/src/ui/` — a tela. Um renderer por aparência; a aparência é **derivada** do estado.

Por que as coisas estão onde estão: `CONTEXT.md` para o vocabulário e `docs/adr/` para as decisões.
