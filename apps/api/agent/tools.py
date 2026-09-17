"""As tools que o agente pode chamar.

Nada aqui conhece HTTP. Essa e a regra de import do pacote `agent/` (issue #5):
se algum modulo daqui precisar de `fastapi`, o corte esta errado.
"""

import asyncio

from langchain_core.tools import tool


@tool
async def get_weather(city: str) -> dict:
    """Consulta o clima atual de uma cidade."""
    # `async def` + `asyncio.sleep`: a espera simula I/O, e I/O simulado nao
    # pode bloquear o event loop (restricao transversal do mapa). O enunciado
    # pede 2s; subimos para 5s a pedido do Arthur, para o feedback de tool
    # rodando (AC-07) dar tempo de ser visto na tela (issue #6).
    await asyncio.sleep(5)
    return {"city": city, "temp_c": 22, "condition": "parcialmente nublado"}


TOOLS = [get_weather]
