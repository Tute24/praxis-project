/**
 * A borda do transporte: de bytes do fio ate `EventoPlano`.
 *
 * Tres responsabilidades, nesta ordem, e nenhuma delas do reducer:
 *  1. falar HTTP (`fetch` + `ReadableStream` -- `EventSource` nao faz POST, e o
 *     AC-01 pede `POST /agent/execute` com body);
 *  2. quebrar o texto em frames SSE;
 *  3. desembrulhar o envelope LC e parsear o JSON do `ToolMessage`.
 *
 * O item 3 e a decisao do ticket do modelo de estado (issue #6): o `dumpd` do
 * back embrulha `data.chunk` / `data.output` em
 * `{"lc":1,"type":"constructor","id":[...],"kwargs":{...}}`, e e AQUI que esse
 * formato morre. O reducer nunca ve `{lc:1,...}`.
 */

import type { EventoPlano } from "@/corrida/steps";

/** Um frame SSE cru: o `event:` e o `data:` ja parseado como JSON. */
export type Frame = { event: string; data: Record<string, any> };

/* ---- 2. Parser SSE ------------------------------------------------------ */

/**
 * Parser incremental, puro: entra pedaco de texto, saem os frames COMPLETOS
 * que ele fechou. O pedaco pode cortar um frame no meio -- por isso o resto
 * fica guardado ate o proximo `empurrar`.
 */
export function criarParserSSE() {
  let resto = "";

  return {
    empurrar(pedaco: string): Frame[] {
      resto += pedaco;
      // Frame SSE termina em linha em branco. O ultimo elemento do split ou e
      // "" (o texto acabou num limite de frame) ou e um frame pela metade.
      const blocos = resto.split("\n\n");
      resto = blocos.pop() ?? "";
      return blocos.map(frameDoBloco).filter((f): f is Frame => f !== null);
    },
  };
}

function frameDoBloco(bloco: string): Frame | null {
  let event = "";
  const linhasDeDados: string[] = [];
  for (const linha of bloco.split("\n")) {
    if (linha.startsWith("event: ")) event = linha.slice(7);
    else if (linha.startsWith("data: ")) linhasDeDados.push(linha.slice(6));
  }
  if (!event || linhasDeDados.length === 0) return null;
  // O SSE permite `data:` em varias linhas; o nosso encoder manda uma so, mas
  // juntar e mais barato que confiar nisso.
  return { event, data: JSON.parse(linhasDeDados.join("\n")) };
}

/* ---- 3. Desembrulho do envelope LC -------------------------------------- */

const desembrulharLC = (v: any): Record<string, any> =>
  v && v.lc === 1 ? (v.kwargs ?? {}) : (v ?? {});

/**
 * O `StreamEvent` inteiro (as 7 chaves) vira o evento plano que o reducer come.
 * `chegadaEm` e medido AQUI, na chegada do frame: latencia e leitura do
 * cliente, nao dado que a API informa (CONTEXT.md).
 */
export function desembrulhar(evento: Record<string, any>, chegadaEm: number): EventoPlano {
  const carga = evento.data ?? {};
  const base: EventoPlano = {
    tipo: evento.event,
    nome: evento.name,
    runId: evento.run_id,
    chegadaEm,
  };

  switch (evento.event) {
    case "on_chat_model_start":
      return base;

    case "on_chat_model_stream": {
      const chunk = desembrulharLC(carga.chunk);
      // Na passada que so pede a tool, `content` e "" e o que streama sao
      // `tool_call_chunks` -- esse rascunho vazio E o spinner "Pensando".
      return { ...base, texto: typeof chunk.content === "string" ? chunk.content : "" };
    }

    case "on_chat_model_end": {
      const saida = desembrulharLC(carga.output);
      return {
        ...base,
        texto: typeof saida.content === "string" ? saida.content : "",
        motivoDoFim: saida.response_metadata?.finish_reason ?? null,
      };
    }

    case "on_tool_start":
      return { ...base, argumentos: carga.input ?? {} };

    case "on_tool_end": {
      // O `ToolMessage` carrega o retorno da tool como STRING de JSON. O parse
      // acontece aqui, pelo mesmo motivo do envelope LC: o reducer guarda dado
      // pronto, e o teste do AC-07 nao carrega `JSON.parse` junto.
      const bruta = desembrulharLC(carga.output).content ?? null;
      let dados: unknown = null;
      try {
        dados = typeof bruta === "string" ? JSON.parse(bruta) : bruta;
      } catch {
        dados = null; // a tool devolveu texto puro: o step mostra a string crua
      }
      return { ...base, saida: bruta, dados };
    }

    case "on_tool_error":
      return { ...base, erro: String(carga.error ?? "erro desconhecido") };

    default:
      // Tipo fora do contrato passa CRU: quem recusa e o reducer (AC-06).
      // Filtrar aqui seria o transporte decidindo politica.
      return base;
  }
}

/* ---- 1. HTTP ------------------------------------------------------------ */

export const URL_DA_API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

export class ApiIndisponivel extends Error {}

/**
 * Abre a corrida e emite os eventos ja planos, na ordem em que chegaram.
 *
 * Quando o gerador termina sem erro, o fio fechou -- cabe a quem consome
 * chamar `fecharStream`, porque so o estado sabe se veio um "stop" antes.
 */
export async function* abrirCorrida(
  mensagem: string,
  opcoes: { sinal?: AbortSignal } = {},
): AsyncGenerator<EventoPlano> {
  let resposta: Response;
  try {
    resposta = await fetch(`${URL_DA_API}/agent/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: mensagem }),
      signal: opcoes.sinal,
    });
  } catch (causa) {
    // A API fora do ar e o unico erro que da para distinguir com certeza: ele
    // acontece ANTES do primeiro byte. Depois disso, morte e ausencia de fim
    // normal, nao excecao (docs/adr/0001-evento-cru-no-fio.md).
    throw new ApiIndisponivel(`Nao consegui falar com a API em ${URL_DA_API}`, { cause: causa });
  }
  if (!resposta.ok || !resposta.body) {
    throw new ApiIndisponivel(`A API respondeu ${resposta.status}`);
  }

  const leitor = resposta.body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = criarParserSSE();
  try {
    while (true) {
      const { done, value } = await leitor.read();
      if (done) return;
      for (const frame of parser.empurrar(value)) {
        yield desembrulhar(frame.data, Date.now());
      }
    }
  } finally {
    // Sair no meio (o usuario cancelou) tem que derrubar a conexao, senao o
    // grafo do outro lado continua correndo sem ninguem lendo.
    await leitor.cancel().catch(() => {});
  }
}
