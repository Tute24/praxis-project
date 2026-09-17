/**
 * A corrida real gravada, lida do repo e tocada evento a evento.
 *
 * A fixture e a fonte da verdade do front (CONTEXT.md: "Fixture de eventos"):
 * ela deixa o reducer ser testado sem subir API, sem chave e sem gastar token.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { estadoInicial, fecharStream, reduzir, type Estado } from "@/corrida/steps";
import { desembrulhar, type Frame } from "@/transporte/sse";

const CAMINHO = fileURLToPath(
  new URL("../../../../fixtures/events-clima-sao-paulo.json", import.meta.url),
);

export const fixture: { message: string; events: Frame[] } = JSON.parse(
  readFileSync(CAMINHO, "utf-8"),
);

/**
 * A fixture nao gravou horario de chegada (ela e so `{event, data}`), entao o
 * teste simula um relogio. Os 5s da tool sao os do stub (issue #6); o resto sao
 * ordens de grandeza plausiveis. Isso e suficiente porque a latencia que o
 * AC-07 pinta e uma SUBTRACAO de chegadas -- o que importa e a diferenca.
 */
const PASSO_DO_RELOGIO: Record<string, number> = {
  on_chat_model_start: 120,
  on_chat_model_stream: 40,
  on_chat_model_end: 80,
  on_tool_start: 5,
  on_tool_end: 5000,
  on_tool_error: 5000,
};

/** Toca a fixture inteira (ou os `ate` primeiros frames) e devolve o estado final. */
export function tocar(ate = Number.POSITIVE_INFINITY): Estado {
  let estado = estadoInicial(fixture.message);
  let relogio = 0;
  for (const frame of fixture.events.slice(0, ate)) {
    relogio += PASSO_DO_RELOGIO[frame.event] ?? 50;
    estado = reduzir(estado, desembrulhar(frame.data, relogio));
  }
  return estado;
}

/** O mesmo, mas com o fio fechando depois: e assim que "morta" aparece. */
export const tocarEFechar = (ate = Number.POSITIVE_INFINITY): Estado => fecharStream(tocar(ate));

export const frameDoTipo = (tipo: string): Frame =>
  fixture.events.find((f) => f.event === tipo)!;
