/**
 * O modelo de estado da corrida: lista de steps tipados + reducer puro.
 *
 * Nada aqui toca DOM, timer ou fetch. Entra evento, sai estado -- e o que
 * sobreviveu do prototipo aprovado (issue #6), traduzido para TypeScript.
 *
 * O reducer nunca ve o envelope LC nem JSON por parsear: quem desembrulha e a
 * borda do transporte (`src/transporte/sse.ts`). Por isso os testes do AC-07
 * alimentam este arquivo com dado plano e continuam legiveis.
 */

/** O evento ja desembrulhado pela borda. As 7 chaves do StreamEvent viram 4 + o que o tipo carrega. */
export type EventoPlano = {
  tipo: string;
  nome: string;
  runId: string;
  /** Horario de CHEGADA, medido pelo cliente. A API nao manda tempo (AC-06 proibe evento custom). */
  chegadaEm: number;
  texto?: string;
  motivoDoFim?: string | null;
  argumentos?: Record<string, unknown>;
  /** A string crua que o ToolMessage carregava. */
  saida?: string | null;
  /** A mesma coisa ja parseada, quando era JSON. */
  dados?: unknown;
  erro?: string;
};

export type StepDeTexto = {
  chave: string;
  tipo: "texto";
  /** Acumulado token a token enquanto a passada nao terminou. Provisorio. */
  rascunho: string;
  /** O texto oficial da passada. Substitui o rascunho; os dois nunca coexistem. */
  final: string | null;
  comecouEm: number;
  primeiroTokenEm: number | null;
  terminouEm?: number;
};

export type StepDeChamada = {
  chave: string;
  tipo: "chamada_de_tool";
  nome: string;
  argumentos: Record<string, unknown>;
  comecouEm: number;
  /** `null` enquanto a tool nao respondeu: e isso que diz que a corrida esta esperando. */
  terminouEm: number | null;
};

export type StepDeResultado = {
  chave: string;
  tipo: "resultado_de_tool";
  nome: string;
  saida: string | null;
  dados: unknown;
  latenciaMs: number;
};

export type StepDeErro = {
  chave: string;
  tipo: "erro_de_tool";
  nome: string;
  erro: string;
  latenciaMs: number;
};

export type Step = StepDeTexto | StepDeChamada | StepDeResultado | StepDeErro;

export type StatusDaCorrida = "correndo" | "completa" | "morta";

export type Estado = {
  mensagem: string;
  /** Lista ORDENADA de steps tipados -- e isso que faz o AC-07 ("estados separados") ser representavel. */
  steps: Step[];
  status: StatusDaCorrida;
};

export const estadoInicial = (mensagem: string): Estado => ({
  mensagem,
  steps: [],
  status: "correndo",
});

/* ---- Helpers puros sobre a lista de steps ------------------------------- */

const acharStep = (estado: Estado, chave: string): Step | undefined =>
  estado.steps.find((s) => s.chave === chave);

const comStep = (estado: Estado, step: Step): Estado => ({
  ...estado,
  steps: [...estado.steps, step],
});

const trocarStep = (estado: Estado, chave: string, fn: (s: Step) => Step): Estado => ({
  ...estado,
  steps: estado.steps.map((s) => (s.chave === chave ? fn(s) : s)),
});

// Fim da tool fecha a chamada E cria o resultado: um evento, dois steps mexidos.
const fecharChamada = (estado: Estado, ev: EventoPlano): Estado =>
  trocarStep(estado, ev.runId, (s) =>
    s.tipo === "chamada_de_tool" ? { ...s, terminouEm: ev.chegadaEm } : s,
  );

// Latencia e leitura do cliente: chegada do fim menos chegada do comeco.
const latenciaDaTool = (estado: Estado, ev: EventoPlano): number => {
  const chamada = acharStep(estado, ev.runId);
  const comecouEm = chamada && chamada.tipo === "chamada_de_tool" ? chamada.comecouEm : ev.chegadaEm;
  return ev.chegadaEm - comecouEm;
};

/* ---- Registry de transicoes: um evento, um dono ------------------------
   AC-06 pede dispatch por tipo com erro no desconhecido. Registry aberto para
   extensao: um evento novo e uma CHAVE NOVA aqui, nenhum `if` editado.        */

