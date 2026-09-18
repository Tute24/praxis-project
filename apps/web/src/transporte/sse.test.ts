/**
 * A borda: o lugar onde o formato do fio morre.
 *
 * Vale testar porque e onde mora o risco de corte -- um `ReadableStream` nao
 * promete entregar um frame inteiro por vez, e o envelope LC e um formato que
 * ninguem daqui escolheu. O render fica de fora: ele e tela, nao contrato.
 */

import { describe, expect, it } from "vitest";

import { fixture } from "@/testing/fixture";
import { criarParserSSE, desembrulhar } from "./sse";

/** Reconstroi o fio exatamente como o `to_sse` do back o escreve. */
const noFio = (frame: { event: string; data: unknown }) =>
  `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;

describe("parser SSE", () => {
  it("le um frame inteiro", () => {
    const parser = criarParserSSE();

    const [frame] = parser.empurrar(noFio(fixture.events[0]));

    expect(frame.event).toBe("on_chat_model_start");
    expect(frame.data.run_id).toBe(fixture.events[0].data.run_id);
  });

  it("aguenta o pedaco que corta um frame no meio", () => {
    const fio = fixture.events.slice(0, 2).map(noFio).join("");
    const corte = Math.floor(fio.length / 2);
    const parser = criarParserSSE();

    const primeiraLeva = parser.empurrar(fio.slice(0, corte));
    const segundaLeva = parser.empurrar(fio.slice(corte));

    expect([...primeiraLeva, ...segundaLeva].map((f) => f.event)).toEqual([
      "on_chat_model_start",
      "on_chat_model_stream",
    ]);
  });

  it("nao entrega um frame antes da linha em branco que o fecha", () => {
    const parser = criarParserSSE();

    expect(parser.empurrar("event: on_tool_start\ndata: {}")).toEqual([]);
  });

  it("toca a corrida inteira byte a byte sem perder nem inventar frame", () => {
    const fio = fixture.events.map(noFio).join("");
    const parser = criarParserSSE();

    const tipos = [...fio].flatMap((letra) => parser.empurrar(letra)).map((f) => f.event);

    expect(tipos).toEqual(fixture.events.map((f) => f.event));
  });
});

describe("desembrulho do envelope LC", () => {
  const plano = (i: number) => desembrulhar(fixture.events[i].data, 0);

  it("tira o texto do token de dentro de kwargs", () => {
    expect(plano(16).texto).toBe("O");
  });

  it("le o finish_reason do fim da passada", () => {
    expect(plano(37).motivoDoFim).toBe("stop");
  });

  it("parseia o JSON que o ToolMessage carrega como string", () => {
    const fimDaTool = plano(13);

    expect(fimDaTool.dados).toMatchObject({ temp_c: 22 });
    // A string crua continua guardada: e o que veio no fio, e o AC-05 diz que
    // o fio carrega o evento cru.
    expect(typeof fimDaTool.saida).toBe("string");
  });

  it("nao perde o evento quando a tool devolve texto que nao e JSON", () => {
    const evento = {
      event: "on_tool_end",
      name: "get_weather",
      run_id: "x",
      data: { output: { lc: 1, type: "constructor", kwargs: { content: "fazia sol" } } },
    };

    expect(desembrulhar(evento, 0)).toMatchObject({ saida: "fazia sol", dados: null });
  });

  it("deixa o tipo desconhecido passar cru: quem recusa e o reducer (AC-06)", () => {
    const estranho = { event: "on_retriever_start", name: "V", run_id: "x", data: {} };

    expect(desembrulhar(estranho, 0).tipo).toBe("on_retriever_start");
  });
});
