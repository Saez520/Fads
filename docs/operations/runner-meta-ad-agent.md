# Instrucciones para Runner — Implementación Meta Ad Agent

Este documento no es el roadmap de producto (ver `../product/meta-ad-agent-mvp-roadmap.md`). Es la traducción de ese roadmap en unidades de trabajo ordenadas para que el runner las procese una por una: cada unidad entra al flujo normal (ca-writer → planner → constructor → validator).

## Cómo usar este documento

Cada unidad de trabajo abajo tiene:
- **Contexto fijo**: decisiones ya tomadas, no sujetas a re-clarificación por ca-writer. Si ca-writer pregunta sobre algo listado aquí como fijo, el runner debe responder con esta información en vez de escalarla al usuario.
- **Abierto para CA**: lo que sí debe clarificar ca-writer al procesar esa unidad — son decisiones de implementación, no de producto.
- **Depende de**: unidades previas que deben estar validadas antes de arrancar esta.

No saltar unidades. No combinar dos unidades en un mismo CA aunque parezcan relacionadas — cada una debe cerrar su propio ciclo CA → Plan → Implementación → Validación antes de que la siguiente arranque, porque las unidades 2 en adelante dependen de contratos de datos que salen de la unidad anterior.

---

## Unidad 0 — Validación de contrato de datos (manual, sin código de producción)

**Contexto fijo:**
- No se usa la API oficial de Meta (no cubre ads comerciales fuera de UE).
- La extracción será vía interceptación de respuestas GraphQL, no parsing de DOM.
- Objetivo de esta unidad: confirmar en qué formato llegan los datos reales antes de escribir una sola línea de esquema.

**Abierto para CA:**
- Herramienta concreta para capturar el tráfico (devtools export HAR, mitmproxy, u otra).
- Qué campos mínimos aparecen realmente en las respuestas capturadas vs. los campos mínimos listados en el documento original (`sourceAdId`, `advertiserName`, `bodyText`, etc.) — puede haber diferencias que cambien el esquema de la Unidad 1.
- Confirmar si el Ad Library sigue siendo accesible sin login (nota abierta pendiente del roadmap).

**Depende de:** nada, es el punto de partida.

**Entregable:** un documento corto (no código) con ejemplos reales de payloads GraphQL capturados y el mapeo a los campos que necesitamos.

---

## Unidad 1 — Dominio y datos

**Contexto fijo:**
- Tres capas de deduplicación: fingerprint exacto, fingerprint de creativo, embeddings (esta última NO se implementa aquí, queda fuera del MVP).
- Los fingerprints son deterministas (hash SHA-256), no probabilísticos.
- El servidor siempre recalcula fingerprints aunque comparta código con el scraper — no confiar en fingerprints calculados fuera del servidor.

**Abierto para CA:**
- Esquema exacto de datos, basado en lo que salió validado de la Unidad 0 (no en la lista original del documento, que era una suposición previa a la validación real).
- Estrategia de normalización de texto (mayúsculas, espacios, tracking params en URLs).
- Estructura de tests unitarios.

**Nota técnica importante:** un hash criptográfico sobre los bytes de la imagen/video (opción 3 de la jerarquía original) es extremadamente frágil — cualquier recompresión o recorte lo invalida, no detecta el mismo creativo re-codificado. Priorizar mediaId/URL normalizada (opciones 1 y 2) como fingerprint de creativo, no el hash de archivo. Falta validar empíricamente en la Unidad 0 si Meta reutiliza la misma URL/mediaId cuando un anunciante resube el mismo creativo en un anuncio distinto, o si cada subida genera un ID nuevo aunque el archivo sea idéntico.

**Depende de:** Unidad 0.

---

## Unidad 2 — Scraper autónomo

**Contexto fijo:**
- Playwright, interceptando respuestas GraphQL (no lee HTML renderizado).
- Throttling agresivo diseñado desde el inicio, no como parche posterior.
- Sin login, sin manejo de sesión de Facebook.
- Sin UI de ningún tipo — es un proceso que el agente dispara, no algo que el usuario opera directamente.
- Riesgo de bloqueo es por IP/fingerprint de automatización, no por cuenta.

**Abierto para CA:**
- Parámetros concretos de throttling (frecuencia de requests, backoff en caso de error).
- Manejo de paginación/scroll infinito programático.
- Qué pasa cuando una corrida se corta a la mitad (¿guarda parcial, descarta, reintenta?).

