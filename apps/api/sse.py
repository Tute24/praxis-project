"""Encoder SSE: um evento vira um frame no fio.

Mora aqui, fora de `agent/`, porque SSE e formato de TRANSPORTE: o port devolve
evento, o transporte decide como ele vira byte. Se o runner ja emitisse string
SSE, o fake dos testes herdaria HTTP sem precisar (issue #5).

`to_sse` e funcao pura `StreamEvent -> str`: testavel sem subir servidor e sem
gastar token. `frames` e o laco que a rota NAO faz (AC-01: "nao itera o
stream") -- ela recebe o iterador do port e entrega para ca inteiro.
"""

import json
import logging
from collections.abc import AsyncIterator

from langchain_core.load import dumpd
from langchain_core.runnables.schema import StreamEvent

log = logging.getLogger(__name__)


def to_sse(event: StreamEvent) -> str:
    """Serializa o StreamEvent INTEIRO como o `data` de um frame SSE (AC-05).

    `json.dumps` puro quebraria: o `data` carrega `AIMessageChunk` e
    `ToolMessage`. `dumpd` resolve e tem a propriedade que decide o desenho
    todo -- ele NUNCA levanta excecao, caindo em `to_json_not_implemented` para
    qualquer coisa nao serializavel, inclusive o `BaseException` de um
    `on_tool_error`. Isso elimina try/except por evento no meio do stream, que
    e o pior lugar possivel para estourar (issue #2, issue #5).

    Custo: as 7 chaves do topo saem planas, mas `data.chunk` e `data.output`
    vem no envelope LC `{"lc":1,"type":"constructor","id":[...],"kwargs":{...}}`
    -- o cliente le o conteudo dentro de `kwargs`.

    Cuidado: `dumpd` NAO e idempotente. Reserializar um envelope LC ja
    serializado o escapa como `{"__lc_escaped__": ...}`. Quem alimenta esta
    funcao com eventos lidos de volta do fio (a fixture) precisa reidratar
    antes, com `load(..., allowed_objects="messages")`.
    """
    payload = json.dumps(dumpd(event), ensure_ascii=False)
    return f"event: {event['event']}\ndata: {payload}\n\n"


async def frames(eventos: AsyncIterator[StreamEvent]) -> AsyncIterator[str]:
    """Consome a corrida e escreve o fio, do primeiro frame ao fechamento.

    `async def` obrigatorio: um generator sync faria o Starlette gastar um
    worker do threadpool por conexao, e nao teria checkpoint de cancelamento
    (issue #3).

    Erro DEPOIS do primeiro byte: os headers ja foram, entao nao da para virar
    500, e o AC-06 proibe inventar um `event: error`. Logar e fechar e o que
    sobra. O cliente distingue fim normal de morte pela ausencia do
    `on_chat_model_end` com finish_reason "stop" -- leitura do observador, como
    a latencia (CONTEXT.md: "Corrida completa" / "Stream morto").

    Nao ha hierarquia de AppError nem exception handler neste app de proposito:
    handler do FastAPI so age ANTES do primeiro byte, e todos os casos de la ja
    tem dono (corpo invalido -> 422 do Pydantic; chave ausente -> o app nao
    sobe). O unico caminho de erro real e justamente o que um handler nao
    alcanca (issue #5).

    `CancelledError` NAO cai aqui (e BaseException): disconnect e cancelamento
    normal, tratado pelo proprio `astream_events`, e nao deve ser engolido.
    """
    try:
        async for event in eventos:
            yield to_sse(event)
    except Exception:
        log.exception("corrida morreu no meio do stream")
