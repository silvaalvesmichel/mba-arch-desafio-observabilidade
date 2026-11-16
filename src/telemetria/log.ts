import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import { pedidoDoContexto } from './rastreio';
import { NOME_DO_SERVICO } from './servico';

type Nivel = 'info' | 'warn' | 'error';

type Campos = Record<string, unknown>;

function escrever(level: Nivel, msg: string, campos: Campos = {}): void {
  // trace_id and span_id come from the active span, so they match what Jaeger shows.
  // Both keys are always present; they stay empty when there is no active span.
  const contextoDoSpan = trace.getActiveSpan()?.spanContext();
  const temSpan = contextoDoSpan !== undefined && isSpanContextValid(contextoDoSpan);

  const linha: Campos = {
    timestamp: new Date().toISOString(),
    level,
    service: NOME_DO_SERVICO,
    msg,
    trace_id: temSpan ? contextoDoSpan.traceId : '',
    span_id: temSpan ? contextoDoSpan.spanId : '',
  };

  const pedidoId = pedidoDoContexto(context.active());
  if (pedidoId !== undefined) {
    linha.pedido_id = pedidoId;
  }

  process.stdout.write(JSON.stringify({ ...linha, ...campos }) + '\n');
}

export const log = {
  info(msg: string, campos?: Campos): void {
    escrever('info', msg, campos);
  },
  warn(msg: string, campos?: Campos): void {
    escrever('warn', msg, campos);
  },
  error(msg: string, campos?: Campos): void {
    escrever('error', msg, campos);
  },
};
