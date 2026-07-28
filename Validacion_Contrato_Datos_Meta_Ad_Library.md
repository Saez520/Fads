# Validación del contrato de datos del Meta Ad Library

## Método de captura

### Registro de la sesión

| Dato | Valor registrado |
|---|---|
| URL inicial y final utilizada | `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=CO&is_targeted_country=false&media_type=all&q=diabetes&search_type=keyword_unordered&sort_data[mode]=total_impressions&sort_data[direction]=desc` |
| Término exacto de búsqueda | `diabetes` |
| País seleccionado | `CO (Colombia)` |
| Fecha de captura | `2026-07-28` |
| Acceso sin iniciar sesión | Confirmado: cabecera de respuesta que confirma sesión no iniciada, cookies vacías y parámetro de usuario anónimo/vacío |

### Procedimiento ejecutado

1. Se abrió Chrome en una ventana de incógnito sin iniciar sesión ni introducir credenciales.
2. Se navegó a la URL registrada arriba.
3. En DevTools se abrió **Network**, se activó **Preserve log**, se limpió la red y se filtró por `graphql`/`graphqlbatch`.
4. Se seleccionó Colombia y se ejecutó la búsqueda exacta `diabetes`.
5. Se realizó una acción adicional controlada para cargar más resultados.
6. Se revisaron las respuestas GraphQL del endpoint `POST https://www.facebook.com/api/graphql/`.
7. Se conservaron únicamente fragmentos JSON de respuestas con datos de anuncios. Las URLs firmadas de media se reemplazaron por `[REDACTED - URL de video con firma]` o `[REDACTED - URL de thumbnail]`.
8. Se observaron 29 anuncios y `has_next_page: true`.

## Payloads GraphQL reales

### Contexto de las respuestas

- **Endpoint:** `POST https://www.facebook.com/api/graphql/`
- **Query de filtros:** `fb_api_req_friendly_name=AdLibraryFilterContextProviderQuery`
- **Query de resultados:** `search_results_connection`
- **Ruta observada:** `data → ad_library_main → search_results_connection → edges[] → node → collated_results[0]`
- **Resultados:** 29 anuncios; `has_next_page: true`.

### Respuesta GraphQL — primer anuncio

El siguiente fragmento es un ejemplo sanitizado del primer anuncio. Las URLs firmadas de media fueron reemplazadas, y no se incluyen headers ni material de transporte.

```json
{
  "ad_archive_id": "1593756425228682",
  "collation_id": "2397074567386275",
  "collation_count": 1,
  "page_name": "Aprendes inglés fácil",
  "page_id": "926690107194523",
  "is_active": true,
  "start_date": 1775026800,
  "end_date": 1785135600,
  "publisher_platform": ["FACEBOOK", "INSTAGRAM", "AUDIENCE_NETWORK", "MESSENGER", "THREADS"],
  "snapshot": {
    "page_name": "Aprendes inglés fácil",
    "page_id": "926690107194523",
    "page_profile_uri": "https://www.facebook.com/61584664392974/",
    "page_like_count": 6994,
    "body": {"text": "{{product.brand}}"},
    "title": "{{product.name}}",
    "cta_text": "Descargar",
    "cta_type": "DOWNLOAD",
    "caption": "itunes.apple.com",
    "link_url": "http://itunes.apple.com/app/id6478287397",
    "link_description": "{{product.description}}",
    "display_format": "DCO",
    "cards": [{
      "body": "Habla con un Tutor de IA, descarga Learna AI",
      "title": "Aprender idiomas es fácil con los tutores de IA",
      "cta_text": "Download",
      "cta_type": "DOWNLOAD",
      "link_url": "http://itunes.apple.com/app/id6478287397",
      "video_hd_url": "[REDACTED - URL de video con firma]",
      "video_sd_url": "[REDACTED - URL de video con firma]",
      "video_preview_image_url": "[REDACTED - URL de thumbnail]"
    }]
  }
}
```

### Formatos de `snapshot` observados

- **DCO con cards:** 15 de 29 anuncios usan `snapshot.cards[]`; cada tarjeta puede contener `body`, `title`, `video_hd_url`, `original_image_url` y otros campos de media.
- **Sin cards:** 14 de 29 anuncios tienen el contenido directamente en `snapshot.body`, `snapshot.title`, `snapshot.videos` o `snapshot.images`.
- En el formato DCO, `snapshot.body` puede ser una plantilla como `{{product.brand}}` y el contenido concreto puede estar en `snapshot.cards[].body`.

## Tabla de mapeo

La ruta se registra tal como fue observada en los payloads. Todos los estados siguientes son `confirmado`.

