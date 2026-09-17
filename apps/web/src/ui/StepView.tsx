/**
 * Um registry de renderers por APARENCIA -- a mesma ideia de dispatch do AC-06,
 * so que do lado da tela: uma aparencia nova e uma chave nova aqui, nao um `if`
 * a mais. O que cada step vira e decidido por `aparencia(step, status)`, que e
 * derivada do estado; nenhum evento manda "mostre o spinner" (issue #6).
 */

import type { Aparencia } from "@/corrida/aparencia";
import { aparencia } from "@/corrida/aparencia";
import type { StatusDaCorrida, Step } from "@/corrida/steps";

const json = (v: unknown) => JSON.stringify(v, null, 2);

const RENDERERS: Record<Aparencia, (s: any) => React.ReactNode> = {
  // A passada 1 nao escreve texto nenhum (os tokens dela sao os argumentos da
  // tool): esse step vazio E o spinner.
  pensando: () => (
    <>
      <span className="spinner" />
      <span className="apagado">Pensando…</span>
    </>
  ),
  pensou: () => (
    <span className="apagado">Pensei — esta passada não escreveu texto, só pediu a tool</span>
  ),
  streamando: (s: Extract<Step, { tipo: "texto" }>) => (
    <>
      {s.rascunho}
      <span className="cursor">▋</span>
    </>
  ),
  final: (s: Extract<Step, { tipo: "texto" }>) => <>{s.final}</>,
  rodando: (s: Extract<Step, { tipo: "chamada_de_tool" }>) => (
    <>
      <code>
        {s.nome}({json(s.argumentos)})
      </code>
      <div className="meta">esperando a tool responder…</div>
    </>
  ),
  chamada: (s: Extract<Step, { tipo: "chamada_de_tool" }>) => (
    <>
      <code>
        {s.nome}({json(s.argumentos)})
      </code>
      <div className="meta">terminou em {(s.terminouEm ?? 0) - s.comecouEm} ms</div>
    </>
  ),
  resultado: (s: Extract<Step, { tipo: "resultado_de_tool" }>) => (
    <>
      <pre className="json">{json(s.dados ?? s.saida)}</pre>
      <div className="meta">latência: {s.latenciaMs} ms</div>
    </>
  ),
  erro: (s: Extract<Step, { tipo: "erro_de_tool" }>) => (
    <>
      <span style={{ color: "var(--erro)" }}>{s.erro}</span>
      <div className="meta">latência até falhar: {s.latenciaMs} ms</div>
    </>
  ),
  interrompido: (s: Step) => (
    <span className="apagado">
      interrompido — o fio fechou aqui
      {s.tipo === "texto" && s.rascunho ? `: “${s.rascunho}”` : ""}
    </span>
  ),
};

const ROTULOS: Record<Aparencia, string> = {
  pensando: "modelo pensando",
  pensou: "modelo pensou",
  streamando: "texto do modelo · chegando",
  final: "texto do modelo · final",
  rodando: "chamada de tool · rodando",
  chamada: "chamada de tool",
  resultado: "resultado da tool",
  erro: "erro da tool",
  interrompido: "stream morto",
};

export function StepView({ step, status }: { step: Step; status: StatusDaCorrida }) {
  const cara = aparencia(step, status);
  return (
    <div className="step">
      <div className="rotulo">{ROTULOS[cara]}</div>
      {RENDERERS[cara](step)}
    </div>
  );
}
