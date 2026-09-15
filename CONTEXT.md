# Praxis P1: agente de clima com streaming

Um agente LangGraph com uma única tool de clima, exposto por uma API que transmite a execução em tempo real, e um chat que pinta essa execução conforme ela acontece. O projeto existe para aprender coordenação de streaming e separação de responsabilidades — o comportamento visível é o entregável.

## Language

### Execução do agente

**Agente**:
O componente que corre o grafo do começo ao fim e emite o que aconteceu durante a corrida. Uma unidade de execução, não um objeto conversacional.
_Avoid_: bot, assistente, chain

**Grafo**:
A máquina de estados que liga o modelo à tool e de volta ao modelo. É **construído** (e compilado) uma vez; é **corrido** muitas.
_Avoid_: chain, pipeline, fluxo

**Passada do modelo**:
Uma invocação do modelo dentro de uma corrida. Uma corrida que usa a tool tem duas passadas: a que pede a tool e a que responde ao usuário com o resultado. Distinguir passadas é o que torna o AC-07 preciso.
_Avoid_: turno, chamada, iteração

**Corrida**:
Uma execução completa do grafo, do request do usuário até o último evento.
_Avoid_: request, sessão, conversa

### O fio

**Evento**:
Um fato observável emitido durante a corrida — o modelo começou, um token saiu, a tool começou, a tool terminou. É o único vocabulário que a API expõe sobre o que está acontecendo.
_Avoid_: mensagem, update, chunk (chunk é o conteúdo de um evento, não o evento)

**Evento cru**:
O evento exatamente como o framework o emitiu, sem tradução. O contrato do projeto é que o fio carrega o evento cru: a API não inventa um vocabulário próprio de eventos, e o cliente lê os campos do original.
_Avoid_: evento de domínio, DTO de evento

**Token**:
O pedaço de texto que chega dentro de um evento de stream do modelo. Vários tokens formam um rascunho.
_Avoid_: chunk, delta, parte

### Estado do cliente

**Step**:
Uma unidade visível da corrida no cliente, com tipo próprio: texto do modelo, chamada de tool, ou resultado de tool. Uma corrida é uma lista ordenada de steps — é isso que faz o AC-07 ("estados separados") ser representável.
_Avoid_: mensagem, bloco, item

**Rascunho**:
O texto de um step acumulado token a token, enquanto a passada ainda não terminou. Provisório por natureza.
_Avoid_: buffer, parcial, streaming text

**Final**:
O texto oficial de uma passada do modelo, que **substitui** o rascunho quando a passada termina. Rascunho e final nunca coexistem no mesmo step.
_Avoid_: completo, resultado, output

**Latência**:
O tempo decorrido entre dois eventos, medido pelo cliente na chegada deles. É uma leitura do observador, não um dado que a API informa.
_Avoid_: duração, tempo de execução

### Aprendizado

**Fixture de eventos**:
A sequência real de eventos gravada de uma corrida verdadeira, guardada no repo. Serve de fonte da verdade para desenhar o cliente e de entrada para testes sem chamar o modelo.
_Avoid_: mock, stub, snapshot
