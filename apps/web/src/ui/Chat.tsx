"use client";

import { useRef, useState } from "react";

import { dadosDasTools, progressoDaCorrida } from "@/corrida/aparencia";
import { estadoInicial, fecharStream, reduzir, type Estado } from "@/corrida/steps";
import { abrirCorrida, ApiIndisponivel, URL_DA_API } from "@/transporte/sse";
import { StepView } from "./StepView";

const PERGUNTA_PADRAO = "Qual o clima em São Paulo?";

export function Chat() {
  const [pergunta, setPergunta] = useState(PERGUNTA_PADRAO);
  const [estado, setEstado] = useState<Estado | null>(null);
  const [correndo, setCorrendo] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const abortar = useRef<AbortController | null>(null);

  async function correr(mensagem: string) {
    abortar.current?.abort();
    const controle = new AbortController();
    abortar.current = controle;

    // O estado vive aqui e nao no `useState` durante a corrida: cada evento
    // precisa reduzir sobre o estado ANTERIOR, e o setState e assincrono.
    let atual = estadoInicial(mensagem);
    setEstado(atual);
    setAviso(null);
    setCorrendo(true);

    try {
      for await (const evento of abrirCorrida(mensagem, { sinal: controle.signal })) {
        // Sem try/catch aqui de proposito: um tipo fora do contrato ESTOURA
        // (AC-06). Ele cai no catch de baixo, que reergue o erro fora do loop.
        atual = reduzir(atual, evento);
        setEstado(atual);
      }
      // O fio fechou. Sem "stop" antes, a corrida nao completou: e stream
      // morto -- conclusao do cliente pela ausencia do fim normal.
      setEstado(fecharStream(atual));
    } catch (erro) {
      setEstado(fecharStream(atual));
      if (controle.signal.aborted) return; // cancelamento do usuario nao e falha
      if (erro instanceof ApiIndisponivel) {
        setAviso(`${erro.message}. A API está no ar? (\`uv run uvicorn main:app\`)`);
        return;
      }
      setAviso(erro instanceof Error ? erro.message : String(erro));
      // O AC-06 manda LANCAR erro, nao engolir. Reerguer fora do loop deixa o
      // erro chegar no `window.onerror` e no console, como um bug de verdade,
      // em vez de virar so uma tarja bonitinha na tela.
      queueMicrotask(() => {
        throw erro;
      });
    } finally {
      setCorrendo(false);
    }
  }

  const progresso = estado ? progressoDaCorrida(estado) : null;
  const dados = estado && estado.status !== "correndo" ? dadosDasTools(estado) : [];

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pergunta.trim()) void correr(pergunta.trim());
        }}
      >
        <input
          type="text"
          value={pergunta}
          onChange={(e) => setPergunta(e.target.value)}
          placeholder={PERGUNTA_PADRAO}
          aria-label="Pergunta para o agente"
          disabled={correndo}
        />
        <button type="submit" disabled={correndo || !pergunta.trim()}>
          {correndo ? "Correndo…" : "Perguntar"}
        </button>
        {correndo && (
          <button type="button" className="secundario" onClick={() => abortar.current?.abort()}>
            Cancelar
          </button>
        )}
      </form>
      <div className="meta">
        API: <code>{URL_DA_API}</code>
      </div>

      {aviso && <div className="aviso">{aviso}</div>}

      {estado && progresso && (
        <>
          {/* UMA barra para a corrida inteira, nao uma por step: o grafo e
              sequencial, entao so existe uma coisa em andamento por vez. */}
          <div
            className="faixa"
            role="progressbar"
            aria-label={progresso.rotulo}
            aria-valuetext={progresso.rotulo}
          >
            <div className={`faixa-fill ${progresso.fase}`} />
          </div>
          <div className="meta" aria-live="polite">
            {progresso.rotulo}
          </div>

          <div className="steps">
            {estado.steps.map((step) => (
              <StepView key={step.chave} step={step} status={estado.status} />
            ))}
          </div>

          {/* O JSON da tool reaparece no fim, junto da resposta: o texto final
              diz "22°C", este bloco mostra de onde isso veio (AC-08). */}
          {dados.map((s) => (
            <div className="step" key={`${s.chave}:dados`} style={{ marginTop: 10 }}>
              <div className="rotulo">dados que a resposta usou · {s.nome}</div>
              <pre className="json">{JSON.stringify(s.dados, null, 2)}</pre>
            </div>
          ))}
        </>
      )}
    </>
  );
}
