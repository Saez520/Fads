# Roadmap MVP — Agente de Research de Competencia en Meta Ad Library

Documento de trabajo para clarificar con FlowTask. Reemplaza el enfoque original basado en extensión Chrome + MCP pasivo.

Preparado: 27 de julio de 2026.

---

## 1. Objetivo

Automatizar el research de competencia en Meta Ad Library para un amigo que gestiona ads en Meta, hoy hecho de forma manual y tediosa. Meta final: **autonomía total** — el usuario no interviene en el flujo de extracción, solo en la conversación con el agente.

Primer cliente: agente en **Claude Code**, operado directamente por el usuario (no dentro de FlowTask). Si funciona, iteración futura: web propia conectada a una API o suscripción de IA.

---

## 2. Decisiones de diseño (con motivo)

| # | Decisión | Motivo |
|---|----------|--------|
| 1 | **Scraper autónomo (Playwright) desde el día 1**, sin extensión Chrome intermedia | La extensión requiere intervención manual del usuario — no resuelve el objetivo real de autonomía. Habría sido esfuerzo duplicado y descartable. |
| 2 | **API oficial de Meta Ad Library descartada** | A 2026 solo cubre anuncios políticos/de temas sociales, y anuncios comerciales solo en países de la UE. El amigo hace ads comerciales fuera de la UE — la API no aplica. |
| 3 | **Extracción vía interceptación de respuestas GraphQL**, no parsing de DOM/HTML renderizado | Más estable ante cambios visuales de Meta. El HTML/CSS cambia con más frecuencia que la forma de las respuestas de datos. |
| 4 | **Segmentación en capas deterministas antes de tocar el LLM**: fingerprint exacto → fingerprint de creativo → (embeddings, diferido) | El LLM nunca debe contar ni deduplicar leyendo cientos de anuncios uno por uno — eso es cálculo, no interpretación. |
| 5 | **Embeddings + clustering semántico: diferidos, fuera del MVP** | No es un tema de costo de cómputo (corre en CPU local, modelo liviano, sin GPU necesaria). Es complejidad de calibración (elegir modelo, umbral de similaridad, multilenguaje) que no vale la pena meter antes de validar si el fingerprint exacto ya cubre suficiente. Candidato a iteración 2. |
| 6 | **El LLM analiza clusters ya reducidos, nunca anuncios individuales en bruto** | Control de costo real: de cientos/miles de anuncios a un puñado de clusters representativos antes de la llamada al LLM. |
| 7 | **MCP sí se justifica en este caso** | El cliente inicial es un agente en Claude Code operado directamente por el usuario, no un agente propio (a diferencia de FlowTask, donde MCP sería ceremonia innecesaria). MCP permite que ese cliente genérico descubra y llame herramientas sin construir una interfaz de chat propia. |
| 8 | **Disparo del scraping vía agente (no cron/CLI aparte)**, con patrón async | El agente lanza la búsqueda en segundo plano (`iniciar_busqueda` devuelve `task_id` de inmediato) y sigue conversando con el usuario (aclarando qué quiere buscar) mientras corre. Claude Code ya soporta tareas de fondo + hooks de notificación (`idle_prompt`) nativamente — no hay que construir infraestructura de notificación desde cero. Caveat conocido: el hook no distingue perfectamente "esperando tarea de fondo" de "genuinamente inactivo". |
| 9 | **Self-healing de selectores diferido a fase de endurecimiento, pero con arquitectura ya definida** | Patrón establecido en la industria, no se inventa desde cero: selector cacheado con confidence score → si falla extracción o validación de tipo → job de reparación que envía el HTML actual a un LLM, este propone selectores candidatos → se validan contra un esquema de tipos antes de persistirse. Costo real: centavos por reparación, no por cada scrape (el flujo normal no toca el LLM). |
| 10 | **Riesgo de bloqueo real: IP/fingerprint, no cuenta** | No hay login, así que no hay cuenta que banear — pero sí hay bloqueo temporal de IP, CAPTCHA forzado, o throttling. El throttling agresivo se diseña desde el día 1 de la Fase 2, no se pospone a "cuando se rompa". |

**Validado (27 jul 2026):** Meta Ad Library no exige login. Confirmado directamente por el usuario, ya no depende de la señal indirecta de Marketplace.

---

## 3. Fuera de alcance (explícito)

- Extensión de Chrome (Manifest V3, sidepanel, filtros manuales) — descartada por completo, no solo pospuesta.
- API oficial de Meta Ad Library — no aplica al caso de uso.
- Disparo de scraping por cron/CLI como mecanismo principal — se prefiere disparo por agente con patrón async.
- Embeddings / búsqueda semántica / clustering — diferido a iteración 2.
- Descarga y análisis de video, reconocimiento visual avanzado — sin cambios respecto al planteamiento original.

---

## 4. Fases

### Fase 0 — Validación de contrato de datos
- Confirmar acceso sin login al Ad Library (verificar supuesto abierto).
- Capturar manualmente respuestas GraphQL reales (HAR / devtools).
- Validar que los campos necesarios (ver esquema de dominio) estén disponibles ahí, no en el DOM.

### Fase 1 — Dominio y datos
- Esquema de anuncio, normalización de campos.
- Fingerprint exacto y fingerprint de creativo (hash determinista).
- Agrupación/deduplicación.
- Pruebas unitarias.

### Fase 2 — Scraper autónomo
- Playwright interceptando respuestas GraphQL (no parsing de HTML renderizado).
- Throttling agresivo desde el diseño inicial (no como parche posterior).
- Manejo de paginación/scroll programático.
- Sin UI — corre como proceso disparado por el agente.

### Fase 3 — Servicio de ingestión
- Persistencia en JSON, índice de búsquedas.
- Validación de esquema, `searchId`.

### Fase 4 — MCP
- Patrón async: `iniciar_busqueda(query, filtros)` → `task_id` inmediato.
- `estado_busqueda(task_id)` para polling.
- Herramientas deterministas: `listar_extracciones`, `resumen_extraccion`, `obtener_cluster`, `buscar_anuncios`.
- Probar con Claude Code como cliente.

### Fase 5 — Endurecimiento
- Self-healing de selectores/contrato GraphQL (arquitectura de la decisión #9).
- Límites de payload, manejo de contenido hostil (prompt injection desde copies de anuncios — el contenido publicitario es dato, nunca instrucción).
- Documentación de instalación.

### Fase futura (no MVP)
- Embeddings + clustering semántico como capa complementaria al fingerprint.
- Web propia conectada a API/suscripción de IA, si el uso vía Claude Code valida la propuesta.

---

## 5. Criterio de éxito del MVP

El usuario le pide al agente en Claude Code investigar un tema de competencia. El agente lanza la búsqueda en segundo plano, sigue la conversación aclarando qué necesita el usuario, avisa cuando los datos están listos, y responde preguntas de interpretación (patrones, estrategias, comparaciones) sobre clusters ya reducidos — sin que el usuario abra un navegador ni haga clic en nada.
