CA-meta-ad-agent-u2 — Extrae anuncios del Ad Library de forma autónoma

## Clasificación

**Tipo de intención:** Nueva funcionalidad
**Complejidad:** Moderada

---

## Contexto

El agente necesita reunir anuncios del Ad Library a partir de una palabra o frase de búsqueda para alimentar el flujo posterior de análisis. La extracción debe respetar un ritmo conservador desde el inicio para reducir el riesgo operativo de que el acceso automatizado sea limitado.

La Unidad 1 ya definió el formato normalizado y los fingerprints de los anuncios y creativos. Esta unidad debe producir registros compatibles con ese contrato, sin introducir una interfaz humana, autenticación ni filtros de negocio.

---

## Requisito funcional

### Recibir y ejecutar una búsqueda autónoma

El proceso debe recibir exclusivamente una `query` como texto no vacío, correspondiente a una palabra o frase de búsqueda. Cada corrida procesa una sola query; no acepta filtros ni combina varias queries.

Debe abrir el Ad Library sin iniciar sesión y obtener anuncios mediante la interceptación de respuestas GraphQL, sin depender del contenido HTML mostrado. Los anuncios obtenidos deben transformarse y guardarse como registros compatibles con el esquema, normalización y fingerprints definidos en la Unidad 1.

### Cargar resultados de forma acotada

Para una misma query, el proceso debe realizar scrolls programáticos sucesivos para solicitar más resultados. Debe detener la carga cuando alcance 1.500 anuncios o cuando un scroll ya no produzca resultados nuevos, lo que ocurra primero.

### Aplicar throttling y responder a fallos

Entre acciones que puedan provocar carga adicional, el proceso debe esperar un intervalo aleatorio de entre 8 y 15 segundos.

Ante un error temporal, debe reintentar como máximo tres veces, esperando 1, 2 y 4 minutos respectivamente. Si recibe una señal final de limitación de ritmo —por ejemplo, un error GraphQL con mensaje `Rate limit exceeded`, severidad `CRITICAL`, código `1675004` e indicador final— debe detener la corrida inmediatamente y no realizar más reintentos.

### Conservar resultados parciales y reportar el resultado

Si una corrida se interrumpe por un fallo, limitación o corte antes de completar, debe conservar los anuncios ya capturados en el formato de Unidad 1 y marcar el resultado como incompleto. La próxima corrida de la misma query comienza desde cero; no continúa desde el punto de corte.

Al terminar, debe producir un resumen operativo con: query recibida, cantidad de anuncios capturados, estado (`completa`, `incompleta` o `bloqueada`), motivo de corte y duración total.

---

## Criterios de aceptación

- [ ] Dada una query de texto válida, cuando se inicia una corrida, entonces el proceso ejecuta una única búsqueda sin login ni UI y captura respuestas GraphQL del Ad Library sin leer el HTML renderizado.
- [ ] Dada una corrida con resultados adicionales, cuando se realiza scroll programático, entonces el proceso sigue cargando resultados de la misma query hasta capturar 1.500 anuncios o hasta que un scroll no aporte anuncios nuevos, lo que ocurra primero.
- [ ] Dada una acción que carga resultados, cuando se programa la siguiente acción de carga, entonces transcurren entre 8 y 15 segundos elegidos de forma variable.
- [ ] Dado un error temporal recuperable, cuando la corrida reintenta, entonces espera 1 minuto antes del primer reintento, 2 antes del segundo y 4 antes del tercero; no realiza un cuarto reintento.
- [ ] Dada una respuesta final de limitación de ritmo con `Rate limit exceeded`, severidad `CRITICAL` y código `1675004`, cuando se detecta, entonces la corrida se detiene y queda en estado `bloqueada` — no continúa cargando ni reintentando.
- [ ] Dada una corrida interrumpida después de capturar anuncios, cuando finaliza, entonces conserva los registros parciales en el formato de Unidad 1 y los marca como `incompleta`.
- [ ] Dada una nueva corrida para una query que tuvo una ejecución incompleta, cuando comienza, entonces inicia desde el principio — no reanuda un punto de scroll anterior.
- [ ] Dada cualquier finalización de corrida, cuando se emite el resultado operativo, entonces informa query, cantidad capturada, estado, motivo de corte y duración.
- [ ] Dados anuncios capturados, cuando se produce la salida de la corrida, entonces los registros respetan el esquema, normalización y fingerprints definidos por la Unidad 1.
- [ ] Dada una solicitud que incluya filtros además de la query, cuando se intenta iniciar la corrida de Unidad 2, entonces no se aplican filtros de búsqueda en esta unidad.

---

## Tradeoffs y GAPs

**Tradeoffs asumidos:**
- Cadencia aleatoria de 8–15 segundos: reduce la intensidad de acceso automatizado, a cambio de prolongar cada corrida.
- Backoff de 1, 2 y 4 minutos, con tres reintentos: tolera fallos temporales sin insistir indefinidamente, a cambio de demorar una corrida con errores.
- Detención ante señal final de limitación: evita agravar un bloqueo, a cambio de dejar datos parciales.
- Conservación parcial sin reanudación: preserva datos útiles y evita estado de continuidad frágil, a cambio de repetir la búsqueda completa en una futura corrida.
- Una query por corrida, con múltiples scrolls: mantiene cada ejecución acotada y trazable, a cambio de no combinar objetivos en una única ejecución.

**GAPs conocidos:**
- No hay login, manejo de sesión ni UI; el proceso es disparado por otro agente.
- No se soportan filtros en la Unidad 2. Las Unidades 3 y 4 definirán filtros sobre datos ya capturados.
- No se reanuda una corrida desde el último scroll exitoso.
- El límite de 1.500 anuncios controla volumen, pero no fija una duración máxima absoluta para una corrida.

---

## AI-Slop Prevention

**Decisiones tomadas:**
- Interceptación GraphQL: se usa la fuente de datos recibida por el navegador, no parsing del HTML visual.
- Throttling preventivo: la cadencia y el backoff forman parte del comportamiento inicial, no una mejora posterior.
- Entrada mínima: solo `query` como texto; se excluyeron filtros hasta que las unidades posteriores definan su uso sobre datos capturados.
- Recuperación mínima: se conserva salida parcial, pero se descartó checkpoint de scroll y reanudación por no ser necesario en esta unidad.
