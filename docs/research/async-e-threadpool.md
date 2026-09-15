# Async correto no caminho FastAPI → LangGraph → tool

Findings do ticket [#3](https://github.com/Tute24/praxis-project/issues/3) (mapa [#1](https://github.com/Tute24/praxis-project/issues/1)).

Convenção de leitura: **[V]** = verificado em fonte primária (doc oficial ou código-fonte, link ao lado).
**[I]** = inferência minha a partir da semântica de asyncio/ASGI, não escrito em lugar nenhum.
Não há nada aqui vindo só de blog post.

---

## A regra prática

> **`async def` sempre — no handler, no generator do SSE, na tool e no client HTTP.
> A única exceção é código que bloqueia e que você não controla (SDK sync, CPU pesado): esse vai para `def` ou `await asyncio.to_thread(...)` explicitamente, nunca "sem querer".**

Corolário operacional, que é o que realmente pega neste projeto: **`async def` + qualquer chamada
bloqueante lá dentro é o pior dos mundos** — trava o event loop inteiro, e não só um worker.
`def` é seguro-mas-caro; `async def` com bloqueio é inseguro.

---

## 1. `StreamingResponse`: generator async vs sync

**O que o Starlette faz** (código verbatim, `starlette/responses.py`, branch `master`)
— [fonte](https://github.com/encode/starlette/blob/master/starlette/responses.py):

```python
if isinstance(content, AsyncIterable):
    self.body_iterator = content
else:
    self.body_iterator = iterate_in_threadpool(content)
```

E `iterate_in_threadpool` (`starlette/concurrency.py`) — [fonte](https://github.com/encode/starlette/blob/master/starlette/concurrency.py):

```python
async def iterate_in_threadpool(iterator):
    as_iterator = iter(iterator)
    while True:
        try:
            yield await anyio.to_thread.run_sync(_next, as_iterator)
        except _StopIteration:
            break
```

**[V]** Generator sync → cada `next()` vira um `anyio.to_thread.run_sync`, ou seja, **pega um token
do limiter default do AnyIO (40)**, o mesmo pool que atende handlers `def` e dependências `def`.

**Correção de uma premissa do ticket:** o ticket diz que o generator sync "ocupa um worker durante
toda a vida da conexão". Pelo código acima isso é **quase** verdade, mas não literalmente: o token é
adquirido e devolvido **por item**, não pela conexão inteira. **[I]** Na prática o efeito é o mesmo
num stream de LLM, porque o tempo é gasto *dentro* do `next()` (esperando o próximo token do modelo),
e é exatamente aí que o token do limiter está emprestado. Então: sim, um stream de 8 s com generator
sync mantém um worker do AnyIO ocupado ~8 s. A diferença importa só para entender que o worker não
fica preso em gaps ociosos.

**Decisão:** o generator do SSE é `async def` obrigatoriamente. Com generator async o Starlette não
toca no threadpool — zero workers consumidos por conexão. **[V]**

---

## 2. Cancelamento: o que acontece quando o cliente desconecta

### Como o Starlette detecta a desconexão

Também verbatim de `responses.py`:

```python
spec_version = tuple(map(int, scope.get("asgi", {}).get("spec_version", "2.0").split(".")))

if spec_version >= (2, 4):
    try:
        await self.stream_response(send)
    except OSError:
        raise ClientDisconnect()
else:
    async with create_collapsing_task_group() as task_group:
        async def wrap(func):
            await func()
            task_group.cancel_scope.cancel()
        task_group.start_soon(wrap, partial(self.stream_response, send))
        await wrap(partial(self.listen_for_disconnect, receive))
```

**[V]** O **uvicorn de hoje anuncia `spec_version: "2.3"`**
([`uvicorn/protocols/http/httptools_impl.py`](https://github.com/encode/uvicorn/blob/master/uvicorn/protocols/http/httptools_impl.py),
linha do `scope`), então **o caminho que roda de fato é o `else`**: um task group corre
`stream_response` e `listen_for_disconnect` em paralelo; quem terminar primeiro cancela o
`cancel_scope`. Chegou `http.disconnect` → o task group **cancela** a task que está iterando o
generator.

### Por que o generator precisa de um `await`

A doc oficial do FastAPI diz, textualmente, que o async generator deve conter um `await`
(sugestão explícita: `await anyio.sleep(0)`) **"so the event loop can process task cancellation"**
— [Custom Response / StreamingResponse](https://fastapi.tiangolo.com/advanced/custom-response/). **[V]**

**[I]** O mecanismo: `asyncio` só entrega `CancelledError` num *checkpoint* — um `await` que realmente
suspende. O `await send(...)` do `stream_response` existe a cada chunk, mas não é garantido que
suspenda (o uvicorn pode escrever no buffer do transporte e retornar sem ceder ao loop). Se o corpo
do seu generator faz só trabalho síncrono entre os `yield`, pode não existir checkpoint nenhum, e o
cancelamento fica pendurado. `await anyio.sleep(0)` força um checkpoint incondicional.

**Aqui isso é quase não-problema**, porque o generator vai fazer `async for event in graph.astream_events(...)`,
e cada iteração desse `async for` é um `await` de verdade que suspende esperando token do modelo. **[I]**
Ainda assim, um `await anyio.sleep(0)` por iteração custa ~nada e torna o cancelamento determinístico.

### O grafo não fica órfão (de graça)

`Runnable.astream_events` → `_astream_events_implementation_v2` em
[`langchain_core/tracers/event_stream.py`](https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/tracers/event_stream.py):
ele roda o grafo numa **task de background** (`asyncio.create_task(consume_astream())`) que alimenta
uma fila, e no `finally` faz:

```python
finally:
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
```

**[V]** E `astream_events` em `runnables/base.py` envolve o stream em `async with aclosing(event_stream):`,
o que garante que o `finally` roda quando o consumidor fecha o generator. **[V]**

**Consequência prática:** se o seu generator SSE for cancelado, o `GeneratorExit`/`CancelledError`
se propaga → `aclosing` fecha o event stream → `finally` cancela a task do grafo. **Não precisa de
nada manual.** O que você *não pode* fazer é engolir a cancelação:

- **Armadilha:** `try: ... except Exception: pass` em volta do loop. `CancelledError` herda de
  `BaseException` (Py 3.8+), então `except Exception` não pega — ok. Mas `except BaseException` ou
  um `except asyncio.CancelledError` que não faz `raise` **deixa o grafo órfão**. **[I]**
- **Armadilha:** consumir `astream_events` numa task separada que você mesmo criou e nunca cancela.
  Aí o `aclosing` do seu generator não alcança ela.
- **Armadilha:** fazer cleanup com `await` depois de já ter sido cancelado, sem `asyncio.shield`
  ou `anyio.CancelScope(shield=True)` — o `await` de cleanup é re-cancelado imediatamente. **[I]**

---

## 3. Tool sync com `@tool`, executada por um grafo em `astream_events`

**[V]** Sim, vai para um executor — mas **não para o threadpool do AnyIO**. Isso é o achado mais
contraintuitivo da pesquisa.

Cadeia verificada no código do `langchain-core`:

1. `BaseTool.ainvoke` → se a tool não tem `coroutine`:
   `return await run_in_executor(config, self.invoke, input, config, **kwargs)`
   ([`tools/base.py`](https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/tools/base.py)).
2. `BaseTool._arun` default: `return await run_in_executor(None, self._run, *args, **kwargs)` (idem).
3. `StructuredTool._arun`: usa `self.coroutine` se existir, senão delega para `super()._arun()`
   ([`tools/structured.py`](https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/tools/structured.py)).
4. `run_in_executor` ([`runnables/config.py`](https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/runnables/config.py))
   chama `asyncio.get_running_loop().run_in_executor(None, ...)` quando o config é `None`/dict —
   isto é, o **default executor do asyncio**, com `copy_context().run(...)` em volta para preservar
   contextvars.

**O ponto:** a doc do AnyIO é explícita — o limiter default de 40 threads
**"does not affect the default thread pool executor used by asyncio"**
([`docs/threads.rst`](https://github.com/agronholm/anyio/blob/master/docs/threads.rst)). **[V]**

Ou seja, existem **dois pools independentes** no mesmo processo:

| Pool | Quem usa | Tamanho default |
|---|---|---|
| AnyIO default thread limiter | handler `def`, dependência `def`, `iterate_in_threadpool`, `run_in_threadpool` | **40** tokens ([AnyIO docs](https://github.com/agronholm/anyio/blob/master/docs/threads.rst)) **[V]** |
| `asyncio` default `ThreadPoolExecutor` | `run_in_executor` do LangChain (tool sync) | `min(32, os.cpu_count() + 4)` (default do CPython) **[V]** |

**Diferença observável entre tool sync e tool `async def`:**

- **Tool `async def`** → roda no event loop, custo zero de thread, cancelamento imediato no `await`.
- **Tool sync** → hop de thread por chamada (latência de agendamento, desprezível aqui), consome uma
  thread do executor do asyncio, e **é efetivamente incancelável**: `run_in_executor` devolve um
  Future; cancelar o Future não mata a thread — o corpo da tool roda até o fim. **[I]** (mesmo
  princípio que o AnyIO documenta explicitamente para `abandon_on_cancel`: *"the thread will still
  run its course but its return value (or any raised exception) will be ignored"* **[V]**).
  Numa desconexão no meio do tool call, a tool sync termina de rodar sozinha.
- **Nos eventos SSE não muda nada.** `on_tool_start` / `on_tool_end` são emitidos igual nos dois casos. **[I]**

**Decisão:** `get_weather` é `async def`. Não porque o pool vá estourar, mas porque com `async def`
não existe a pergunta.

---

## 4. O sleep de ~2 s do AC-03

**`asyncio.sleep(2)`** (ou `anyio.sleep(2)`). Confirmado que a diferença é categórica:

- `await asyncio.sleep(2)` → cede o loop. Custo: **zero**. N requests concorrentes = N sleeps
  simultâneos. Cancelável instantaneamente.
- `time.sleep(2)` **dentro de uma tool `async def`** (ou de qualquer `async def` no caminho) →
  **trava o event loop inteiro por 2 s**. Todas as conexões SSE congelam, todos os handlers param,
  os healthchecks param. Este é o caso grave. **[V]** pela própria doc do FastAPI sobre `async def`
  rodar no loop ([async](https://fastapi.tiangolo.com/async/)).
- `time.sleep(2)` dentro de uma **tool sync** → prende **uma thread do executor do asyncio** por 2 s.
  O loop continua vivo. É o caso "só um worker". **[V]** pela cadeia da pergunta 3.

Então a resposta honesta ao "o loop inteiro, ou só um worker?" é: **depende de onde o `time.sleep`
está**. Na tool `async def` que o projeto vai escrever, seria o loop inteiro.

Detalhe fino **[V]**: `anyio.to_thread.run_sync` tem `abandon_on_cancel=False` por default
([`anyio/to_thread.py`](https://github.com/agronholm/anyio/blob/master/src/anyio/to_thread.py)),
ou seja, a task que espera a thread é **blindada contra cancelamento** até a thread terminar.
Um `time.sleep(2)` num caminho que passa pelo AnyIO adia o cancelamento em 2 s.

---

## 5. O cliente da OpenAI: async de ponta a ponta?

**[V]** Sim, no caminho que importa. Em
[`langchain_openai/chat_models/base.py`](https://github.com/langchain-ai/langchain/blob/master/libs/partners/openai/langchain_openai/chat_models/base.py):

- `validate_environment()` constrói `self.root_async_client = openai.AsyncOpenAI(**client_params, **async_specific)`
  — cliente async nativo, com `http_async_client` (`httpx.AsyncClient`) por baixo.
- `_agenerate` / `_astream` fazem `raw_response = await self.async_client.with_raw_response.create(**payload)`.

Então `ChatOpenAI.astream` / o grafo rodando por `astream_events` usam `AsyncOpenAI` + `httpx.AsyncClient`.
Sem trecho sync escondido no caminho de streaming.

**Trechos sync que existem no módulo, e quando mordem:**

- **Contagem de tokens** (`get_num_tokens_from_messages` → `tiktoken.encoding_for_model(model)` /
  `encoding.encode(text)`) é **síncrono e não é jogado em executor**. **[V]** Não é chamado
  automaticamente no `_astream`, só se você chamar. **[I]** Pior: a primeira chamada de
  `encoding_for_model` **baixa o BPE por HTTP síncrono**. Se você chamar isso dentro do handler
  `async def`, trava o loop pelo download. **Armadilha real, mesmo neste projeto**, se algum dia
  entrar contagem de tokens no stream.
- **[I]** A construção do client (`validate_environment`) é sync. Se `ChatOpenAI(...)` for
  instanciado *por request* dentro do handler, você paga construção de cliente + parse de env no
  loop a cada request. Instancie uma vez no `lifespan` e guarde em `app.state`.

---

## 6. Risco concreto de threadpool starvation nesta app? — resposta honesta

**Não. Com carga baixa e o desenho previsto (handler `async def`, generator `async def`, tool
`async def`), o risco de starvation nesta app é essencialmente zero. A preocupação é estrutural
e didática, não operacional.**

O raciocínio, explícito para poder ser contestado:

1. Com **tudo async**, o número de threads consumidas por request é **zero**. Não existe pool para
   esfomear. Starvation exige que alguém entre num pool.
2. Mesmo no cenário errado (tool **sync** bloqueando 2 s), o pool relevante é o do asyncio
   (`min(32, cpu+4)` ≈ 12–32 threads) e cada request segura uma thread por ~2 s. Saturar isso pede
   dezenas de requests **simultâneos**. Este é um projeto de P1 com um usuário e um front local.
3. O pool do AnyIO (40) só entra se alguém escrever um handler `def`, uma dependência `def`, ou
   passar um generator sync para o `StreamingResponse`. Nenhum desses está no plano.

**O que é risco real aqui, em ordem:**

1. **Bloquear o event loop** (`time.sleep`, `requests`, `tiktoken`, I/O de arquivo sync dentro de
   `async def`). Com **um único** request isso já degrada tudo. Não precisa de carga. Este é o bug
   que vale gastar atenção.
2. **Grafo órfão na desconexão**, se alguém engolir `CancelledError`. Custa token de LLM de verdade.
3. Starvation de threadpool: distante terceiro, e só se o desenho for violado.

**Por que ainda vale ter a restrição no mapa:** a nota do Arthur no charting não é paranoia — é a
intuição certa vinda de .NET (`Task.Result` / `.Wait()` em ASP.NET clássico é exatamente esse bug) e
de Node (bloquear o loop). Ela só está apontada para o pool errado. O valor de manter "isso bloqueia
o loop, ou come worker?" como pergunta por camada é **didático e de higiene de desenho**, e isso é
legítimo. Só não deve ser vendido como mitigação de um risco de produção que esta app não tem.

**O que NÃO fazer:** subir `limiter.total_tokens` de 40 para 100 no `lifespan`
([receita do fastapi-tips](https://github.com/kludex/fastapi-tips)). É solução para um problema que
esta app não tem, e mascararia o bug real (código bloqueante) em vez de corrigi-lo.

---

## Checklist derivado (para os tickets de código)

- [ ] Handler `POST /agent/execute`: `async def`.
- [ ] Generator do SSE: `async def`, com `await anyio.sleep(0)` por iteração.
- [ ] Dependências do FastAPI: `async def` (senão viram thread do AnyIO). **[V]** fastapi-tips.
- [ ] Tool `get_weather`: `async def`, sleep com `await asyncio.sleep(2)`.
- [ ] `ChatOpenAI` instanciado uma vez no `lifespan`, não por request.
- [ ] Nada de `except BaseException` / `except CancelledError` sem `raise` em volta do
      `async for` do `astream_events`.
- [ ] Proibidos no caminho async: `time.sleep`, `requests`, `open()` em loop quente,
      `tiktoken.encoding_for_model`.

## Fontes

Todas primárias, consultadas via Context7 MCP e leitura direta do código-fonte:

- FastAPI docs: [`/async`](https://fastapi.tiangolo.com/async/),
  [`/advanced/custom-response`](https://fastapi.tiangolo.com/advanced/custom-response/),
  [`/advanced/stream-data`](https://fastapi.tiangolo.com/advanced/stream-data/)
- [kludex/fastapi-tips](https://github.com/kludex/fastapi-tips) (Marcelo Trylesinski, mantenedor de Starlette/Uvicorn)
- Starlette `master`: `starlette/responses.py`, `starlette/concurrency.py`
- Uvicorn `master`: `uvicorn/protocols/http/httptools_impl.py`
- AnyIO 4.11: `src/anyio/to_thread.py`, `src/anyio/_backends/_asyncio.py`, `docs/threads.rst`
- `langchain-core`: `tools/base.py`, `tools/structured.py`, `runnables/config.py`,
  `runnables/base.py`, `tracers/event_stream.py`
- `langchain-openai`: `chat_models/base.py`
