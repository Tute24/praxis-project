"""Grava a sequencia real de eventos de uma corrida como fixture (issue #4).

Le o SSE do jeito que o front vai ler - pelo fio, nao chamando o grafo direto -
para que a fixture seja exatamente o que chega no cliente.

Uso (com a API no ar em :8000):
    uv run python scripts/record_fixture.py "Qual o clima em Sao Paulo?"
"""

import asyncio
import json
import sys
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parents[3]
OUT = REPO_ROOT / "fixtures" / "events-clima-sao-paulo.json"
API = "http://127.0.0.1:8000/agent/execute"


def parse_frames(raw: str) -> list[dict]:
    """Quebra o corpo SSE bruto em {event, data}. Um frame por bloco em branco."""
    frames = []
    for block in raw.split("\n\n"):
        block = block.strip("\n")
        if not block:
            continue
        event = None
        data_lines = []
        for line in block.split("\n"):
            if line.startswith("event: "):
                event = line[len("event: ") :]
            elif line.startswith("data: "):
                data_lines.append(line[len("data: ") :])
        frames.append({"event": event, "data": json.loads("\n".join(data_lines))})
    return frames


async def main() -> None:
    message = sys.argv[1] if len(sys.argv) > 1 else "Qual o clima em Sao Paulo?"
    raw = ""
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream("POST", API, json={"message": message}) as response:
            response.raise_for_status()
            async for chunk in response.aiter_text():
                raw += chunk

    frames = parse_frames(raw)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {"message": message, "events": frames}, ensure_ascii=False, indent=2
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"{len(frames)} eventos -> {OUT}")
    for frame in frames:
        print(" ", frame["event"], "|", frame["data"].get("name"))


if __name__ == "__main__":
    asyncio.run(main())
