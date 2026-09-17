"""A casca HTTP: FastAPI, ciclo de vida do grafo, e a rota do AC-01.

Tudo que sabe o que e um grafo mora em `agent/`; tudo que sabe o que e um byte
SSE mora em `sse.py`. Este arquivo so liga os dois (issue #5).
"""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agent.graph import build_graph
from agent.runner import AgentRunner, LangGraphRunner
from sse import frames

# AC-09: o segredo vive no .env da RAIZ do repo, nao dentro de apps/api.
REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Constroi o grafo UMA vez, no start do processo.

    O grafo e construido uma vez e corrido muitas (CONTEXT.md), entao o lugar
    dele e aqui -- nao no import do modulo e muito menos por request. Construcao
    eager de proposito: se `OPENAI_API_KEY` faltar, o app nao sobe, em vez de
    falhar no primeiro request (issue #5).
    """
    app.state.runner = LangGraphRunner(build_graph())
    yield


app = FastAPI(title="Praxis P1 - agente de clima", lifespan=lifespan)

# O front roda em outra origem (:3000) e fala com a API DIRETO, sem proxy no
# meio, para o stream SSE aparecer cru no devtools -- que e metade do que este
# projeto existe para mostrar. O preco disso e CORS. Origem fixa em vez de "*"
# porque nao custa nada e "*" e um habito ruim de carregar para o proximo
# projeto (issue #7).
ORIGENS_DO_FRONT = os.getenv(
    "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGENS_DO_FRONT.split(","),
    allow_methods=["POST"],
    allow_headers=["content-type"],
)


def get_runner(request: Request) -> AgentRunner:
    """O seam por onde o teste entra: `app.dependency_overrides[get_runner]`."""
    return request.app.state.runner


class ExecuteRequest(BaseModel):
    message: str


@app.post("/agent/execute")
async def execute(
    body: ExecuteRequest,
    runner: Annotated[AgentRunner, Depends(get_runner)],
) -> StreamingResponse:
    """A rota chama o agente e devolve o fluxo -- e so isso (AC-01).

    Ela nao monta o grafo (quem monta e o `lifespan`) e nao itera o stream
    (quem itera e o `frames`, do transporte). O que sobra aqui e ligar um no
    outro: o iterador de eventos entra inteiro, sem passar por um laco.
    """
    return StreamingResponse(
        frames(runner.astream(body.message)),
        media_type="text/event-stream",
    )
