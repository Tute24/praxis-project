"""Gera o demo single-file: injeta a fixture real dentro do template.

    python prototypes/front-steps-reducer/build.py

Saida: demo.html, que abre com duplo clique (sem servidor, sem fetch --
file:// bloquearia a leitura do JSON de fora).
"""

import json
from pathlib import Path

AQUI = Path(__file__).resolve().parent
FIXTURE = AQUI.parents[1] / "fixtures" / "events-clima-sao-paulo.json"

template = (AQUI / "template.html").read_text(encoding="utf-8")
fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
saida = template.replace("__FIXTURE__", json.dumps(fixture, ensure_ascii=False))
(AQUI / "demo.html").write_text(saida, encoding="utf-8")
print(f"demo.html gerado com {len(fixture['events'])} eventos")
