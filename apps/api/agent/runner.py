"""O port do agente: uma interface, duas implementacoes.

`AgentRunner` e o seam (issue #5). Ele expoe UM metodo e esconde grafo, tools,
modelo e os parametros do `astream_events`. A rota nao sabe nada disso.

Por que o tipo do LangChain aparece na assinatura: `StreamEvent` e um
`TypedDict` -- e *dado*, nao maquinario do fornecedor. O DIP existe para a rota
nao depender do *comportamento* do LangChain (compilar grafo, conhecer
`ToolNode`, passar `version="v2"`); depender da *forma do dado* e obrigatorio,
porque o contrato do projeto e que o fio carrega o evento cru (CONTEXT.md).
Traduzir para um tipo proprio e traduzir de volta pagaria duas conversoes para
chegar no mesmo byte. Ver docs/adr/0001-evento-cru-no-fio.md.
"""

from typing import AsyncIterator, Protocol

from langchain_core.runnables.schema import StreamEvent
from langgraph.graph.state import CompiledStateGraph

# AC-06: o filtro deixa passar on_chat_model_{start,stream,end} e
# on_tool_{start,end} -- e tambem `on_tool_error`, que tem root_type "tool"
# (issue #2). Ele casa com o prefixo `on_tool_*`, entao NAO viola o AC-06 e e
# contrato: o back nao filtra, o cliente ganha um renderer para ele (issue #5).
INCLUDE_TYPES = ["chat_model", "tool"]


class AgentRunner(Protocol):
    """Corre o agente e emite os eventos crus da corrida, em ordem."""

    def astream(self, message: str) -> AsyncIterator[StreamEvent]: ...


class LangGraphRunner:
    """O adapter real: corre um grafo compilado."""

    def __init__(self, graph: CompiledStateGraph) -> None:
        self._graph = graph

    def astream(self, message: str) -> AsyncIterator[StreamEvent]:
        # Nao e `async def`: o metodo devolve o async iterator, nao o aguarda.
        # `astream_events` ja roda o grafo num `create_task` com
        # `finally: task.cancel()` e usa `aclosing`, entao cancelamento no
        # disconnect esta tratado -- nao escrever cleanup manual (issue #3).
        return self._graph.astream_events(
            {"messages": [{"role": "user", "content": message}]},
            version="v2",  # so e valido dentro de astream_events (issue #2)
            include_types=INCLUDE_TYPES,
        )
