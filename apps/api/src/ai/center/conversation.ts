import type { ToolCall, ToolSpec, TranscriptEntry } from '../chat-model.js';
import type { AiRouter, AiServiceKey, ResolvedAi } from './ai-router.service.js';

export const MAX_TOOL_ROUNDS = 5;

/**
 * Conversación con el modelo y sus herramientas (asistente de las empresas y
 * agente comercial). Cada llamada queda registrada con proveedor, modelo y costo.
 * Las herramientas las ejecuta siempre el backend (`run`); el modelo solo las pide.
 */
export async function runConversation(
  router: AiRouter,
  tenantId: string,
  service: AiServiceKey,
  ai: ResolvedAi,
  input: { system: string; transcript: TranscriptEntry[]; tools: ToolSpec[]; run: (name: string, args: Record<string, unknown>) => Promise<unknown> },
) {
  const { session, state } = await router.open(ai, { system: input.system, transcript: input.transcript, tools: input.tools });
  const used: string[] = [];
  const usage = { input: 0, output: 0 };
  const t0 = Date.now();
  const done = (text: string, ok = true, error?: string) => router.record(tenantId, service, ai, state, { ...usage, ok, error, ms: Date.now() - t0 }).then(() => ({ text, tools: used, tokens: usage.input + usage.output }));
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const turn = await session.next();
      usage.input += turn.usage.input;
      usage.output += turn.usage.output;
      if (!turn.calls.length || round === MAX_TOOL_ROUNDS) return await done(turn.text.slice(0, 4000));
      const results: { call: ToolCall; result: unknown }[] = [];
      for (const call of turn.calls.slice(0, 5)) {
        used.push(call.name);
        results.push({ call, result: await input.run(call.name, call.args) });
      }
      session.addToolResults(results);
    }
    return await done('');
  } catch (e) {
    await done('', false, (e as Error).message);
    throw e;
  }
}