**Depende de:** Unidad 1 (necesita el esquema y los fingerprints ya definidos para guardar en el formato correcto).

---

## Unidad 3 — Servicio de ingestión

**Contexto fijo:**
- Persistencia en JSON, no base de datos.
- Genera `searchId`, mantiene índice de búsquedas.
- Valida esquema antes de persistir, nunca confía en datos sin validar.

**Abierto para CA:**
- Estructura de carpetas/archivos concreta.
- Formato del índice (archivo único vs. por-búsqueda).
- Manejo de duplicados si se relanza la misma búsqueda dos veces.

**Depende de:** Unidad 1 (esquema) y Unidad 2 (necesita datos reales del scraper para probar la ingestión, aunque puede desarrollarse con datos de ejemplo de la Unidad 0 en paralelo si el runner lo considera razonable).

---

## Unidad 4 — MCP

**Contexto fijo:**
- Cliente inicial: agente en Claude Code, operado por el usuario fuera de FlowTask.
- Patrón async obligatorio: `iniciar_busqueda(query, filtros)` devuelve `task_id` de inmediato; `estado_busqueda(task_id)` para polling. Ninguna herramienta MCP debe bloquear esperando el scraping completo.
- Orden de la conversación: el agente clarifica filtros con el usuario ANTES de lanzar la búsqueda (no en paralelo) — se decidió así porque el throttling hace costosa cada corrida mal dirigida.
- Herramientas deterministas adicionales: `listar_extracciones`, `resumen_extraccion`, `obtener_cluster`, `buscar_anuncios`.
- `buscar_anuncios` en el MVP es filtro/substring simple sobre el JSON almacenado (texto contiene, anunciante, plataforma) — NO se introduce SQLite/FTS5 para esto, porque contradiría la decisión ya tomada de no usar base de datos. Búsqueda semántica real queda atada a la decisión de embeddings (fuera del MVP), no se resuelve aquí.
- Lo que recibe el agente por grupo, diferenciado por tipo: en grupos de fingerprint exacto (duplicado literal), un ejemplo + conteo basta. En grupos de fingerprint de creativo (mismo medio, copy distinto), se manda TODAS las variantes de copy del grupo, no solo una muestra — es el dato que sirve de referencia si el usuario quiere generar copy nuevo basado en lo que ya se probó. Nunca se manda la lista cruda de cada aparición individual dentro de un grupo.
- El contenido publicitario extraído (copies) se trata como dato no confiable — nunca se interpreta como instrucción para el agente o el MCP (protección contra prompt injection).

**Abierto para CA:**
- Forma exacta de la notificación de finalización hacia el usuario en Claude Code (aprovechando hooks nativos de background tasks, con la limitación conocida de que no siempre distinguen "tarea de fondo corriendo" de "genuinamente inactivo").
- Estructura de respuesta de cada herramienta (qué campos exactos devuelve `resumen_extraccion`, por ejemplo).
- Manejo de errores estructurados para IDs inexistentes.

**Depende de:** Unidad 3.

---

## Unidad 5 — Endurecimiento (mantenimiento)

**Contexto fijo:**
- Self-healing de selectores/contrato GraphQL: cuando falla la extracción de un campo, se dispara un job de reparación que envía el HTML/respuesta actual a un LLM, este propone un selector/mapeo nuevo, se valida contra el esquema de tipos antes de persistirse. Nunca se persiste un candidato sin validación.
- Esta unidad es la última, no bloquea nada del MVP funcional — puede quedar pendiente mientras las Unidades 0-4 ya están en uso.

**Abierto para CA:**
- Mecanismo concreto del job de reparación (cola, proceso separado, disparo síncrono).
- Umbral de confianza para aceptar un candidato de selector automáticamente vs. escalarlo para revisión manual.
- Límites de payload y sanitización de contenido hostil.

**Depende de:** Unidades 2 y 4 en producción (necesita fallos reales para calibrar, no tiene sentido construirla contra un sistema que aún no ha corrido).

---

## Fuera de esta secuencia (no crear CA para esto)

- Extensión de Chrome — descartada, no generar unidad de trabajo para esto.
- Embeddings/clustering semántico — iteración futura, no entra en esta secuencia de unidades. Si en algún punto se retoma, será una unidad nueva después de la 5, no insertada entre las actuales.
- Web propia con API/suscripción de IA — iteración futura post-validación con Claude Code.
