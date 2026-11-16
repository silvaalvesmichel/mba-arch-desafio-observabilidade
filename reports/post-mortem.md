# Post-mortem: pedidos confirmados sem cobrança

Reprodução feita em 16/11/2026, com a stack do `compose.yaml` subida do zero em uma máquina Linux descartável: 3 min 30 s de `normal` seguidos de 3 min de `cenario-a`. Todos os horários estão em UTC.

## Resumo

Quando o processador de pagamento falha ao cobrar, o worker trata a falha como se a cobrança tivesse sido aprovada e marca o pedido como `confirmado`. O cliente recebe sucesso, a API responde 2xx e nada do que era monitorado mudava, por isso o problema só apareceu no fechamento financeiro do mês. Em 3 minutos de reprodução, 131 pedidos, somando R$ 124.236,05, foram confirmados sem que nenhum dinheiro entrasse.

## Impacto

No período reproduzido (`cenario-a`, de 22:46:54 a 22:49:54):

| O que | Número | De onde saiu | Precisão |
| --- | --- | --- | --- |
| Pedidos confirmados sem cobrança | **131** | Linhas `"level":"error"` no log do worker, uma por pedido (131 linhas, 131 `pedido_id` distintos) | Contagem exata |
| Mesma pergunta, pela métrica | 131 | Valor do contador `cobrancas_processadas_total{resultado="falha"}` no Prometheus | Exata nesta reprodução, porque o worker não reiniciou |
| Mesma pergunta, pela métrica na janela | 131,8 | `increase(cobrancas_processadas_total{resultado="falha"}[216s])` | Estimativa: o `increase` extrapola a janela |
| Mesma pergunta, pela diferença | 131 | `pedidos_confirmados_total` (698) menos `cobrancas_processadas_total{resultado="aprovada"}` (567) | Exata nesta reprodução |
| Situação desses pedidos no banco | 131 de 131 `confirmado` | `SELECT status, count(*), sum(valor_total) FROM pedidos WHERE id IN (<ids do log>) GROUP BY status` | Contagem exata |
| Valor envolvido | **R$ 124.236,05** | Soma do campo `valor_total` das 131 linhas de erro do log; a consulta ao banco acima devolveu o mesmo valor | Exato |

As fontes divergem em um ponto só: o `increase()` devolveu 131,8 onde o log e o contador dizem 131. É a extrapolação esperada da função, e o número a usar para conciliação é o do log.

A métrica responde **quantos pedidos**. Ela não responde **quanto dinheiro**: valor por pedido não cabe em métrica sem virar cardinalidade. O valor veio do log, que carrega `valor_total` na linha de erro, conferido contra o banco.

Em proporção: 131 das 315 cobranças tentadas durante o `cenario-a` (41,6%) falharam, e os R$ 124.236,05 são 17,8% dos R$ 699.670,90 que aparecem como confirmados em toda a reprodução. Nenhum cliente viu erro: a API não registrou nenhuma linha de erro e nenhuma resposta 5xx no período.

Fora do período reproduzido, o impacto real em produção não foi medido aqui. A instrumentação que conta as falhas não existia antes, então a contagem retroativa depende da conciliação do financeiro.

## Detecção

**Como foi descoberto.** Pelo financeiro, no fechamento do mês, ao cruzar pedidos confirmados com o que efetivamente entrou. Nenhum alerta, dashboard ou log avisou: do lado de fora estava tudo 2xx, e a falha era guardada apenas em uma lista em memória que ninguém lia. O atraso entre a primeira falha e a descoberta pode chegar a 30 dias.

**Quanto o alerta leva.** Na reprodução, com o `cenario-a` subindo imediatamente depois de 3 min 30 s de `normal`:

| Momento | Horário | Desde o início do `cenario-a` |
| --- | --- | --- |
| Início do `cenario-a` | 22:46:54 | 0 s |
| Primeira cobrança com falha (log) | 22:46:57 | 3 s |
| Regra `FalhaEmCobrancas` fica pendente (`activeAt` no Prometheus) | 22:47:10 | 17 s |
| Webhook chega ao `receptor-alertas` | 22:47:50 | **58 s** (medido com resolução de 2 s) |

