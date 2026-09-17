/**
 * Leituras DERIVADAS do estado: o que a tela pergunta, nao o que o reducer guarda.
 *
 * Nenhum evento diz "mostre o spinner". Se a aparencia fosse um campo no estado,
 * o reducer precisaria conhecer a tela -- por isso ela e calculada aqui, a
 * partir do que ja esta guardado (issue #6).
 */

import type { Estado, Step, StatusDaCorrida, StepDeResultado } from "./steps";

export type Aparencia =
  | "pensando"
  | "pensou"
  | "streamando"
  | "final"
  | "rodando"
  | "chamada"
  | "resultado"
  | "erro"
  | "interrompido";

/**
 * A ponte entre o estado e o feedback visual do AC-07. As tres caras:
 *   pensando   -> spinner "Pensando" (a passada 1, que nao produz texto nenhum)
 *   rodando    -> barra crescendo (a chamada de tool ainda aberta)
 *   streamando -> texto aparecendo token a token (a passada 2)
 * Um stream morto congela o que estava em movimento: vira `interrompido`.
 */
export function aparencia(step: Step, status: StatusDaCorrida): Aparencia {
  const emMovimento = status === "correndo";
  if (step.tipo === "texto") {
    if (step.final === null) {
      const cara: Aparencia = step.rascunho === "" ? "pensando" : "streamando";
      return emMovimento ? cara : "interrompido";
    }
    // "" = a passada que so pediu a tool; ela existe, mas nao escreveu nada.
    return step.final === "" ? "pensou" : "final";
  }
  if (step.tipo === "chamada_de_tool") {
    if (step.terminouEm === null) return emMovimento ? "rodando" : "interrompido";
    return "chamada";
  }
  return step.tipo === "erro_de_tool" ? "erro" : "resultado";
}

export type Progresso = {
  fase: "esperando" | "pensando" | "tool" | "texto" | "completa" | "morta";
  rotulo: string;
  /** A barra segurou na fase da tool em vez de piscar "Pensando". */
  travada?: boolean;
};

/**
 * UMA barra para a corrida inteira, nao uma por step: o grafo e sequencial,
 * entao so existe uma coisa em andamento por vez.
 */
export function progressoDaCorrida(estado: Estado): Progresso {
  if (estado.status === "completa") return { fase: "completa", rotulo: "Corrida completa" };
  if (estado.status === "morta")
    return { fase: "morta", rotulo: "Stream morto — o fio fechou sem o fim normal" };

  const ultimo = estado.steps[estado.steps.length - 1];
  if (!ultimo) return { fase: "esperando", rotulo: "Esperando o primeiro evento" };

  const cara = aparencia(ultimo, estado.status);
  if (cara === "rodando" && ultimo.tipo === "chamada_de_tool")
    return { fase: "tool", rotulo: `Consultando ${ultimo.nome}…` };
  if (cara === "streamando") return { fase: "texto", rotulo: "Escrevendo a resposta…" };

  // A barra SEGURA em "Consultando" ate o primeiro token da passada seguinte.
  // Entre o on_tool_end e o on_chat_model_start da passada 2 o grafo ainda esta
  // voltando com o resultado; piscar "Pensando" ali e ruido, nao informacao.
  const iTool = estado.steps.map((s) => s.tipo).lastIndexOf("chamada_de_tool");
  if (iTool >= 0) {
    const escreveuDepois = estado.steps
      .slice(iTool)
      .some((s) => s.tipo === "texto" && (s.rascunho !== "" || (s.final ?? "") !== ""));
    if (!escreveuDepois) {
      const chamada = estado.steps[iTool] as Extract<Step, { tipo: "chamada_de_tool" }>;
      return { fase: "tool", travada: true, rotulo: `Consultando ${chamada.nome}…` };
    }
  }
  return { fase: "pensando", rotulo: "Pensando…" };
}

/**
 * O JSON que a tool devolveu, para reaparecer no fim junto da resposta: o texto
 * final diz "22°C", este bloco mostra DE ONDE veio (AC-08).
 */
export const dadosDasTools = (estado: Estado): StepDeResultado[] =>
  estado.steps.filter(
    (s): s is StepDeResultado => s.tipo === "resultado_de_tool" && s.dados !== null,
  );