type Transicao = (estado: Estado, ev: EventoPlano) => Estado;

export const TRANSICOES: Record<string, Transicao> = {
  // Uma passada do modelo comeca: nasce um step de texto com a chave do run_id.
  on_chat_model_start: (estado, ev) =>
    comStep(estado, {
      chave: ev.runId,
      tipo: "texto",
      rascunho: "",
      final: null,
      comecouEm: ev.chegadaEm,
      primeiroTokenEm: null,
    }),

  // Token: concatena NO RASCUNHO do step daquela passada (AC-07).
  on_chat_model_stream: (estado, ev) =>
    trocarStep(estado, ev.runId, (s) =>
      s.tipo === "texto"
        ? {
            ...s,
            rascunho: s.rascunho + (ev.texto ?? ""),
            primeiroTokenEm: s.primeiroTokenEm ?? (ev.texto ? ev.chegadaEm : null),
          }
        : s,
    ),

  // Fim da passada: o final SUBSTITUI o rascunho -- e so o da SUA passada.
  // Corrida completa e o fim com finish_reason "stop" (CONTEXT.md).
  on_chat_model_end: (estado, ev) => {
    const comFinal = trocarStep(estado, ev.runId, (s) =>
      s.tipo === "texto"
        ? { ...s, rascunho: "", final: ev.texto ?? "", terminouEm: ev.chegadaEm }
        : s,
    );
    return ev.motivoDoFim === "stop" ? { ...comFinal, status: "completa" } : comFinal;
  },

  // A chamada nasce ABERTA: `terminouEm: null` e o que diz que a corrida esta
  // esperando a tool -- e o que a barra unica le para saber a fase.
  on_tool_start: (estado, ev) =>
    comStep(estado, {
      chave: ev.runId,
      tipo: "chamada_de_tool",
      nome: ev.nome,
      argumentos: ev.argumentos ?? {},
      comecouEm: ev.chegadaEm,
      terminouEm: null,
    }),

  // Resultado e um step SEPARADO da chamada: o AC-07 quer os dois visiveis.
  on_tool_end: (estado, ev) =>
    comStep(fecharChamada(estado, ev), {
      chave: `${ev.runId}:fim`,
      tipo: "resultado_de_tool",
      nome: ev.nome,
      saida: ev.saida ?? null, // a string crua, exatamente como veio no fio
      dados: ev.dados ?? null, // o mesmo JSON ja desembrulhado, para a tela
      latenciaMs: latenciaDaTool(estado, ev),
    }),

  // `on_tool_error` passa pelo filtro `include_types=["chat_model","tool"]` do
  // back e casa com `on_tool_*`, entao NAO e evento desconhecido: tem dono, nao
  // `throw` (docs/adr/0001-evento-cru-no-fio.md).
  on_tool_error: (estado, ev) =>
    comStep(fecharChamada(estado, ev), {
      chave: `${ev.runId}:fim`,
      tipo: "erro_de_tool",
      nome: ev.nome,
      erro: ev.erro ?? "erro desconhecido",
      latenciaMs: latenciaDaTool(estado, ev),
    }),
};

export class EventoForaDoContrato extends Error {
  constructor(tipo: string) {
    super(`Evento fora do contrato: ${tipo}`);
    this.name = "EventoForaDoContrato";
  }
}

/** AC-06: tipo fora de `on_chat_model_*` / `on_tool_*` nao e ignorado, e erro. */
export function reduzir(estado: Estado, ev: EventoPlano): Estado {
  const transicao = TRANSICOES[ev.tipo];
  if (!transicao) throw new EventoForaDoContrato(ev.tipo);
  return transicao(estado, ev);
}

/**
 * O fio fechou. Sem "stop", a corrida nao completou: e stream morto -- conclusao
 * do cliente pela AUSENCIA do fim normal, nao um evento que a API mandou
 * (CONTEXT.md: "Stream morto").
 */
export const fecharStream = (estado: Estado): Estado =>
  estado.status === "completa" ? estado : { ...estado, status: "morta" };
