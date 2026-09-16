"""A rota atravessada pelo seam, com a corrida real gravada.

`FakeRunner` e o segundo adapter do port -- e o que faz o seam ser real e nao
hipotetico. Sem token, sem rede, sem OPENAI_API_KEY.

Nota: `ASGITransport` nao roda o `lifespan`, entao `build_graph()` nunca e
chamado aqui. E de proposito: o teste prova que a rota so depende do port.

A fixture guarda os eventos JA passados por `dumpd` (foi gravada pelo fio), e
`dumpd` NAO e idempotente: reserializar um envelope LC o escapa como
`{"__lc_escaped__": ...}` (langchain-core 1.6.3, protecao contra payload LC
forjado). Entao o fake REIDRATA com `load` antes de emitir. Efeito colateral
bom: o round-trip `load -> dumpd` e exato, entao este teste tambem exercita o
encoder de verdade, e nao so o framing.
"""

import json
from pathlib import Path
from typing import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from langchain_core.load import load
from langchain_core.runnables.schema import StreamEvent

from main import app, get_runner

FIXTURE = Path(__file__).resolve().parents[3] / "fixtures/events-clima-sao-paulo.json"


@pytest.fixture
def anyio_backend():
    return "asyncio"


class FakeRunner:
    """Relê uma corrida gravada, evento por evento."""

    def __init__(self, events: list[StreamEvent]) -> None:
        self._events = events

    def astream(self, message: str) -> AsyncIterator[StreamEvent]:
        async def gen():
            for event in self._events:
                yield event

        return gen()


class DyingRunner:
    """Morre no meio da corrida, depois de ja ter emitido eventos."""

    def __init__(self, events: list[StreamEvent]) -> None:
        self._events = events

    def astream(self, message: str) -> AsyncIterator[StreamEvent]:
        async def gen():
            for event in self._events:
                yield event
            raise RuntimeError("o modelo caiu")

        return gen()


def _corrida_gravada() -> list[StreamEvent]:
    """A corrida real, reidratada de volta em objetos vivos do LangChain."""
    frames = json.loads(FIXTURE.read_text(encoding="utf-8"))["events"]
    # `allowed_objects="messages"`: so mensagens saem do JSON, nada mais.
    return [load(f["data"], allowed_objects="messages") for f in frames]


async def _post(message: str = "Qual o clima em Sao Paulo?") -> str:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/agent/execute", json={"message": message})
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        return response.text


def _tipos(raw: str) -> list[str]:
    return [
        line.removeprefix("event: ")
        for line in raw.split("\n")
        if line.startswith("event: ")
    ]


@pytest.mark.anyio
async def test_corrida_completa_sai_no_fio_na_ordem(anyio_backend):
    eventos = _corrida_gravada()
    app.dependency_overrides[get_runner] = lambda: FakeRunner(eventos)
    try:
        raw = await _post()
    finally:
        app.dependency_overrides.clear()

    tipos = _tipos(raw)
    assert len(tipos) == len(eventos)
    assert tipos[0] == "on_chat_model_start"
    # AC-03: a tool foi chamada no meio da corrida.
    assert "on_tool_start" in tipos and "on_tool_end" in tipos
    # AC-06: nenhum tipo fora do contrato -- nada de evento inventado.
    assert all(t.startswith(("on_chat_model_", "on_tool_")) for t in tipos)


@pytest.mark.anyio
async def test_corrida_completa_termina_com_finish_reason_stop(anyio_backend):
    """O sinal que o cliente usa para saber que a corrida acabou de verdade."""
    eventos = _corrida_gravada()
    app.dependency_overrides[get_runner] = lambda: FakeRunner(eventos)
    try:
        raw = await _post()
    finally:
        app.dependency_overrides.clear()

    ultimo = json.loads(raw.rstrip("\n").split("\n")[-1].removeprefix("data: "))
    assert ultimo["event"] == "on_chat_model_end"
    saida = ultimo["data"]["output"]["kwargs"]
    assert saida["response_metadata"]["finish_reason"] == "stop"


@pytest.mark.anyio
async def test_stream_morto_fecha_sem_o_end_final(anyio_backend):
    """Erro depois do primeiro byte: os eventos ja emitidos chegam, e o stream
    simplesmente acaba. Nenhum `event: error` -- o AC-06 proibe. O cliente
    conclui a morte pela AUSENCIA do fim normal."""
    eventos = _corrida_gravada()[:5]
    app.dependency_overrides[get_runner] = lambda: DyingRunner(eventos)
    try:
        raw = await _post()
    finally:
        app.dependency_overrides.clear()

    tipos = _tipos(raw)
    assert len(tipos) == 5
    assert all(t.startswith(("on_chat_model_", "on_tool_")) for t in tipos)
    assert "on_chat_model_end" not in tipos