| Dato deseado | Campo/ruta real observado | Estado | Nota |
|---|---|---|---|
| ID del anuncio | `ad_archive_id` | confirmado | String único, ej. `"1593756425228682"` |
| ID de agrupación | `collation_id` | confirmado | String, ej. `"2397074567386275"` |
| Conteo de colación | `collation_count` | confirmado | int, siempre 1 |
| Nombre del anunciante | `page_name` | confirmado | String, ej. `"Aprendes inglés fácil"` |
| ID de página | `page_id` | confirmado | String, ej. `"926690107194523"` |
| URL del perfil | `snapshot.page_profile_uri` | confirmado | URL de Facebook de la página |
| Foto de perfil | `snapshot.page_profile_picture_url` | confirmado | URL de imagen |
| Likes de página | `snapshot.page_like_count` | confirmado | int, ej. 6994 |
| Texto del anuncio (body) | `snapshot.body.text` (sin cards) o `snapshot.cards[].body` (DCO) | confirmado | En DCO el body del snapshot es template `{{product.brand}}` |
| Título/Headline | `snapshot.title` (sin cards) o `snapshot.cards[].title` (DCO) | confirmado | En DCO el title del snapshot es `{{product.name}}` |
| CTA texto | `snapshot.cta_text` o `snapshot.cards[].cta_text` | confirmado | Ej. `"Descargar"`, `"Más información"` |
| CTA tipo | `cta_type` en snapshot o cards | confirmado | Ej. `DOWNLOAD`, `LEARN_MORE`, `WHATSAPP_MESSAGE` |
| URL de destino | `snapshot.link_url` o `snapshot.cards[].link_url` | confirmado | URL de landing |
| Descripción del link | `snapshot.link_description` o cards | confirmado | Puede ser template `{{product.description}}` |
| Caption/dominio | `snapshot.caption` o cards | confirmado | Ej. `itunes.apple.com` |
| Video HD | `snapshot.cards[].video_hd_url` o `snapshot.videos[].video_hd_url` | confirmado | URL de video |
| Video SD | `snapshot.cards[].video_sd_url` o `snapshot.videos[].video_sd_url` | confirmado | URL de video |
| Thumbnail de video | `snapshot.cards[].video_preview_image_url` | confirmado | URL de thumbnail |
| Imagen original | `snapshot.cards[].original_image_url` | confirmado | URL de imagen |
| Imagen redimensionada | `snapshot.cards[].resized_image_url` | confirmado | URL de imagen |
| Fecha de inicio | `start_date` | confirmado | Unix timestamp, segundos |
| Fecha de fin | `end_date` | confirmado | Unix timestamp |
| Activo | `is_active` | confirmado | bool |
| Plataformas | `publisher_platform` | confirmado | Lista con valores de plataformas |
| Formato de display | `snapshot.display_format` | confirmado | `DCO` o `VIDEO` |
| Media generada por IA | `contains_digital_created_media` | confirmado | bool |
| Contenido sensible | `contains_sensitive_content` | confirmado | bool |
| Estado de restricción | `gated_type` | confirmado | `ELIGIBLE` |
| Elegible AAA | `is_aaa_eligible` | confirmado | bool |
| Datos regulatorios | `regional_regulation_data` | confirmado | Objeto con `finserv` y `tw_anti_scam` |

## Campos ausentes, discrepancias y límites

### Campos ausentes sin login

| Dato deseado | Campo | Evidencia |
|---|---|---|
| Impresiones | `impressions_with_index` | `impressions_text: null`, `impressions_index: -1` en los 29 anuncios |
| Gasto (spend) | `spend` | Siempre `null` |
| Moneda | `currency` | Siempre string vacío `""` |
| Alcance estimado | `reach_estimate` | Siempre `null` |
| Categorías del anuncio | `categories` | Siempre `['UNKNOWN']` |
| Tiempo activo total | `total_active_time` | Siempre `null` |
| Info FEV | `fev_info` | Siempre `null` |
| Conteo de reportes | `report_count` | Siempre `null` |
| Branded content | `snapshot.branded_content` | Siempre `null` |
| Disclaimer | `snapshot.disclaimer_label` | Siempre `null` |
| Evento | `snapshot.event` | Siempre `null` |
| País ISO | `snapshot.country_iso_code` | Siempre `null` |

### Discrepancias y variabilidad observada

- 15 de 29 anuncios usan formato DCO con `cards[]`.
- 14 de 29 tienen el contenido directamente en `snapshot.body`, `snapshot.title`, `snapshot.videos`.
- 6 anuncios tienen video y 9 solo imagen/texto.
- `publisher_platform` varía entre subconjuntos de `[FACEBOOK, INSTAGRAM, AUDIENCE_NETWORK, MESSENGER, THREADS]`.
- La respuesta tiene paginación: `has_next_page: true` y `end_cursor`.
- Los contenidos multimedia aparecen en rutas diferentes según exista `cards[]`; no se infiere una única ruta para todos los anuncios.

### Límites de esta exploración

- La observación corresponde a la búsqueda `diabetes`, país `CO (Colombia)` y fecha `2026-07-28`.
- Se revisaron 29 anuncios en una respuesta con paginación pendiente (`has_next_page: true`).
- Los fragmentos de media con firma fueron anonimizados como `[REDACTED]`; el documento no conserva esas URLs completas.
- Cada anuncio se registra como un registro independiente. No se presentan conclusiones adicionales sobre relaciones entre registros.

## Confirmación de acceso sin login

- **Resultado observado:** confirmado. La consulta y las respuestas GraphQL fueron accesibles sin iniciar sesión.
- **URL utilizada:** `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=CO&is_targeted_country=false&media_type=all&q=diabetes&search_type=keyword_unordered&sort_data[mode]=total_impressions&sort_data[direction]=desc`.
- **Evidencia de sesión:** cabecera de respuesta que confirma sesión no iniciada, cookies vacías y parámetro de usuario anónimo/vacío.
- **Respuesta observada:** 29 anuncios en `search_results_connection`, con `has_next_page: true`.
