# Fads

Fads es un servidor local de [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) para investigar anuncios de Meta Ad Library. Automatiza el navegador con Playwright, captura y normaliza resultados, los persiste como JSON y expone herramientas MCP para consultar extracciones y agrupar anuncios por fingerprints deterministas.

## Estado actual

El repositorio contiene una implementación en desarrollo del scraper, la ingestión en archivos y el servidor MCP por `stdio`, junto con pruebas unitarias. No es todavía un producto distribuible:

- el paquete es privado y no publica un binario ni un comando global;
- no hay releases instalables ni integración con Homebrew, Scoop o winget;
- la ejecución requiere Node.js, npm y un navegador de Playwright instalado;
- la automatización depende del comportamiento de Meta Ad Library y puede terminar bloqueada, parcial o fallida ante cambios, CAPTCHA, rate limiting o respuestas no reconocidas;
- no hay un archivo de licencia ni una licencia declarada en `package.json`.

La distribución como binario standalone, el uso de navegadores instalados en el sistema y los canales de distribución externos son líneas de investigación futuras; no forman parte de la implementación actual.

## Funcionalidad implementada

- Scraping headless de Meta Ad Library con Playwright.
- Captura de respuestas GraphQL y recuperación de resultados SSR cuando están disponibles.
- Normalización de anuncios y fingerprints SHA-256 exactos y de creativo.
- Throttling, reintentos, paginación y diagnósticos de bloqueos o capturas incompletas.
- Persistencia local en JSON bajo `data/`.
- Servidor MCP asíncrono por `stdio` con estas herramientas:
  - `iniciar_busqueda`
  - `estado_busqueda`
  - `listar_extracciones`
  - `resumen_extraccion`
  - `obtener_cluster`
  - `buscar_anuncios`

No están implementados el clustering semántico con embeddings, una interfaz web, una extensión de navegador ni el self-healing mediante LLM.

## Requisitos

- Node.js y npm. El repositorio no fija todavía una versión mínima de Node.js.
- Chromium administrado por Playwright.

## Instalación para desarrollo

Desde la raíz de un checkout del repositorio:

```bash
npm install
npx playwright install chromium
```

## Uso local

Iniciá el servidor MCP por `stdio` desde la raíz del repositorio:

```bash
npm run mcp
```

El proceso está pensado para que un cliente MCP lo lance y se comunique con él por entrada/salida estándar; no ofrece una interfaz CLI interactiva. Configurá el cliente para ejecutar `npm run mcp` con este repositorio como directorio de trabajo.

Los datos se escriben en rutas relativas al directorio de trabajo:

```text
data/ingestions/   # extracciones publicadas
data/mcp-tasks/    # estado y logs de las tareas MCP
data/mcp-tmp/      # resultados temporales durante una extracción
```

Una búsqueda se inicia mediante `iniciar_busqueda` con `query`, `country`, `dateFrom`, `dateTo` y `adType: "all"`. La herramienta devuelve un `taskId`; el cliente puede consultar su progreso con `estado_busqueda`. Las fechas usan el formato `YYYY-MM-DD` y `country` usa un código de país de dos letras mayúsculas.

> Meta puede bloquear o limitar sesiones automatizadas. Un resultado parcial o fallido forma parte del contrato actual y debe revisarse mediante el estado y los diagnósticos de la tarea.

## Desarrollo

```bash
npm test          # ejecuta las pruebas con Vitest
npm run test:watch
npm run build     # compila TypeScript en dist/
```

## Stack técnico

- TypeScript con módulos ESM y modo estricto
- Node.js
- Model Context Protocol SDK
- Playwright
- Zod
- Vitest
- Persistencia local en JSON

## Estructura del repositorio

```text
src/
  domain/       # modelos, normalización y fingerprints
  scraper/      # navegación, captura, parsing, reintentos y diagnósticos
  ingestion/    # validación y publicación de extracciones JSON
  mcp/          # servidor, herramientas, filtros, tareas y almacenamiento
  data/         # codec JSON
tests/          # pruebas unitarias y fixtures
docs/           # roadmap de producto y documentación operativa
```

## Limitaciones conocidas

- No hay garantía de estabilidad frente a cambios internos de Meta Ad Library.
- El scraper actual lanza el Chromium administrado por Playwright; no selecciona Chrome, Edge o Chromium del sistema.
- Las tareas y extracciones se almacenan en el filesystem local, sin base de datos ni coordinación entre procesos.
- Los logs se conservan localmente y no tienen rotación temporal.
- No existe aún un flujo de instalación para usuarios finales ni configuración específica documentada para cada cliente MCP.
