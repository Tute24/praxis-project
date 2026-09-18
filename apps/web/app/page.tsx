import { Chat } from "@/ui/Chat";

// A pagina e server component e nao faz nada: quem tem estado e o `Chat`, que
// e client porque precisa de `fetch` + `ReadableStream` no browser.
export default function Page() {
  return (
    <main>
      <h1>Agente de clima</h1>
      <p className="apagado">
        Pergunte o clima de uma cidade. A tela pinta a corrida enquanto ela acontece: a chamada da
        tool, o resultado dela e o texto final aparecem como estados separados.
      </p>
      <Chat />
    </main>
  );
}
