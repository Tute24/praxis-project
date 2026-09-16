"""Encoder SSE: um evento vira um frame no fio.

Mora aqui, fora de `agent/`, porque SSE e formato de TRANSPORTE: o port devolve
evento, o transporte decide como ele vira byte. Se o runner ja emitisse string
SSE, o fake dos testes herdaria HTTP sem precisar (issue #5).

Funcao pura `StreamEvent -> str`: testavel sem subir servidor e sem gastar token.
"""

import json

from langchain_core.load import dumpd
from langchain_core.runnables.schema import StreamEvent


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
