"""Constroi o grafo: modelo <-> tool <-> modelo.

Vocabulario do CONTEXT.md: o grafo e *construido* uma vez e *corrido* muitas.
Este modulo so sabe construir. Quem corre e o runner.

`build_graph()` e funcao, nao modulo com efeito colateral: instanciar o
`ChatOpenAI` no import exigiria `OPENAI_API_KEY` so para importar o arquivo, e
nenhum teste conseguiria nem `import` sem segredo no ambiente (issue #5).
"""

from typing import Annotated

from langchain_openai import ChatOpenAI
from langgraph.graph import START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.graph.state import CompiledStateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from typing_extensions import TypedDict

from .tools import TOOLS

MODEL = "gpt-4o-mini"


class State(TypedDict):
    messages: Annotated[list, add_messages]


def build_graph() -> CompiledStateGraph:
    # streaming=True e redundante dentro de astream_events (o handler de eventos
    # ja liga o streaming sozinho), mas deixa a intencao explicita. Ver issue #2.
    llm = ChatOpenAI(model=MODEL, temperature=0, streaming=True)
    llm_with_tools = llm.bind_tools(TOOLS)

    async def chatbot(state: State) -> dict:
        return {"messages": [await llm_with_tools.ainvoke(state["messages"])]}

    builder = StateGraph(State)
    builder.add_node("chatbot", chatbot)
    # O no PRECISA se chamar "tools": e a string literal que `tools_condition`
    # devolve como destino.
    builder.add_node("tools", ToolNode(TOOLS))
    builder.add_edge(START, "chatbot")
    builder.add_conditional_edges("chatbot", tools_condition)  # -> "tools" ou END
    builder.add_edge("tools", "chatbot")  # ida e volta
    return builder.compile()
