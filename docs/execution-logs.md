# Logs de ejecución

Cada tarea MCP conserva trazas locales sin rotación:

```text
data/mcp-tasks/<taskId>/logs/execution.jsonl
data/mcp-tasks/<taskId>/logs/error.jsonl   # solo ante errores
data/mcp-tasks/<taskId>/logs/diagnostic.jsonl # timeline saneado ante señales de fallo
```

Cada línea contiene `timestamp`, `level`, `source`, `message` y `context`.
`source` es `mcp` o `scraper`. Los errores se escriben en ambos archivos y el
detalle incluye nombre, mensaje y stack. Ejemplos:

```sh
head -n 5 data/mcp-tasks/<taskId>/logs/execution.jsonl
tail -n 1 data/mcp-tasks/<taskId>/logs/execution.jsonl
grep '"level":"error"' data/mcp-tasks/<taskId>/logs/execution.jsonl
jq -c . data/mcp-tasks/<taskId>/logs/execution.jsonl
jq -c . data/mcp-tasks/<taskId>/logs/error.jsonl
```

Una tarea exitosa no crea `error.jsonl`; los archivos se conservan
indefinidamente y no se exponen mediante una herramienta MCP. `execution.jsonl`
tiene un límite de 512 KiB, `error.jsonl` de 256 KiB, `diagnostic.jsonl` de
256 KiB y el total por tarea de 1 MiB. La escritura es append-only y
best-effort.

La telemetría base registra navegación, respuestas GraphQL y un resumen DOM;
el timeline detallado se conserva cuando ocurre `empty_capture`,
`unrecognized_response`, `error`, `retries_exhausted`, `rate_limit`,
`challenge`, `captcha`, `login_required` o `unknown`. Ante overflow se emite
un único evento `diagnostic.truncated` con `droppedEvents`; el resumen final
se conserva cuando el presupuesto lo permite.

El último evento de `execution.jsonl` del scraper contiene la referencia relativa
`logs/diagnostic.jsonl`, la clasificación primaria, señales DOM, duración,
`droppedEvents` y `diagnosticIncomplete`. La precedencia de clasificación es
`network_failure`, `challenge_or_http_block`, `captcha`, `ssr_results`,
`explicit_empty`, `login_required`, `shell_without_results`, `unknown`.

Nunca se persisten valores de cookies, tokens, `authorization`, headers
completos, `postData`, cuerpos completos, HTML/DOM completos, HAR, trace ni
screenshots. URLs, mensajes y stacks se sanean antes de serializar. Los logs
se retienen indefinidamente junto a la tarea y no forman parte del contrato
MCP.
