/**
 * Um registry de renderers por APARENCIA -- a mesma ideia de dispatch do AC-06,
 * so que do lado da tela: uma aparencia nova e uma chave nova aqui, nao um `if`
 * a mais. O que cada step vira e decidido por `aparencia(step, status)`, que e
 * derivada do estado; nenhum evento manda "mostre o spinner" (issue #6).
 */

import type { Aparencia } from "@/corrida/aparencia";
import { aparencia } from "@/corrida/aparencia";
import type {
  StatusDaCorrida,
  Step,
  StepDeChamada,
  StepDeErro,
  StepDeResultado,
  StepDeTexto,
} from "@/corrida/steps";

const json = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * O par aparencia -> tipo de step e garantido pelo `aparencia()`, nao pelo
 * compilador: e por isso que o cast mora AQUI, num lugar so e com nome, em vez
 * de virar um `any` espalhado por cada renderer.
 */
const renderer =
  <T extends Step>(fn: (s: T) => React.ReactNode) =>
  (s: Step) =>
    fn(s as T);

/** A chamada e o mesmo `nome(argumentos)` esteja ela rodando ou ja fechada. */
const assinatura = (s: StepDeChamada) => (
  <code>
    {s.nome}({json(s.argumentos)})
  </code>
);

const RENDERERS: Record<Aparencia, (s: Step) => React.ReactNode> = {
  // A passada 1 nao escreve texto nenhum (os tokens dela sao os argumentos da
  // tool): esse step vazio E o spinner.
  pensando: renderer(() => (
    <>
      <span className="spinner" />
      <span className="apagado">Pensando…</span>
    </>
  )),
  pensou: renderer(() => (
    <span className="apagado">Pensei — esta passada não escreveu texto, só pediu a tool</span>
  )),
  streamando: renderer((s: StepDeTexto) => (
    <>
      {s.rascunho}
      <span className="cursor">▋</span>
    </>
  )),
  final: renderer((s: StepDeTexto) => <>{s.final}</>),
  rodando: renderer((s: StepDeChamada) => (
    <>
      {assinatura(s)}
      <div className="meta">esperando a tool responder…</div>
    </>
  )),
  chamada: renderer((s: StepDeChamada) => (
    <>
      {assinatura(s)}
      <div className="meta">terminou em {(s.terminouEm ?? 0) - s.comecouEm} ms</div>
    </>
  )),
  resultado: renderer((s: StepDeResultado) => (
    <>
      <pre className="json">{json(s.dados ?? s.saida)}</pre>
      <div className="meta">latência: {s.latenciaMs} ms</div>
    </>
  )),
  erro: renderer((s: StepDeErro) => (
    <>
      <span style={{ color: "var(--erro)" }}>{s.erro}</span>
      <div className="meta">latência até falhar: {s.latenciaMs} ms</div>
    </>
  )),
  interrompido: renderer((s: Step) => (
    <span className="apagado">
      interrompido — o fio fechou aqui
      {s.tipo === "texto" && s.rascunho ? `: “${s.rascunho}”` : ""}
    </span>
  )),
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
