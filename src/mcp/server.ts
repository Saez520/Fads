import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FileSystemIngestionStore } from '../ingestion/ingestion-store.js';
import { IngestionService } from '../ingestion/ingestion-service.js';
import { MCP_DEFAULTS, type McpEnvelope } from './mcp-types.js';
import { McpApplicationService } from './mcp-service.js';
import { McpStore } from './mcp-store.js';

const filterSchema = z.object({ campo: z.enum(['texto', 'anunciante', 'plataforma', 'activo', 'fechaInicioDesde', 'fechaInicioHasta', 'formato', 'cta', 'searchId']), valor: z.union([z.string(), z.boolean(), z.number()]) }).strict();
const filtersSchema = z.object({ operador: z.enum(['AND', 'OR']).optional(), filtros: z.array(filterSchema) }).strict();
const pageSchema = z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
export const MCP_TOOL_SCHEMAS = {
  iniciar_busqueda: z.object({ query: z.string(), filtros: filtersSchema.optional(), forceRelaunch: z.boolean().optional() }).strict(),
  estado_busqueda: z.object({ taskId: z.string() }).strict(),
  listar_extracciones: pageSchema,
  resumen_extraccion: z.object({ searchId: z.string() }).strict(),
  obtener_cluster: z.object({ searchId: z.string(), tipo: z.enum(['exacto', 'creativo']), fingerprint: z.string() }).strict(),
  buscar_anuncios: z.object({ searchId: z.string().optional(), filtros: filtersSchema.optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
};
export function serializeToolResult<T>(value: McpEnvelope<T>): CallToolResult { const serialized = JSON.stringify(value); return { content: [{ type: 'text', text: serialized }], structuredContent: value as unknown as Record<string, unknown>, ...(Object.hasOwn(value, 'error') ? { isError: true } : {}) }; }
export function createMcpServer(service: McpApplicationService): McpServer {
  const server = new McpServer({ name: 'meta-ad-agent-mcp', version: '0.1.0' });
  server.registerTool('iniciar_busqueda', { description: 'Inicia una búsqueda asíncrona de anuncios.', inputSchema: MCP_TOOL_SCHEMAS.iniciar_busqueda }, async (args) => serializeToolResult(await service.iniciarBusqueda(args)));
  server.registerTool('estado_busqueda', { description: 'Obtiene el estado de una búsqueda.', inputSchema: MCP_TOOL_SCHEMAS.estado_busqueda }, async (args) => serializeToolResult(await service.estadoBusqueda(args.taskId)));
  server.registerTool('listar_extracciones', { description: 'Lista las extracciones publicadas.', inputSchema: MCP_TOOL_SCHEMAS.listar_extracciones }, async (args) => serializeToolResult(await service.listarExtracciones(args)));
  server.registerTool('resumen_extraccion', { description: 'Resume agrupaciones de una extracción.', inputSchema: MCP_TOOL_SCHEMAS.resumen_extraccion }, async (args) => serializeToolResult(await service.resumenExtraccion(args.searchId)));
  server.registerTool('obtener_cluster', { description: 'Obtiene un grupo de fingerprints.', inputSchema: MCP_TOOL_SCHEMAS.obtener_cluster }, async (args) => serializeToolResult(await service.obtenerCluster(args)));
  server.registerTool('buscar_anuncios', { description: 'Busca anuncios publicados por texto y filtros.', inputSchema: MCP_TOOL_SCHEMAS.buscar_anuncios }, async (args) => serializeToolResult(await service.buscarAnuncios(args)));
  return server;
}
export async function startMcpServer(service?: McpApplicationService): Promise<void> {
  const ingestionStore = new FileSystemIngestionStore(MCP_DEFAULTS.ingestionRoot);
  const application = service ?? new McpApplicationService({ store: new McpStore(), ingestionStore, ingestionService: new IngestionService(ingestionStore) });
  await application.bootstrap();
  await createMcpServer(application).connect(new StdioServerTransport());
}
if (import.meta.url === `file://${process.argv[1]}`) { startMcpServer().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; }); }
