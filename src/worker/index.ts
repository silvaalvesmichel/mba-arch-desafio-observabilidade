import http from 'node:http';
import { ROOT_CONTEXT, SpanKind, propagation } from '@opentelemetry/api';
import { atualizarStatusPedido } from '../db/consultas';
import { esperarBanco, fecharPool } from '../db/pool';
import { migrar } from '../db/migracao';
import { NOME_DA_FILA, consumirPedido, criarConexaoRedis } from '../fila/fila';
import { log } from '../telemetria/log';
import { TIPO_DE_CONTEUDO, coletar, pedidosConfirmados } from '../telemetria/metricas';
import {
  comPedido,
  motivoDe,
  registrarExcecaoNoSpan,
  tracer,
} from '../telemetria/rastreio';
import { decidirStatusDoPedido } from './conciliacao';

const porta = Number(process.env.WORKER_PORT ?? process.env.PORT ?? 8081);

let rodando = true;

function iniciarServidorDeSaude(): http.Server {
  const servidor = http.createServer(async (requisicao, resposta) => {
    if (requisicao.url === '/health') {
      resposta.writeHead(200, { 'content-type': 'application/json' });
      resposta.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (requisicao.url === '/metrics') {
      resposta.writeHead(200, { 'content-type': TIPO_DE_CONTEUDO });
      resposta.end(await coletar());
      return;
    }

    resposta.writeHead(404, { 'content-type': 'application/json' });
    resposta.end(JSON.stringify({ erro: 'rota nao encontrada' }));
  });

  servidor.listen(porta, () => {
    log.info('worker ouvindo na porta ' + porta);
  });

  return servidor;
}

async function processarMensagem(mensagem: Record<string, unknown>): Promise<void> {
  const pedidoId = Number(mensagem.pedido_id);
  const clienteId = String(mensagem.cliente_id);
  const valorTotal = Number(mensagem.valor_total);

  // The parent comes from the message, extracted over ROOT_CONTEXT: the worker loop has
  // no context of its own, and the span must continue the trace started by the api.
  const contextoDaApi = propagation.extract(
    ROOT_CONTEXT,
    (mensagem.rastreio ?? {}) as Record<string, string>
  );

  await tracer.startActiveSpan(
    'pedido.processar',
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        'pedido.id': pedidoId,
        'cliente.id': clienteId,
        'pedido.valor_total': valorTotal,
        'messaging.system': 'redis',
        'messaging.destination.name': NOME_DA_FILA,
      },
    },
    comPedido(contextoDaApi, pedidoId),
    async (span) => {
      try {
        log.info('mensagem do pedido ' + pedidoId + ' recebida da fila');

        const status = await decidirStatusDoPedido(clienteId, valorTotal);
        await atualizarStatusPedido(pedidoId, status);

        span.setAttribute('pedido.status', status);
        if (status === 'confirmado') {
          pedidosConfirmados.inc();
        }

        log.info('pedido ' + pedidoId + ' ficou ' + status);
      } catch (erro) {
        registrarExcecaoNoSpan(erro);
        log.error('erro ao processar pedido: ' + motivoDe(erro), { motivo: motivoDe(erro) });
        throw erro;
      } finally {
        span.end();
      }
    }
  );
}

async function iniciar(): Promise<void> {
  await esperarBanco();
  await migrar();

  const redis = criarConexaoRedis();
  const servidor = iniciarServidorDeSaude();

  const encerrar = () => {
    rodando = false;
    servidor.close(async () => {
      redis.disconnect();
      await fecharPool();
      process.exit(0);
    });
  };

  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);

  log.info('worker consumindo a fila de pedidos');

  while (rodando) {
    try {
      const mensagem = await consumirPedido(redis);

      if (mensagem) {
        await processarMensagem(mensagem);
      }
    } catch (erro) {
      log.error('erro ao ler a fila: ' + (erro as Error).message);
      await new Promise((resolver) => setTimeout(resolver, 1000));
    }
  }
}

iniciar().catch((erro) => {
  log.error('worker nao conseguiu iniciar: ' + erro.message);
  process.exit(1);
});