Dos 58 segundos, cerca de 17 foram coleta e avaliação até a proporção cruzar o limiar de 1,44%, 30 são o `for` da regra e 10 são o `group_wait` do Alertmanager. Durante os 3 min 30 s de `normal` anteriores, nenhum alerta chegou ao receptor.

**O que a diferença significa.** O mesmo defeito passa de "descoberto em até um mês, por quem fecha a conta" para "descoberto em cerca de um minuto, por quem pode agir". No ritmo da reprodução, de aproximadamente R$ 41 mil por minuto em pedidos confirmados sem cobrança, um minuto de exposição custa dezenas de milhares de reais; um mês custa o buraco que o financeiro encontrou. Além do tempo, muda a qualidade da resposta: o alerta já chega com o caminho para o caso individual (linha de erro, `trace_id`, `pedido_id`), enquanto a descoberta pelo financeiro chegou como um total sem explicação, e a primeira hipótese foi "deve ser problema do banco".

## Causa raiz

Arquivo `src/worker/conciliacao.ts`, função `decidirStatusDoPedido`.

```ts
export async function decidirStatusDoPedido(
  clienteId: string,
  valorTotal: number
): Promise<StatusDoPedido> {
  let recusado = false;

  try {
    const resultado = await processarPagamento(clienteId, valorTotal);
    recusado = !resultado.aprovado;
  } catch (erro) {
    registrarFalhaLegado(erro);
  }

  return recusado ? 'recusado' : 'confirmado';
}
```

(Trecho como estava no projeto base; as linhas de instrumentação acrescentadas dentro do `try` e do `catch` foram omitidas para deixar a lógica à vista.)

A função só conhece dois desfechos, `recusado` ou `confirmado`, e começa assumindo que o pedido não foi recusado. Quando `processarPagamento` lança exceção, o `catch` guarda a ocorrência em uma lista em memória (`registrarFalhaLegado`, limitada a 500 itens e perdida a cada reinício) e segue adiante. Como `recusado` continua `false`, a função devolve `confirmado`. "A cobrança falhou" e "a cobrança foi aprovada" terminam no mesmo estado.

Dois fatores contribuíram para o defeito ficar invisível:

- a exceção era capturada sem log, sem métrica e sem marcação no span, então nenhum sinal saía do processo;
- o contexto de trace não atravessava a fila, de modo que não havia como partir de um pedido confirmado e ver o que tinha acontecido na cobrança dele.

A telemetria apontou a função antes de o código ser lido: o span `pedido.processar` do trace abaixo tem, ao mesmo tempo, `cobranca.resultado=falha`, `pedido.status=confirmado` e a exceção registrada.

## Evidências

**Trace.** `trace_id` `b25cab96e9d08ccb8cf5e9ae5817a87a`, pedido 474, aberto em `http://localhost:16686/trace/b25cab96e9d08ccb8cf5e9ae5817a87a`.

Resultado: um único trace com 19 spans dos dois serviços. Da `api`: `POST /pedidos`, `pedido.criar`, as consultas ao Postgres e o `lpush` no Redis. Do `worker`: `pedido.processar` e o `UPDATE` do pedido. O span `pedido.processar` está marcado como erro (`error=true`, `otel.status_code=ERROR`), com o evento de exceção `gateway respondeu de forma inesperada` e os atributos:

```
pedido.id = 474
cliente.id = cli-0057
pedido.valor_total = 189.69
cobranca.resultado = falha
pedido.status = confirmado
```

`GET /pedidos/474` devolveu `{"id":474,"cliente_id":"cli-0057","status":"confirmado","valor_total":189.69}`: para o cliente, o pedido está confirmado.

A busca do Jaeger por `service=worker` com a tag `error=true` devolveu 20 traces, que é o limite pedido na busca.

**PromQL.**

```
sum by (resultado) (cobrancas_processadas_total)
```

Resultado ao fim da reprodução: `aprovada` 567, `recusada` 54, `falha` 131. Ao fim do `normal`, a mesma query tinha devolvido `aprovada` 402, `recusada` 35, `falha` 0: todas as 131 falhas são do `cenario-a`.

```
sum by (resultado) (increase(cobrancas_processadas_total[216s]))
```

Resultado, com a janela cobrindo o `cenario-a`: `aprovada` 166,2, `recusada` 17,7, `falha` 131,8 (estimativa).

```
sum(pedidos_confirmados_total)
```

