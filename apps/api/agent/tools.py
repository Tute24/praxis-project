"""As tools que o agente pode chamar.

Nada aqui conhece HTTP. Essa e a regra de import do pacote `agent/` (issue #5):
se algum modulo daqui precisar de `fastapi`, o corte esta errado.
"""

import asyncio

from langchain_core.tools import tool


@tool
async def get_weather(city: str) -> dict:
    """Consulta o clima atual de uma cidade."""
    # `async def` + `asyncio.sleep`: os 2s do enunciado simulam I/O, e I/O
    # simulado nao pode bloquear o event loop (restricao transversal do mapa).
    await asyncio.sleep(2)
    return {"city": city, "temp_c": 22, "condition": "parcialmente nublado"}


TOOLS = [get_weather]
