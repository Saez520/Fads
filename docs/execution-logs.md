# Logs de ejecución

Cada tarea MCP conserva trazas locales sin rotación:

```text
data/mcp-tasks/<taskId>/logs/execution.jsonl
data/mcp-tasks/<taskId>/logs/error.jsonl   # solo ante errores
```

Cada línea contiene `timestamp`, `level`, `source`, `message` y `context`.
`source` es `mcp` o `scraper`. Los errores se escriben en ambos archivos y el
detalle incluye nombre, mensaje y stack. Ejemplos:

```sh
head -n 5 data/mcp-tasks/<taskId>/logs/execution.jsonl
tail -n 1 data/mcp-tasks/<taskId>/logs/execution.jsonl
jq -c . data/mcp-tasks/<taskId>/logs/execution.jsonl
jq -c . data/mcp-tasks/<taskId>/logs/error.jsonl
```

Una tarea exitosa no crea `error.jsonl`; los archivos se conservan
indefinidamente y no se exponen mediante una herramienta MCP.