Resultado: 698. Confirmados (698) menos cobranças aprovadas (567) dá 131, o mesmo número das falhas.

```
sum(rate(cobrancas_processadas_total{resultado="falha"}[5m])) / sum(rate(cobrancas_processadas_total[5m]))
```

Resultado ao fim da reprodução: 0,274 (27,4%), contra o limiar de 0,0144. Na janela de 1 hora, 0,174.

**Log.**

```
docker compose logs --no-log-prefix worker | grep '"level":"error"'
```

Resultado: 131 linhas, todas com a mensagem `falha ao processar a cobranca: gateway respondeu de forma inesperada`, a primeira às 22:46:57.211 e a última às 22:49:53.743. Somando o campo `valor_total` dessas linhas: 124236,05.

```
docker compose logs api worker | grep b25cab96e9d08ccb8cf5e9ae5817a87a
```

Resultado: 4 linhas, 1 da `api` e 3 do `worker`, com o mesmo `trace_id` do Jaeger:

```
api-1     | {"timestamp":"2026-11-16T22:46:59.361Z","level":"info","service":"api","msg":"pedido 474 criado para cli-0057","trace_id":"b25cab96e9d08ccb8cf5e9ae5817a87a","span_id":"f0e62720c9c9d347","pedido_id":474}
worker-1  | {"timestamp":"2026-11-16T22:46:59.361Z","level":"info","service":"worker","msg":"mensagem do pedido 474 recebida da fila","trace_id":"b25cab96e9d08ccb8cf5e9ae5817a87a","span_id":"1869151828e2b746","pedido_id":474}
worker-1  | {"timestamp":"2026-11-16T22:46:59.405Z","level":"error","service":"worker","msg":"falha ao processar a cobranca: gateway respondeu de forma inesperada","trace_id":"b25cab96e9d08ccb8cf5e9ae5817a87a","span_id":"1869151828e2b746","pedido_id":474,"motivo":"gateway respondeu de forma inesperada","cliente_id":"cli-0057","valor_total":189.69}
worker-1  | {"timestamp":"2026-11-16T22:46:59.406Z","level":"info","service":"worker","msg":"pedido 474 ficou confirmado","trace_id":"b25cab96e9d08ccb8cf5e9ae5817a87a","span_id":"1869151828e2b746","pedido_id":474}
```

A terceira e a quarta linhas, separadas por 1 milissegundo, são o incidente inteiro: a cobrança falha e o pedido fica confirmado.

## Lições aprendidas

**O que correu bem**

- Com a instrumentação completa, o caminho do sintoma à causa levou minutos e não dependeu de palpite: o dashboard mostrou confirmados acima de cobranças aprovadas, a métrica deu o tamanho, o log deu a lista de pedidos e o motivo, e o trace mostrou o ponto exato em que falha virou confirmação.
- Três fontes independentes (log, contador e banco) chegaram ao mesmo número, 131, e duas ao mesmo valor. Isso dá confiança para a conciliação.
- O alerta derivado do SLO ficou em silêncio no tráfego saudável, que tem cerca de 8% de recusas legítimas, e disparou em 58 segundos no incidente. Separar recusa de falha no SLI foi o que evitou alarme falso.

**O que correu mal**

- A detecção foi feita pelo financeiro, no fechamento do mês. O sistema sabia de cada falha no instante em que ela acontecia e não contava a ninguém.
- Todo o monitoramento existente olhava de fora: status HTTP e latência. O incidente inteiro aconteceu com 100% de respostas 2xx.
- O único registro da falha era uma lista em memória, com 500 posições, apagada a cada reinício do worker. Não serve para detectar nem para conciliar depois.
- A primeira explicação que circulou, "deve ser problema do banco", não tinha evidência. Sem telemetria, a investigação começou por suposição.
- Não existe métrica de valor. Para saber quanto dinheiro está envolvido ainda é preciso somar linhas de log ou consultar o banco.

**Onde tivemos sorte**

