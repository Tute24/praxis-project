# O fio carrega o evento cru

O AC-05 manda serializar o `StreamEvent` **inteiro** como o `data` de cada frame SSE, e o AC-06 manda o cliente lançar erro em qualquer tipo fora de `on_chat_model_*` / `on_tool_*`. Juntos, esses dois ACs proíbem a API de ter um vocabulário próprio de eventos: nada de `event: error`, nada de traduzir para um "evento de domínio". Decidimos levar essa restrição até o fim, e não só até a borda HTTP — o port do agente também é tipado no evento cru.

## Decisão

**O port expõe `AgentRunner.astream(message: str) -> AsyncIterator[StreamEvent]`**, com o `StreamEvent` do `langchain_core` na assinatura. Um leitor pode achar que isso viola o DIP; não viola. `StreamEvent` é um `TypedDict` — é *dado*, não maquinário do fornecedor. O DIP protege a rota do *comportamento* do LangChain (compilar grafo, conhecer `ToolNode`, passar `version="v2"`), e disso ela está protegida: não há um `import langgraph` fora de `agent/`. Depender da *forma do dado* é obrigatório, porque o dado cru **é** o contrato.

**A serialização é `langchain_core.load.dumpd`, crua.** `json.dumps` puro quebra: o `data` carrega `AIMessageChunk` e `ToolMessage`. A propriedade que decide o desenho é que `dumpd` **nunca levanta exceção** — cai em `to_json_not_implemented` para qualquer coisa não serializável, inclusive um `BaseException`. Isso elimina try/except por evento no meio do stream, que é o pior lugar possível para estourar.

**`on_tool_error` é evento legítimo do contrato.** O filtro `include_types=["chat_model","tool"]` deixa ele passar (tem `root_type == "tool"`), e ele casa com o prefixo `on_tool_*`, então não viola o AC-06. O back não filtra: filtrar seria o back inventando política sobre o que o cliente pode ver.

## Alternativa rejeitada

Um tipo de evento próprio no port, ou uma serialização achatada à mão. Como o byte final tem que ser o evento cru de qualquer forma, ambas pagam uma tradução de ida e uma de volta para chegar exatamente no mesmo lugar — e a serialização à mão reintroduz o risco de estourar num tipo inesperado, justo o risco que o `dumpd` elimina de graça.

O custo aceito é que `data.chunk` e `data.output` chegam no cliente no envelope LC (`{"lc":1,"type":"constructor","id":[...],"kwargs":{...}}`), e o cliente lê o conteúdo dentro de `kwargs`. Medido contra a corrida real gravada em `fixtures/`: as 7 chaves do topo do `StreamEvent` saem planas, e o envelope aparece em exatamente dois campos.

## Consequências

**Erro depois do primeiro byte não tem canal.** Os headers já foram (não dá para virar 500) e um `event: error` está proibido. Logo, a única saída é logar e fechar o stream. Isso não é uma decisão independente — é o que sobra depois de proibir evento inventado.

**A distinção fim-normal/morte passa a ser leitura do cliente**, como a latência já era: a corrida completa se reconhece pelo `on_chat_model_end` da última passada com `finish_reason: "stop"`; um stream que fecha sem isso morreu. O dado necessário já viaja no fio porque o AC-05 obriga — nenhum evento novo foi preciso. Ver **Corrida completa** e **Stream morto** no `CONTEXT.md`.

**Não há hierarquia de `AppError` nem exception handler.** Um handler do FastAPI só age antes do primeiro byte, e ali todo caso já tem dono (corpo inválido → 422 do Pydantic; `OPENAI_API_KEY` ausente → o app não sobe, porque o grafo é construído eager no `lifespan`). O único caminho de erro real é justamente o que um handler não alcança.

**`dumpd` não é idempotente.** Em `langchain-core==1.6.3`, reserializar um envelope LC já serializado o escapa como `{"__lc_escaped__": {...}}` (proteção contra payload LC forjado). Isso importa para quem alimenta um fake com a fixture gravada: é preciso reidratar com `load(..., allowed_objects="messages")` antes. O round-trip `load` → `dumpd` é exato.
