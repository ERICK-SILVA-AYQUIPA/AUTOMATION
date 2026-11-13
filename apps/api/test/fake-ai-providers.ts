import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Servidor local que responde como las API de Anthropic, OpenAI, DeepSeek y
 * Gemini (solo para pruebas: en producción las URL base no se pueden cambiar).
 * Formatos tomados de la documentación de cada proveedor y de los tipos de sus
 * SDK oficiales. Rutas por prefijo: /anthropic, /openai/v1, /deepseek, /gemini.
 *
 * Comportamiento de cada clave (por su contenido):
 *  - «bad»     → 401 (clave rechazada)
 *  - «noperm»  → 403 (sin permisos)
 *  - «down»    → 503 en la generación (servicio caído, reintentable)
 *  - otra      → válida
 * Generación: si el último mensaje del cliente contiene «precio» y hay
 * herramientas, pide `buscar_productos`; con el resultado de la herramienta
 * responde citando el precio que devolvió el backend; si no, responde «OK».
 */
export interface FakeCall { provider: string; method: string; path: string; key: string; body: Record<string, unknown> | null }

const readBody = (req: IncomingMessage) => new Promise<string>((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
const priceIn = (s: string) => /"precio"\s*:\s*"?([\d.]+)/.exec(s)?.[1] ?? /([\d]+\.\d{2})/.exec(s)?.[1] ?? '?';

export const FAKE_MODELS = {
  anthropic: [{ id: 'claude-prueba-grande', display_name: 'Claude Prueba Grande', max_input_tokens: 1_000_000, max_tokens: 128_000 }, { id: 'claude-prueba-chica', display_name: 'Claude Prueba Chica', max_input_tokens: 200_000, max_tokens: 64_000 }],
  openai: ['gpt-prueba-1', 'gpt-prueba-mini'],
  deepseek: [{ id: 'deepseek-prueba', name: 'DeepSeek Prueba', context_window: 128_000, max_output_tokens: 8_000 }],
  gemini: [{ name: 'models/gemini-prueba-pro', displayName: 'Gemini Prueba Pro', inputTokenLimit: 1_000_000, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent', 'countTokens'] }, { name: 'models/embedding-prueba', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] }],
};

export async function startFakeAiProviders(port = 0) {
  const calls: FakeCall[] = [];
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url!, 'http://x');
    const [, provider] = url.pathname.split('/');
    const key = String(req.headers['x-api-key'] ?? req.headers['x-goog-api-key'] ?? (req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    calls.push({ provider: provider!, method: req.method!, path: url.pathname, key, body });
    const send = (status: number, payload: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    const generating = req.method === 'POST';
    const fail = key.includes('bad') ? 401 : key.includes('noperm') ? 403 : generating && key.includes('down') ? 503 : 0;

    if (provider === 'anthropic') {
      if (fail) return send(fail, { type: 'error', error: { type: fail === 401 ? 'authentication_error' : fail === 403 ? 'permission_error' : 'overloaded_error', message: fail === 401 ? 'invalid x-api-key' : fail === 403 ? 'This API key does not have permission' : 'Overloaded' } });
      if (url.pathname === '/anthropic/v1/models') return send(200, { data: FAKE_MODELS.anthropic.map((m) => ({ type: 'model', created_at: '2026-01-01T00:00:00Z', ...m })), has_more: false, first_id: FAKE_MODELS.anthropic[0]!.id, last_id: FAKE_MODELS.anthropic.at(-1)!.id });
      if (url.pathname === '/anthropic/v1/messages') {
        const msgs = body!.messages as { role: string; content: string | { type: string; content?: string }[] }[];
        const last = msgs.at(-1)!;
        const usage = { input_tokens: 120, output_tokens: 30 };
        const base = { id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: body!.model, stop_sequence: null, usage };
        if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') return send(200, { ...base, content: [{ type: 'text', text: `Cuesta S/ ${priceIn(String(last.content[0].content))} (Claude)` }], stop_reason: 'end_turn' });
        if ((body!.tools as unknown[] | undefined)?.length && (typeof last.content === 'string' ? last.content : '').includes('precio')) return send(200, { ...base, content: [{ type: 'thinking', thinking: '', signature: 'firma-claude' }, { type: 'tool_use', id: 'toolu_01', name: 'buscar_productos', input: { consulta: 'gaseosa' } }], stop_reason: 'tool_use' });
        return send(200, { ...base, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' });
      }
    }

    if (provider === 'openai' || provider === 'deepseek') {
      if (fail) return send(fail, { error: { message: fail === 401 ? 'Incorrect API key provided' : fail === 403 ? 'You are not allowed to sample from this model' : 'The server is overloaded', type: 'invalid_request_error', code: fail === 401 ? 'invalid_api_key' : null } });
      if (url.pathname.endsWith('/models')) {
        const data = provider === 'openai' ? FAKE_MODELS.openai.map((id) => ({ id, object: 'model', created: 1_700_000_000, owned_by: 'openai' })) : FAKE_MODELS.deepseek.map((m) => ({ ...m, object: 'model', owned_by: 'deepseek' }));
        return send(200, { object: 'list', data });
      }
      if (url.pathname.endsWith('/chat/completions')) {
        const msgs = body!.messages as { role: string; content: string | null }[];
        const last = msgs.at(-1)!;
        const usage = { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 };
        const base = { id: `chatcmpl-${calls.length}`, object: 'chat.completion', created: 1_700_000_000, model: body!.model, usage };
        const name = provider === 'openai' ? 'OpenAI' : 'DeepSeek';
        if (last.role === 'tool') return send(200, { ...base, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `Cuesta S/ ${priceIn(String(last.content))} (${name})` } }] });
        if ((body!.tools as unknown[] | undefined)?.length && String(last.content).includes('precio')) {
          return send(200, { ...base, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, ...(provider === 'deepseek' ? { reasoning_content: 'razonamiento' } : {}), tool_calls: [{ id: 'call_01', type: 'function', function: { name: 'buscar_productos', arguments: '{"consulta":"gaseosa"}' } }] } }] });
        }
        return send(200, { ...base, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] });
      }
    }

    if (provider === 'gemini') {
      if (fail) return send(fail === 401 ? 400 : fail, { error: { code: fail === 401 ? 400 : fail, message: fail === 401 ? 'API key not valid. Please pass a valid API key.' : fail === 403 ? 'Permission denied' : 'The model is overloaded' } });
      if (url.pathname === '/gemini/v1beta/models') return send(200, { models: FAKE_MODELS.gemini });
      if (url.pathname.startsWith('/gemini/v1beta/models/') && req.method === 'GET') return send(200, { name: url.pathname.replace('/gemini/v1beta/', '') });
      if (url.pathname.endsWith(':generateContent')) {
        const contents = body!.contents as { role: string; parts: { text?: string; functionResponse?: { response: unknown } }[] }[];
        const lastPart = contents.at(-1)!.parts[0]!;
        const usageMetadata = { promptTokenCount: 90, candidatesTokenCount: 15 };
        if (lastPart.functionResponse) return send(200, { candidates: [{ content: { role: 'model', parts: [{ text: `Cuesta S/ ${priceIn(JSON.stringify(lastPart.functionResponse.response))} (Gemini)` }] }, finishReason: 'STOP' }], usageMetadata });
        if (body!.tools && String(lastPart.text).includes('precio')) return send(200, { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'buscar_productos', args: { consulta: 'gaseosa' } } }] }, finishReason: 'STOP' }], usageMetadata });
        return send(200, { candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata });
      }
    }
    send(404, { error: { message: `ruta no simulada: ${req.method} ${url.pathname}` } });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    calls,
    urls: { anthropic: `${base}/anthropic`, openai: `${base}/openai/v1`, deepseek: `${base}/deepseek`, gemini: `${base}/gemini` },
    close: () => new Promise((r) => server.close(r)),
  };
}
