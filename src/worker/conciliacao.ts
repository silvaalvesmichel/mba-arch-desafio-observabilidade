import { trace } from '@opentelemetry/api';
import { log } from '../telemetria/log';
import { cobrancasProcessadas } from '../telemetria/metricas';
import { motivoDe, registrarExcecaoNoSpan } from '../telemetria/rastreio';
import { processarPagamento } from './pagamento';
import { registrarFalhaLegado } from './registro-legado';

export type StatusDoPedido = 'confirmado' | 'recusado';

export async function decidirStatusDoPedido(
  clienteId: string,
  valorTotal: number
): Promise<StatusDoPedido> {
  let recusado = false;

  try {
    const resultado = await processarPagamento(clienteId, valorTotal);
    recusado = !resultado.aprovado;

    const resultadoDaCobranca = resultado.aprovado ? 'aprovada' : 'recusada';
    cobrancasProcessadas.inc({ resultado: resultadoDaCobranca });
    trace.getActiveSpan()?.setAttribute('cobranca.resultado', resultadoDaCobranca);
  } catch (erro) {
    registrarFalhaLegado(erro);

    cobrancasProcessadas.inc({ resultado: 'falha' });
    trace.getActiveSpan()?.setAttribute('cobranca.resultado', 'falha');
    registrarExcecaoNoSpan(erro);
    log.error('falha ao processar a cobranca: ' + motivoDe(erro), {
      motivo: motivoDe(erro),
      cliente_id: clienteId,
      valor_total: valorTotal,
    });
  }

  return recusado ? 'recusado' : 'confirmado';
}
