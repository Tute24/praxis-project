"""O encoder atravessado com dado VIVO.

A fixture nao serve aqui: ela foi gravada pelo fio, entao ja passou por `dumpd`,
e `dumpd` num dict plano devolve ele mesmo -- o teste passaria sem exercitar
nada. Objeto vivo construido a mao e o unico jeito (issue #5).
"""

import json

from langchain_core.messages import AIMessageChunk

from sse import to_sse


def _frame(raw: str) -> tuple[str, dict]:
    """Quebra um frame SSE de volta em (event, data) para poder asserir."""
    assert raw.endswith("\n\n")
    event_line, data_line = raw.rstrip("\n").split("\n")
    return event_line.removeprefix("event: "), json.loads(
        data_line.removeprefix("data: ")
    )


def test_serializa_objeto_do_langchain_que_json_dumps_nao_serializa():
    event = {
        "event": "on_chat_model_stream",
        "name": "ChatOpenAI",
        "run_id": "abc",
        "tags": [],
        "metadata": {},
        "data": {"chunk": AIMessageChunk(content="Paulo")},
        "parent_ids": [],
    }

    name, data = _frame(to_sse(event))

    assert name == "on_chat_model_stream"
    # As 7 chaves do topo saem PLANAS: o AC-05 pede o StreamEvent inteiro.
    assert data["run_id"] == "abc"
    assert data["event"] == "on_chat_model_stream"
    # So o objeto do LangChain vira envelope LC, e o conteudo mora em `kwargs`.
    assert data["data"]["chunk"]["lc"] == 1
    assert data["data"]["chunk"]["kwargs"]["content"] == "Paulo"


def test_excecao_no_data_nao_derruba_o_encoder():
    """A propriedade que decide o desenho todo: `dumpd` nunca levanta.

    E isso que torna `on_tool_error` (que carrega um BaseException no `data`)
    seguro de mandar pelo fio sem try/except por evento.
    """
    event = {
        "event": "on_tool_error",
        "name": "get_weather",
        "run_id": "abc",
        "tags": [],
        "metadata": {},
        "data": {"error": ValueError("cidade desconhecida")},
        "parent_ids": [],
    }

    name, data = _frame(to_sse(event))

    assert name == "on_tool_error"
    assert data["data"]["error"]  # serializou alguma coisa, e nao explodiu
