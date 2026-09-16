"""A casca HTTP: FastAPI, ciclo de vida do grafo, e a rota do AC-01.

Tudo que sabe o que e um grafo mora em `agent/`; tudo que sabe o que e um byte
SSE mora em `sse.py`. Este arquivo so liga os dois (issue #5).
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agent.graph import build_graph
from agent.runner import AgentRunner, LangGraphRunner
from sse import to_sse

# AC-09: o segredo vive no .env da RAIZ do repo, nao dentro de apps/api.
REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")

log = logging.getLogger(__name__)


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
    async def event_stream() -> AsyncIterator[str]:
        # `async def` obrigatorio: um generator sync faria o Starlette gastar um
        # worker do threadpool por conexao, e nao teria checkpoint de
        # cancelamento. Ver issue #3.
        try:
            async for event in runner.astream(body.message):
                yield to_sse(event)
        except Exception:
            # Erro DEPOIS do primeiro byte: os headers ja foram, entao nao da
            # para virar 500, e o AC-06 proibe inventar um `event: error`.
            # Logar e fechar e o que sobra. O cliente distingue fim normal de
            # morte pela ausencia do `on_chat_model_end` com
            # finish_reason "stop" -- leitura do observador, como a latencia
            # (CONTEXT.md: "Corrida completa" / "Stream morto").
            #
            # Nao ha hierarquia de AppError nem exception handler neste app de
            # proposito: handler do FastAPI so age ANTES do primeiro byte, e
            # todos os casos de la ja tem dono (corpo invalido -> 422 do
            # Pydantic; chave ausente -> o app nao sobe). O unico caminho de
            # erro real e justamente o que um handler nao alcanca (issue #5).
            log.exception("corrida morreu no meio do stream")
        # CancelledError NAO cai aqui (BaseException): disconnect e cancelamento
        # normal, tratado pelo proprio astream_events, e nao deve ser engolido.

    return StreamingResponse(event_stream(), media_type="text/event-stream")