- O financeiro faz o cruzamento entre pedidos confirmados e dinheiro recebido. Sem essa rotina manual, o problema continuaria indefinidamente.
- Os pedidos afetados continuam no banco, com cliente e valor, então a lista do log pode ser conciliada pedido a pedido. Se o dado fosse perdido junto com a lista em memória, o prejuízo seria irrecuperável.
- A falha é determinística para um grupo de clientes, o que tornou a reprodução imediata. Uma falha intermitente do processador produziria o mesmo prejuízo com muito menos pistas.
- O defeito erra sempre para o mesmo lado, o de entregar sem cobrar. O erro simétrico, cobrar sem confirmar, teria chegado antes pelo atendimento, mas com dano direto ao cliente.

## Itens de ação

| Ação | Tipo | Prioridade |
| ---- | ---- | ---------- |
| Correção definitiva em `decidirStatusDoPedido` (`src/worker/conciliacao.ts`): falha de cobrança deixa de resultar em `confirmado`. O pedido permanece `pendente` (ou vai para um estado próprio de falha) e a cobrança é reprocessada com idempotência. **Descrita aqui, não executada nesta entrega.** | Evitar | P0 |
| Conciliar os pedidos confirmados sem cobrança a partir da lista de `pedido_id` das linhas de erro: cobrar ou cancelar cada um, junto com o financeiro | Mitigar | P0 |
| Teste automatizado do worker cobrindo o caso "o processador lança exceção": o pedido não pode terminar `confirmado` | Evitar | P1 |
| Manter o alerta `FalhaEmCobrancas` como página e escrever o runbook dele: buscar `level=error` no log do worker, abrir o `trace_id`, extrair a lista de pedidos | Mitigar | P1 |
| Rotina automática diária de conciliação entre `pedidos_confirmados_total` e cobranças aprovadas, com alerta quando a diferença for maior que zero, para não depender do fechamento mensal | Mitigar | P1 |
| Regra de revisão e de lint: nenhum `catch` engole exceção sem log de erro, registro no span e métrica | Evitar | P2 |
| Remover o registro em memória (`registro-legado.ts`) depois da correção, para que ele não volte a ser tratado como registro válido de falha | Evitar | P3 |

## Timeline

Horários em UTC, 16/11/2026, reconstruídos dos logs dos processos, do Prometheus e do `receptor-alertas`.

| Horário | Evento | Fonte |
| --- | --- | --- |
| antes | O financeiro fecha o mês, cruza pedidos confirmados com o que entrou e encontra pedidos confirmados sem cobrança. A hipótese em circulação é "problema do banco" | Queixa |
| 22:42:20 | Stack subida do zero | Reprodução |
| 22:42:51 | `api` e `worker` no ar. Os três contadores de negócio existem em zero, a regra `FalhaEmCobrancas` está carregada sem erro e o dashboard `Pedidos` está provisionado com 4 painéis | Log, `/metrics`, API do Prometheus e do Grafana |
| 22:43:21 | Início do cenário `normal` | Reprodução |
| 22:46:54 | Fim do `normal`: 437 cobranças, 402 aprovadas, 35 recusadas, 0 falhas. Nenhum alerta no receptor | Prometheus, log do receptor |
| 22:46:54 | Início do `cenario-a` | Reprodução |
| 22:46:57 | Primeira linha `error` no worker: `falha ao processar a cobranca: gateway respondeu de forma inesperada`. O pedido correspondente fica `confirmado` | Log do worker |
| 22:46:59 | Pedido 474 (trace `b25cab96e9d08ccb8cf5e9ae5817a87a`): criado pela API, cobrança falha às 22:46:59.405, pedido confirmado às 22:46:59.406 | Log e Jaeger |
| 22:47:10 | A proporção de falha cruza 1,44% nas duas janelas e a regra fica pendente | `activeAt` no Prometheus |
| 22:47:40 | Fim do `for` de 30 s: a regra passa a disparar (horário deduzido de `activeAt` mais o `for`) | Prometheus |
| 22:47:50 | `alerta=FalhaEmCobrancas status=firing` no `receptor-alertas`, 58 s depois do início do `cenario-a` | Log do receptor |
| 22:49:53 | Última linha `error` do período | Log do worker |
| 22:49:54 | `cenario-a` interrompido | Reprodução |
| 22:50:30 | Coleta das evidências: 131 linhas de erro, R$ 124.236,05; contador de falhas em 131; 131 de 131 pedidos `confirmado` no banco; trace do pedido 474 aberto no Jaeger; defeito localizado em `decidirStatusDoPedido` | Log, Prometheus, Postgres, Jaeger |
