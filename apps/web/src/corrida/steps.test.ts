/**
 * O AC-07 medido contra a corrida real gravada.
 *
 * Nenhum teste aqui monta evento a mao no caminho feliz: quem dita o formato e
 * a fixture, porque foi ela que derrubou o palpite de que a passada 1 produz
 * texto (issue #6).
 */

import { describe, expect, it } from "vitest";

import { tocar, tocarEFechar } from "@/testing/fixture";
import { desembrulhar } from "@/transporte/sse";
import { aparencia, dadosDasTools, progressoDaCorrida } from "./aparencia";
import { EventoForaDoContrato, estadoInicial, reduzir } from "./steps";

describe("a corrida inteira, da fixture", () => {
  it("vira quatro steps: duas passadas, a chamada e o resultado (AC-07)", () => {
    const estado = tocar();

    expect(estado.steps.map((s) => s.tipo)).toEqual([
      "texto",
      "chamada_de_tool",
      "resultado_de_tool",
      "texto",
    ]);
  });

  it("so completa no fim da ULTIMA passada, com finish_reason stop", () => {
    expect(tocar(37).status).toBe("correndo"); // 37 = tudo menos o ultimo fim
    expect(tocar().status).toBe("completa");
  });

  it("a passada que so pede a tool termina com texto vazio", () => {
    // O achado que mudou o desenho: os tokens da passada 1 vem com content "",
    // porque o que streama ali sao os argumentos da tool.
    const [passada1] = tocar().steps;
    expect(passada1).toMatchObject({ tipo: "texto", final: "" });
    expect(aparencia(passada1, "completa")).toBe("pensou");
  });

  it("o final substitui o rascunho da SUA passada (AC-07)", () => {
    const passada2 = tocar().steps[3];
    if (passada2.tipo !== "texto") throw new Error("o quarto step deveria ser texto");

    expect(passada2.rascunho).toBe(""); // rascunho e final nunca coexistem
    expect(passada2.final).toContain("22");
  });

  it("chamada e resultado sao steps separados, ligados pelo run_id", () => {
    const [, chamada, resultado] = tocar().steps;
    if (chamada.tipo !== "chamada_de_tool" || resultado.tipo !== "resultado_de_tool")
      throw new Error("a fixture deveria ter chamada e resultado");

    expect(resultado.chave).toBe(`${chamada.chave}:fim`);
    expect(chamada.argumentos).toMatchObject({ city: expect.stringContaining("Paulo") });
    expect(resultado.dados).toMatchObject({ temp_c: 22, condition: "parcialmente nublado" });
  });

  it("a latencia da tool e a diferenca entre as chegadas, medida pelo cliente", () => {
    const resultado = tocar().steps[2];
    if (resultado.tipo !== "resultado_de_tool") throw new Error("esperava o resultado");

    expect(resultado.latenciaMs).toBe(5000); // os 5s do stub
  });

  it("o JSON da tool fica disponivel para reaparecer no fim (AC-08)", () => {
    expect(dadosDasTools(tocar())).toHaveLength(1);
  });
});

describe("a barra unica da corrida", () => {
  it("segura em 'Consultando' entre o fim da tool e o primeiro token da passada 2", () => {
    // Frame 14 = on_tool_end; 15 = on_chat_model_start da passada 2. Nesse vao
    // o grafo ainda esta voltando: piscar "Pensando" ali seria ruido.
    const depoisDaTool = progressoDaCorrida(tocar(15));

    expect(depoisDaTool).toMatchObject({ fase: "tool", travada: true });
  });

  it("vira 'texto' quando o primeiro token de verdade chega", () => {
    const escrevendo = progressoDaCorrida(tocar(17));

    expect(escrevendo.fase).toBe("texto");
  });
});

describe("os caminhos que a fixture feliz nao tem", () => {
  const sintetico = (tipo: string, runId: string, data: object) =>
    desembrulhar({ event: tipo, name: "get_weather", run_id: runId, data }, 9_000);

  it("um tipo sem dono no registry estoura (AC-06)", () => {
    const estranho = desembrulhar(
      { event: "on_retriever_start", name: "VectorStore", run_id: "x", data: {} },
      0,
    );

    expect(() => reduzir(estadoInicial("oi"), estranho)).toThrow(EventoForaDoContrato);
  });

  it("on_tool_error tem dono: vira step proprio, nao erro", () => {
    const antes = tocar(13); // ate a tool comecar
    const chamada = antes.steps[1];

    const depois = reduzir(
      antes,
      sintetico("on_tool_error", chamada.chave, { error: "TimeoutError" }),
    );

    const erro = depois.steps[2];
    expect(erro).toMatchObject({ tipo: "erro_de_tool", erro: "TimeoutError" });
    expect(aparencia(erro, "correndo")).toBe("erro");
  });

  it("o fio que fecha sem 'stop' e stream morto, e congela o que estava em movimento", () => {
    const morta = tocarEFechar(25); // no meio dos tokens da passada 2

    expect(morta.status).toBe("morta");
    expect(progressoDaCorrida(morta).fase).toBe("morta");
    expect(aparencia(morta.steps[3], morta.status)).toBe("interrompido");
  });

  it("o fio que fecha DEPOIS do 'stop' nao desfaz a corrida completa", () => {
    expect(tocarEFechar().status).toBe("completa");
  });

  it("uma corrida completa nao pinta como interrompido a passada que ficou sem final", () => {
    // So a MORTE congela um step. O "stop" chega no fim da ULTIMA passada, e
    // uma passada anterior sem `final` nunca foi interrompida.
    const completa = { ...tocar(), status: "completa" as const };
    const semFinal = { ...completa.steps[0], final: null };

    expect(aparencia(semFinal, completa.status)).toBe("pensando");
  });
});
