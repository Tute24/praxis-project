# `astream_events(version="v2")` — versões e superfície real da API

Findings da issue [#2](https://github.com/Tute24/praxis-project/issues/2) (parte de #1).
Data da pesquisa: 2026-09-14.

**Método**: fontes primárias apenas — código-fonte de `langchain-core` na tag
`langchain-core==1.6.3`, `langgraph`/`langgraph-prebuilt` em `main`, metadados do PyPI,
e `reference.langchain.com` via Context7. Cada afirmação abaixo aponta para o arquivo/linha
que a sustenta. Onde não consegui confirmar, está escrito **não confirmado**.

---

## 0. Versões a pinar

Últimas versões no PyPI em 2026-09-14 e os limites que elas mesmas declaram:

| pacote | versão | dependência declarada |
| --- | --- | --- |
| `langchain-core` | `1.6.3` | — |
| `langgraph` | `1.2.11` | `langchain-core>=1.4.7,<2`, `langgraph-prebuilt>=1.1.0,<1.2.0`, `langgraph-checkpoint>=4.1.0,<5` |
| `langgraph-prebuilt` | `1.1.0` | (transitiva de `langgraph`) |
| `langchain-openai` | `1.6.2` | `langchain-core>=1.6.2,<2`, `openai>=2.45.0,<4` |
| `langchain` | `1.4.0` | `langchain-core>=1.6.0,<2`, `langgraph>=1.2.11,<1.3` |

Fonte: `https://pypi.org/pypi/<pkg>/<versão>/json`, campo `info.requires_dist`.

**Pin recomendado** (compatível entre si, Python >= 3.10):

```
langchain-core==1.6.3
langgraph==1.2.11
langchain-openai==1.6.2
langchain==1.4.0     # opcional — só se usar init_chat_model
```

`langchain` (o meta-pacote) **só é necessário se quisermos `init_chat_model`**; ele puxa
`langgraph>=1.2.11,<1.3`, o que é consistente com o pin acima. Se formos direto de
`ChatOpenAI`, dá para omitir `langchain` e ficar só com core + langgraph + openai.

Python mínimo: `>=3.10` (`requires_python` de `langgraph` e `langchain-openai`).

---

## 1. `Runnable.astream_events(version="v2")` ainda existe e é suportado?

**Sim. Existe, é o default, e NÃO está deprecado.**

Em `langchain_core/runnables/base.py` (tag `langchain-core==1.6.3`), linhas 1368-1381:

```python
def astream_events(
    self,
    input: Any,
    config: RunnableConfig | None = None,
    *,
    version: Literal["v1", "v2", "v3"] = "v2",
    include_names: Sequence[str] | None = None,
    include_types: Sequence[str] | None = None,
    include_tags: Sequence[str] | None = None,
    exclude_names: Sequence[str] | None = None,
    exclude_types: Sequence[str] | None = None,
    exclude_tags: Sequence[str] | None = None,
    **kwargs: Any,
) -> AsyncIterator[StreamEvent] | Awaitable[Any]:
```

Verificado:

- **Não há decorator `@deprecated` no método.** O único `warn_deprecated` no caminho é
  para `version="v1"` (base.py:1643-1646: `"astream_events version='v1' is deprecated."`)
  e para `astream_log` (base.py:1312-1314). `v2` não emite warning.
- O docstring diz literalmente (base.py:1561-1567):
  *"Most callers should use `'v2'` (the default), which yields `StreamEvent` dicts and
  supports custom events."* — ou seja, v2 é a recomendação oficial, não um legado.
- `v3` existe mas é **beta e restrita**: o próprio docstring diz que é
  *"in beta and may change"* e que só funciona em `BaseChatModel` e `langgraph.CompiledGraph`;
  num `Runnable` genérico levanta `NotImplementedError`
  (`_astream_events_v3_unsupported`, base.py:1600-1612).
- **`version="v2"` é seguro até `langchain-core==1.6.3` inclusive** (a última publicada).
  Não há anúncio de remoção de v2 que eu tenha encontrado no código. Sobre versões futuras:
  **não confirmado** — não existe deprecation policy explícita para v2 no fonte lido.

### `astream_events` num grafo LangGraph compilado

`Pregel.astream_events` (`langgraph/pregel/main.py`:3743-3781) **faz override, mas só
para interceptar `v3`**:

```python
if version == "v3":
    ...
    return self._apregel_stream_v3(...)
return super().astream_events(input, config, version=version, **kwargs)
```

Ou seja, com `version="v2"` o grafo cai **direto na implementação do `Runnable` do
langchain-core**, e `include_types` viaja intacto pelo `**kwargs` (é keyword-only na
assinatura base). É exatamente o que o enunciado pede.

### As APIs homônimas do LangGraph (FORA DE ESCOPO — não confundir)

Confirmei que o risco descrito no ticket é real:

- `Pregel.stream(..., version: Literal["v1","v2"] = "v1")` (main.py:2655-2671) — um
  parâmetro `version` **totalmente diferente**, onde `"v2"` retorna `StreamPart` typed dicts
  (main.py:3875: *"`\"v2\"` returns `StreamPart` typed dicts"*). Nada a ver com StreamEvent.
- `Pregel.stream_events(...)` / `astream_events(version="v3")` — protocolo novo,
  content-block-centric, retorna `AsyncGraphRunStream`, marcado `!!! warning` como experimental.

Regra prática para o projeto: **`version="v2"` só aparece dentro de `astream_events`.
Se você escreveu `version=` dentro de `.stream(` ou `.astream(`, está na API errada.**

---

## 2. O que exatamente `include_types=["chat_model", "tool"]` deixa passar

O filtro é `_RootEventFilter.include_event` em `langchain_core/runnables/utils.py`:735-764:

```python
def include_event(self, event: StreamEvent, root_type: str) -> bool:
    if (self.include_names is None and self.include_types is None
            and self.include_tags is None):
        include = True
    else:
        include = False
    ...
    if self.include_types is not None:
        include = include or root_type in self.include_types
    ...
```

`root_type` é o segundo argumento de `self._send(event, <root_type>)` em
`langchain_core/tracers/event_stream.py`. Mapeando cada call site:

| `_send` (event_stream.py) | `root_type` passado | evento |
| --- | --- | --- |
| :343 | `"chat_model"` | `on_chat_model_start` |
| :472 (`on_llm_new_token`) | `run_info["run_type"]` = `"chat_model"` | `on_chat_model_stream` |
| :535 (`on_llm_end`) | `run_info["run_type"]` = `"chat_model"` | `on_chat_model_end` |
| :681 | `"tool"` | `on_tool_start` |
| :727 | `"tool"` | `on_tool_error` |
| :734 | `"tool"` | `on_tool_end` |
| :217/:267 (`tap_output_*`) | `run_info["run_type"]` | `on_<run_type>_stream` |
| :423 (`on_custom_event`) | **`name`** (o nome do evento custom!) | `on_custom_event` |

**Resposta direta**: com `include_types=["chat_model","tool"]` passam

- `on_chat_model_start`, `on_chat_model_stream`, `on_chat_model_end`
- `on_tool_start`, `on_tool_end`
- **e mais `on_tool_error`** — não estava na lista do ticket, mas tem `root_type == "tool"`
  e portanto **passa pelo filtro**. Ver §4, porque ele carrega um `BaseException` no `data`.
- teoricamente `on_tool_stream` (via `tap_output_aiter`, se a tool devolver um iterador
  em streaming). Com uma `@tool` normal isso **não** acontece; com `ToolNode` também não,
  porque `ToolNode` chama `tool.ainvoke(...)` e não consome um stream
  (`langgraph/prebuilt/tool_node.py`:1105). Na prática não veremos `on_tool_stream`,
  mas o handler do SSE deve tolerar.

E são **bloqueados**: `on_chain_start/stream/end` (incl. os do grafo raiz e dos nós),
`on_prompt_*`, `on_retriever_*`, `on_llm_*` (modelos não-chat).

**Gotcha com `on_custom_event`**: o filtro recebe o *nome* do evento custom como `root_type`
(event_stream.py:423). Logo, um `adispatch_custom_event("chat_model", ...)` passaria pelo filtro
por acidente. Não vamos usar custom events, então é irrelevante aqui — mas vale registrar.

**Não há exclusão do run raiz.** `_RootEventFilter` (diferente de
`LogStreamCallbackHandler.include_run`, que tem `if run.id == self.root_id: return False`,
log_stream.py:395) não filtra o root. Não importa no nosso caso porque o root é o grafo,
de `run_type == "chain"`, já barrado pelo `include_types`.

---

## 3. Chaves exatas do `StreamEvent` e o `data` de cada evento

Definição em `langchain_core/runnables/schema.py` (tag 1.6.3):

```python
class BaseStreamEvent(TypedDict):
    event: str
    run_id: str
    tags: NotRequired[list[str]]
    metadata: NotRequired[dict[str, Any]]
    parent_ids: Sequence[str]

class StandardStreamEvent(BaseStreamEvent):
    data: EventData
    name: str

class CustomStreamEvent(BaseStreamEvent):
    event: Literal["on_custom_event"]
    name: str
    data: Any

StreamEvent = StandardStreamEvent | CustomStreamEvent
```

Ou seja, as 7 chaves são: **`event`, `name`, `run_id`, `tags`, `metadata`, `data`, `parent_ids`**.
Na prática o tracer sempre popula as 7 (todos os `_send` em event_stream.py montam o dict
completo, incl. `"tags": tags or []` e `"metadata": metadata or {}`), apesar de `tags`/`metadata`
serem `NotRequired` no TypedDict.

`parent_ids` é lista de strings, do root até o pai imediato, e **só é populada em v2**
(schema.py: *"Only supported as of v2 of the astream events API. v1 will return an empty list."*).

`EventData` (schema.py:14-55) tem as chaves `input`, `output`, `chunk`, `error`, `tool_call_id`.

Conteúdo de `data` por evento, lido dos call sites em `event_stream.py`:

| evento | `data` | `name` |
| --- | --- | --- |
| `on_chat_model_start` (:343) | `{"input": {"messages": [[BaseMessage, ...]]}}` — lista de listas | nome do modelo |
| `on_chat_model_stream` (:472) | `{"chunk": AIMessageChunk}` | nome do modelo |
| `on_chat_model_end` (:535) | `{"output": AIMessageChunk \| BaseMessage, "input": {"messages": [[...]]}}` | nome do modelo |
| `on_tool_start` (:681) | `{"input": {<kwargs da tool>}}` (ou `{}`) | nome da tool |
| `on_tool_end` (:734) | `{"output": <retorno da tool>, "input": {...}}` | nome da tool |
| `on_tool_error` (:715-727) | `{"error": BaseException, "input": {...}, "tool_call_id": str \| None}` | nome da tool |

Detalhes confirmados no fonte:

- `on_chat_model_end` → `output` é o `chunk.message` da primeira geração, ou seja um
  `AIMessageChunk` quando houve streaming (event_stream.py:509-517), com `tool_calls`
  já agregados.
- `on_tool_end` → com `ToolNode`, a tool é chamada com um `ToolCall` dict
  (`call_args = {**injected_call, "type": "tool_call"}`, tool_node.py:1100-1105), então o
  `BaseTool` devolve um **`ToolMessage`**, e é isso que vai em `data["output"]`.
- A tabela oficial do docstring de `astream_events` (base.py:1413-1429) bate com isso.

---

## 4. Serialização do `data` — é o ponto crítico do AC-05

**Sim, `data` contém objetos que `json.dumps` puro NÃO serializa**: `AIMessageChunk`,
`ToolMessage`, `HumanMessage`/`SystemMessage` (dentro de `input.messages`), e — no caso de
`on_tool_error` — um `BaseException` cru.

### Caminho oficial: `langchain_core.load.dumpd` / `dumps`

`langchain_core/load/dump.py` (tag 1.6.3):

```python
def dumpd(obj: Any) -> Any:
    """Return a dict representation of an object.
    Returns: Dictionary that can be serialized to json using json.dumps."""
    obj = _dump_pydantic_models(obj)
    return _serialize_value(obj)
```

`_serialize_value` (`langchain_core/load/_validation.py`:69-102) recursa em dict/list/tuple,
serializa qualquer `Serializable` (mensagens LangChain são `Serializable`) e, para qualquer
coisa que não seja JSON-nativa, **cai em `to_json_not_implemented(obj)` em vez de levantar**.

> Consequência prática importante: **`dumpd` nunca explode**, nem no `on_tool_error` com o
> `BaseException` dentro — o erro vira `{"lc": 1, "type": "not_implemented", ...}`.
> Isso é o que torna `dumpd` seguro como serializador universal do StreamEvent inteiro.

Uso no handler SSE (o StreamEvent **inteiro**, como o AC-05 exige):

```python
import json
from langchain_core.load import dumpd

async for ev in graph.astream_events(
    inputs, version="v2", include_types=["chat_model", "tool"]
):
    yield f"data: {json.dumps(dumpd(ev), ensure_ascii=False)}\n\n"
```

ou, equivalente, `langchain_core.load.dumps(ev)` que já faz `json.dumps` por dentro
(dump.py:69-103). `dumps` recusa receber `default=` como kwarg (levanta `ValueError`).

### Formato de saída — atenção ao consumidor

`dumpd` produz o formato **LC constructor**, não um dict "bonito" de mensagem:

```json
{"lc": 1, "type": "constructor",
 "id": ["langchain_core","messages","ai","AIMessageChunk"],
 "kwargs": {"content": "Olá", ...}}
```

Alternativa se o front preferir algo plano: `ev["data"]["chunk"].model_dump(mode="json")`.
Mas isso **não** é "o StreamEvent inteiro" e quebraria o AC-05 ao pé da letra.
Recomendação: `dumpd` no evento inteiro.

Cuidado adicional lido no docstring do módulo: dicts do usuário que contenham a chave `"lc"`
são escapados como `{"__lc_escaped__": {...}}`. Irrelevante para nós, mas explica ruído
eventual no payload.

### Um detalhe sobre nova-linha no SSE

`json.dumps` escapa `\n` dentro das strings, então o payload nunca quebra o frame SSE.
Mas **não** use `pretty=True` / `indent` — o JSON multi-linha quebraria o `data:` do SSE.

---

## 5. `ToolNode` + `tools_condition` cobrem o AC-03?

**Sim, cobrem. Não precisa de nó manual.**

`langgraph/prebuilt/__init__.py` (branch `main`, versão `langgraph-prebuilt==1.1.0`) exporta:

```python
__all__ = ["create_react_agent", "ToolNode", "ToolCallTransformer", "tools_condition",
           "ValidationNode", "InjectedState", "InjectedStore", "ToolRuntime"]
```

`tools_condition` (`langgraph/prebuilt/tool_node.py`:1582-1605):

```python
def tools_condition(
    state: list[AnyMessage] | dict[str, Any] | BaseModel,
    messages_key: str = "messages",
) -> Literal["tools", "__end__"]:
```

*"if the last `AIMessage` contains tool calls, route to the tool execution node;
otherwise, end the workflow"* — que é literalmente o AC-03.

Grafo mínimo:

```python
from typing import Annotated
from typing_extensions import TypedDict
from langgraph.graph import StateGraph, START
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition

class State(TypedDict):
    messages: Annotated[list, add_messages]

llm_with_tools = llm.bind_tools(tools)

async def chatbot(state: State):
    return {"messages": [await llm_with_tools.ainvoke(state["messages"])]}

builder = StateGraph(State)
builder.add_node("chatbot", chatbot)
builder.add_node("tools", ToolNode(tools))
builder.add_edge(START, "chatbot")
builder.add_conditional_edges("chatbot", tools_condition)   # -> "tools" ou END
builder.add_edge("tools", "chatbot")                        # volta para o modelo
graph = builder.compile()
```

O nó de tools **precisa se chamar `"tools"`**, porque `tools_condition` retorna a string
literal `"tools"`. Se usar outro nome, passe o mapa:
`add_conditional_edges("chatbot", tools_condition, {"tools": "meu_no", "__end__": END})`.

**Gotcha relevante para o AC-05**: `ToolNode` **captura exceções da tool por padrão**
(`handle_tool_errors=True`; tool_node.py:1129-1157) e devolve um `ToolMessage` com
`status="error"`. Mas o `on_tool_error` **ainda assim é emitido** pelo `BaseTool` antes de a
exceção subir até o `ToolNode`. Ou seja: em caso de tool com erro o SSE vê `on_tool_error`
(não `on_tool_end`), e o grafo segue normalmente. — Esta última frase é **inferência a partir
do fluxo de callbacks do `BaseTool`**; não rodei o cenário. O que está confirmado no fonte é
que `on_tool_error` existe, tem `root_type == "tool"` e passa pelo filtro.

---

## 6. Como garantir que `on_chat_model_stream` realmente emita

**A descoberta mais útil da pesquisa: dentro de `astream_events` o auto-streaming já liga
sozinho, mesmo se o nó chamar `ainvoke` (não `astream`).**

`BaseChatModel._should_stream` (`langchain_core/language_models/chat_models.py`:549-585):

```python
if self._streaming_disabled(**kwargs):
    return False
# Affirmative: explicit `stream=<truthy>` kwarg.
if kwargs.get("stream"):
    return True
# Affirmative: instance-level `streaming=True` attribute.
if ("streaming" in self.model_fields_set
        and getattr(self, "streaming", None) is True):
    return True
# Affirmative: a v1 streaming callback handler is attached.
handlers = run_manager.handlers if run_manager else []
return any(isinstance(h, _StreamingCallbackHandler) for h in handlers)
```

E `_AstreamEventsCallbackHandler` **é** um `_StreamingCallbackHandler`
(event_stream.py:101-103: `class _AstreamEventsCallbackHandler(AsyncCallbackHandler, _StreamingCallbackHandler[Any])`).
Logo, o simples fato de estarmos dentro de `astream_events` já satisfaz a última condição, o
modelo vai pela API de streaming e dispara `on_llm_new_token` → `on_chat_model_stream`.

### O que DESLIGA o streaming (as armadilhas reais)

`_streaming_disabled` (chat_models.py:525-547) — qualquer um destes mata o
`on_chat_model_stream`, **sobrepondo-se a todos os gatilhos afirmativos**:

1. `self.disable_streaming is True`
2. `self.disable_streaming == "tool_calling"` **e** `tools` passadas na chamada
   — mortal justamente no nosso caso, que é um agente com tools
3. `stream=False` nos kwargs da chamada
4. **`streaming=False` passado explicitamente no construtor** (a checagem é
   `"streaming" in self.model_fields_set and ... is False`, ou seja, o default
   `streaming: bool = False` NÃO desliga nada — só desliga se você escrever `streaming=False`)

`ChatOpenAI` tem `streaming: bool = False` (langchain_openai/chat_models/base.py:866) e
**não sobrescreve `disable_streaming`**, que herda o default `False` de `BaseChatModel`
(chat_models.py:337). Ou seja, `ChatOpenAI()` puro já emite `on_chat_model_stream` dentro
de `astream_events`.

### Recomendação

Passar `streaming=True` explicitamente — é redundante mas torna a intenção óbvia e imune a
um refactor que tire o modelo de dentro do `astream_events`:

```python
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(model="gpt-4o-mini", temperature=0, streaming=True)
```

ou, com o meta-pacote `langchain` instalado:

```python
from langchain.chat_models import init_chat_model
llm = init_chat_model("openai:gpt-4o-mini", temperature=0, streaming=True)
```

(`init_chat_model` está em `langchain.chat_models`, confirmado em
`libs/langchain_v1/langchain/chat_models/__init__.py` na tag `langchain==1.4.0`.)

**Não escreva `streaming=False` e não configure `disable_streaming`.** E o nó pode usar
`ainvoke` tranquilamente — não é obrigatório usar `astream` dentro do nó.

Um alerta lateral: existe um caminho "v2 protocol streaming"
(`_should_use_protocol_streaming`, chat_models.py:587-643) que só se ativa quando um
`_V2StreamingCallbackHandler` está anexado. O `_AstreamEventsCallbackHandler` **não** herda
dessa classe, então nosso caminho continua sendo o clássico `on_llm_new_token`. Sem impacto.

---

## Resumo executivo

1. `astream_events(version="v2")` **existe, é o default e não é deprecado** em
   `langchain-core==1.6.3`. Num grafo LangGraph compilado ele delega para a implementação
   do core (`Pregel.astream_events` só intercepta `v3`).
2. `include_types=["chat_model","tool"]` deixa passar os 5 eventos esperados **+ `on_tool_error`**
   (e, teoricamente, `on_tool_stream`). Bloqueia todo `on_chain_*` / `on_prompt_*` / `on_retriever_*`.
3. Chaves do `StreamEvent`: `event`, `name`, `run_id`, `tags`, `metadata`, `data`, `parent_ids` (7).
4. `data` **não** é JSON-serializável direto. Use `langchain_core.load.dumpd(event)` + `json.dumps`.
   `dumpd` nunca levanta exceção (fallback `not_implemented`), o que cobre até o
   `BaseException` do `on_tool_error`.
5. `ToolNode` + `tools_condition` cobrem o AC-03 sem nó manual; o nó de tools deve se chamar `"tools"`.
6. Streaming de token já liga sozinho dentro do `astream_events`. O risco não é esquecer de
   ligar, é **desligar sem querer** (`streaming=False`, `disable_streaming="tool_calling"`, `stream=False`).

## Incertezas declaradas

- Até quando `v2` continua suportado depois de `langchain-core` 1.6.x: **não confirmado**
  (nenhuma deprecation policy no fonte).
- Que `on_tool_error` é o evento efetivamente visto quando `ToolNode` engole a exceção:
  **inferência** a partir do fluxo de callbacks, não executada.
- Nada aqui foi validado executando código — é tudo leitura de fonte primária. Vale um
  smoke test antes de fechar o AC-05.
