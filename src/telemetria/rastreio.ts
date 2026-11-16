import {
  SpanStatusCode,
  createContextKey,
  trace,
  type Context,
} from '@opentelemetry/api';

export const tracer = trace.getTracer('loja-pedidos');

const CHAVE_DO_PEDIDO = createContextKey('loja.pedido_id');

// Carries the order id in the active context so every log line written while the
// order is being handled gets pedido_id, even in functions that never receive it.
export function comPedido(contexto: Context, pedidoId: number): Context {
  return contexto.setValue(CHAVE_DO_PEDIDO, pedidoId);
}

export function pedidoDoContexto(contexto: Context): number | undefined {
  return contexto.getValue(CHAVE_DO_PEDIDO) as number | undefined;
}

export function motivoDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

// Records a caught exception on the active span and flips the span status to error.
export function registrarExcecaoNoSpan(erro: unknown): void {
  const span = trace.getActiveSpan();

  if (!span) {
    return;
  }

  span.recordException(erro instanceof Error ? erro : new Error(String(erro)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: motivoDe(erro) });
}
