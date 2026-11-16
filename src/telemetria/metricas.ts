import client from 'prom-client';

export const registro = new client.Registry();

client.collectDefaultMetrics({ register: registro });

export const TIPO_DE_CONTEUDO = registro.contentType;

export function coletar(): Promise<string> {
  return registro.metrics();
}

export const RESULTADOS_DE_COBRANCA = ['aprovada', 'recusada', 'falha'] as const;

export type ResultadoDeCobranca = (typeof RESULTADOS_DE_COBRANCA)[number];

export const pedidosCriados = new client.Counter({
  name: 'pedidos_criados_total',
  help: 'Pedidos aceitos pela api e publicados na fila',
  registers: [registro],
});

export const pedidosConfirmados = new client.Counter({
  name: 'pedidos_confirmados_total',
  help: 'Pedidos que o worker marcou como confirmado',
  registers: [registro],
});

export const cobrancasProcessadas = new client.Counter({
  name: 'cobrancas_processadas_total',
  help: 'Tentativas de cobranca no processador de pagamento, por resultado',
  labelNames: ['resultado'],
  registers: [registro],
});

// Every series exists from startup: a series born only on its first event is absent
// while everything is fine, and a ratio over an absent series returns no data.
pedidosCriados.inc(0);
pedidosConfirmados.inc(0);
for (const resultado of RESULTADOS_DE_COBRANCA) {
  cobrancasProcessadas.inc({ resultado }, 0);
}
