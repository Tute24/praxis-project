"""Esqueleto vertical do P1: POST /agent/execute -> eventos crus em SSE.

Deliberadamente burro e acoplado (issue #4): grafo montado inline, rota iterando
o stream, tudo num arquivo so. O objetivo aqui e ver o dado verdadeiro sair no
`curl -N`; a separacao de responsabilidades e o proximo ticket.
"""

import asyncio
import json
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from langchain_core.load import dumpd
from langchain_core.runnables.schema import StreamEvent
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition
from pydantic import BaseModel
from typing_extensions import TypedDict

# AC-09: o segredo vive no .env da RAIZ do repo, nao dentro de apps/api.
REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")


# --- AC-03: a tool -----------------------------------------------------------


@tool
async def get_weather(city: str) -> dict:
    """Consulta o clima atual de uma cidade."""
    # `async def` + `asyncio.sleep`: os 2s do enunciado simulam I/O, e I/O
    # simulado nao pode bloquear o event loop (restricao transversal do mapa).
    await asyncio.sleep(2)
    return {"city": city, "temp_c": 22, "condition": "parcialmente nublado"}


TOOLS = [get_weather]


# --- AC-03: o grafo ----------------------------------------------------------


class State(TypedDict):
    messages: Annotated[list, add_messages]


# streaming=True e redundante dentro de astream_events (o handler de eventos ja
# liga o streaming sozinho), mas deixa a intencao explicita. Ver issue #2.
llm = ChatOpenAI(model="gpt-4o-mini", temperature=0, streaming=True)
llm_with_tools = llm.bind_tools(TOOLS)


async def chatbot(state: State) -> dict:
    return {"messages": [await llm_with_tools.ainvoke(state["messages"])]}


builder = StateGraph(State)
builder.add_node("chatbot", chatbot)
# O no PRECISA se chamar "tools": e a string literal que `tools_condition` devolve.
builder.add_node("tools", ToolNode(TOOLS))
builder.add_edge(START, "chatbot")
builder.add_conditional_edges("chatbot", tools_condition)  # -> "tools" ou END
builder.add_edge("tools", "chatbot")  # ida e volta
graph = builder.compile()


# --- AC-01 / AC-04 / AC-05: HTTP + stream + SSE ------------------------------


app = FastAPI(title="Praxis P1 - agente de clima")


class ExecuteRequest(BaseModel):
    message: str


def to_sse(event: StreamEvent) -> str:
    """Um StreamEvent vira um frame SSE.

    AC-05: `event:` e o campo `event` do StreamEvent; `data:` e o StreamEvent
    INTEIRO serializado. `json.dumps` puro quebraria aqui (o `data` carrega
    AIMessageChunk / ToolMessage), entao passa por `dumpd` antes. Ver issue #2.
    """
    payload = json.dumps(dumpd(event), ensure_ascii=False)
    return f"event: {event['event']}\ndata: {payload}\n\n"


@app.post("/agent/execute")
async def execute(request: ExecuteRequest) -> StreamingResponse:
    async def event_stream():
        # `async def` obrigatorio: um generator sync faria o Starlette gastar um
        # worker do threadpool por conexao, e nao teria checkpoint de
        # cancelamento. Ver issue #3.
        async for event in graph.astream_events(
            {"messages": [{"role": "user", "content": request.message}]},
            version="v2",
            include_types=["chat_model", "tool"],
        ):
            yield to_sse(event)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
