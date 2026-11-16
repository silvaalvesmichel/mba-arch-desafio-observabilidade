# Do sintoma ao post-mortem

Entrega do desafio de Observabilidade e DevOps/SRE do MBA em Arquitetura Full Cycle: a instrumentação da loja de pedidos completada (log ligado ao trace, contexto atravessando a fila, métricas de negócio, dashboard, SLO e alerta) e o incidente "pedidos confirmados sem cobrança" investigado em [reports/post-mortem.md](reports/post-mortem.md).

O defeito da aplicação **não foi corrigido**, de propósito: ele é o que a instrumentação revela.

## Como rodar

Pré-requisitos: Docker, Docker Compose v2 e `curl`.

```
git clone https://github.com/silvaalvesmichel/mba-arch-desafio-observabilidade.git
cd mba-arch-desafio-observabilidade
cp .env.example .env
docker compose up -d
curl -s localhost:8080/health
```

O primeiro `up` constrói a imagem da aplicação. A stack inteira sobe pronta, sem nenhum clique:

| O que | Onde |
| --- | --- |
| API | http://localhost:8080 (`/health`, `/metrics`, `/produtos`, `/pedidos`) |
| Worker | http://localhost:8081 (`/health`, `/metrics`) |
| Jaeger | http://localhost:16686 |
| Prometheus | http://localhost:9090 (regra em `/rules`, alvos em `/targets`) |
| Grafana | http://localhost:3000 (usuário e senha do `.env`), dashboard `Pedidos` |
| Alertmanager | http://localhost:9093 |
| Receptor de alertas | `docker compose logs receptor-alertas` |

Carga:

```
docker compose run --rm carga normal
docker compose run --rm carga cenario-a
```

Cada cenário roda até Ctrl+C. Em segundo plano: `docker compose run --rm -d carga normal`, e para parar, `docker stop $(docker ps -q --filter name=carga-run)`.

Depois de editar algo em `src/`, `docker compose restart api worker`. Para recomeçar do zero, `docker compose down -v`.

### Roteiro de conferência

```
# contadores de negócio em zero, antes de qualquer tráfego
curl -s localhost:8080/metrics localhost:8081/metrics | grep -E '^(pedidos_|cobrancas_)'

# log: toda linha é JSON com trace_id e span_id
docker compose logs api | tail -20
docker compose logs worker | tail -20

# um pedido: pegue o trace_id na linha de log e abra em http://localhost:16686/trace/<trace_id>
curl -s -X POST localhost:8080/pedidos -H 'content-type: application/json' \
  -d '{"cliente_id":"cli-0001","itens":[{"produto_id":1,"quantidade":1}]}'
docker compose logs --no-log-prefix api worker | grep '"pedido_id":25'

# o mesmo trace_id devolve linhas da api e do worker
docker compose logs api worker | grep <trace_id>

# silêncio no normal (3 minutos) e disparo no cenario-a (até 5 minutos)
docker compose restart receptor-alertas
docker compose run --rm carga normal
docker compose logs receptor-alertas
docker compose run --rm carga cenario-a
docker compose logs receptor-alertas

# linhas de erro com o motivo, no cenario-a
docker compose logs --no-log-prefix worker | grep '"level":"error"' | tail -5
```

No Jaeger, os traces com erro aparecem com a busca `service=worker` e a tag `error=true`.

## Equivalências com o curso

| Tema | No curso (Java) | Aqui (TypeScript) |
| --- | --- | --- |
| Métricas | Micrometer (`Counter`, `Timer`) exposto pelo Spring Boot Actuator em `/actuator/prometheus` | `prom-client` (`Counter`, `Histogram`, `Registry`) exposto em `/metrics` pelos dois processos: `src/telemetria/metricas.ts` e `src/api/metricas-http.ts` |
| Tracing | Micrometer Tracing com o bridge do OpenTelemetry, spans automáticos do Spring e manuais pela Observation API, exportando por OTLP | `@opentelemetry/sdk-node` com `@opentelemetry/auto-instrumentations-node` (HTTP, Express, `pg`, `ioredis`) e exportador OTLP HTTP para o Jaeger em `src/telemetria/otel.ts`; spans manuais com `tracer.startActiveSpan` da `@opentelemetry/api` |
| Logs estruturados | Logback em JSON, com `traceId` e `spanId` colocados no MDC pelo Micrometer Tracing | Logger próprio em `src/telemetria/log.ts`: uma linha JSON por evento no stdout, com `trace_id` e `span_id` lidos de `trace.getActiveSpan().spanContext()` no momento da escrita. O papel do MDC é feito pelo `Context` do OpenTelemetry (é dele que sai o `pedido_id`) |
| Propagação de contexto | W3C Trace Context injetado e extraído pelo bridge nos clientes HTTP e de mensageria do Spring | W3C Trace Context à mão, pela API de propagação: `propagation.inject(context.active(), carrier)` na publicação (`src/fila/fila.ts`) e `propagation.extract(ROOT_CONTEXT, carrier)` no consumo (`src/worker/index.ts`). O `traceparent` viaja no campo `rastreio` da mensagem do Redis |

## Decisões técnicas

### O erro de cardinalidade

O histograma `http_request_duration_seconds` usava `requisicao.path` no label `route`, ou seja, o caminho concreto (`/produtos/42`, `/pedidos/1837`). Em uma frase: cada identificador novo cria uma família inteira de séries (uma por bucket, mais `_sum` e `_count`, vezes método e status) que nunca mais recebe amostra mas fica no índice e na memória do Prometheus, então o número de séries cresce junto com o número de pedidos, sem teto, até o Prometheus morrer por falta de memória.

A correção usa o template da rota (`requisicao.route.path`, por exemplo `/produtos/:id`) e um valor fixo, `nao_mapeada`, para requisição que não casa com rota nenhuma. Esse segundo ponto importa: sem ele, qualquer varredura de URLs aleatórias reabre o mesmo problema.

Identificador de pedido e de cliente não aparece em label de métrica nenhuma. Ele está onde custa barato e resolve o caso individual: nos atributos dos spans (`pedido.id`, `cliente.id`) e nos campos do log (`pedido_id`, `cliente_id`).

### O que cada métrica de negócio responde

| Métrica | Onde é incrementada | Pergunta que responde |
| --- | --- | --- |
| `pedidos_criados_total` | `api`, depois de gravar o pedido como `pendente` | Quanta demanda está entrando? É o denominador de tudo: se cai, o problema está antes da cobrança |
| `pedidos_confirmados_total` | `worker`, quando o pedido passa a `confirmado` | Quantos pedidos a loja prometeu entregar? |
| `cobrancas_processadas_total{resultado}` | `worker`, a cada tentativa de cobrança: `aprovada`, `recusada` ou `falha` | O que aconteceu com o dinheiro de cada pedido? `aprovada` é dinheiro que entrou, `recusada` é resposta legítima do processador, `falha` é a cobrança que não terminou |

Sozinha, nenhuma conta a história. Juntas, sim: em operação saudável `pedidos_confirmados_total` e `cobrancas_processadas_total{resultado="aprovada"}` crescem no mesmo passo. Quando os confirmados andam na frente das aprovadas, existe pedido confirmado sem dinheiro, e a diferença é exatamente a quantidade deles.

Os três contadores nascem em zero na subida, incluindo os três valores de `resultado`. Sem isso, a série `resultado="falha"` só existiria depois da primeira falha, e a proporção usada pelo alerta devolveria "sem dados" em vez de zero.

As métricas respondem **quantos** pedidos. Elas não respondem **quanto dinheiro**: o valor de cada pedido fica no log (`valor_total` na linha de erro) e no span (`pedido.valor_total`), que é onde dá para carregar dado por pedido sem custo de cardinalidade.

### Spans, fila e log

- `pedido.criar` envolve o `POST /pedidos` e carrega `cliente.id`, `pedido.quantidade_de_itens`, `pedido.id` e `pedido.valor_total`.
- `pedido.processar` envolve o processamento da mensagem no worker, com `pedido.id`, `cliente.id`, `pedido.valor_total`, `pedido.status`, `cobranca.resultado` e os atributos de mensageria.
- O contexto é extraído sobre `ROOT_CONTEXT`, não sobre o contexto ativo do worker, para o `pedido.processar` nascer como filho do span da API que publicou a mensagem.
- Exceção capturada vira três coisas: `recordException` no span ativo, status do span em erro e uma linha de log `error` com o motivo. Isso vale inclusive dentro do `catch` de `decidirStatusDoPedido`, que antes não contava nada a ninguém. O fluxo é o mesmo de antes: o `catch` do `POST /pedidos` e o do worker relançam o erro.
- `pedido_id` chega ao log por dois caminhos: explícito na API e, no worker, por uma chave do `Context` do OpenTelemetry, de modo que toda linha escrita durante o processamento de um pedido carrega o identificador, mesmo em função que não o recebe como parâmetro.

### O dashboard

Um dashboard, `Pedidos`, com quatro painéis:

| Painel | Pergunta |
| --- | --- |
| O sistema está com erro? % de cobranças com falha e % de respostas HTTP 5xx, contra o limiar do alerta | **O sistema está com erro?** Mostra o erro que o cliente vê (5xx) e o que ele não vê (cobrança que falhou), com a linha do limiar do alerta para comparação |
| O sistema está lento? Latência das requisições HTTP da API (p50, p95 e p99) | **O sistema está lento?** |
| O dinheiro está entrando? Pedidos confirmados contra cobranças aprovadas, por minuto | **O dinheiro está entrando?** As duas linhas andam juntas quando está tudo bem; quando se separam, a loja está confirmando o que não cobrou |
| O dinheiro está entrando? Pedidos confirmados sem cobrança aprovada no intervalo selecionado | **O dinheiro está entrando?** O tamanho do buraco em um número: verde em zero, vermelho a partir de um |

O painel de tráfego que vinha de exemplo saiu: volume de requisição não responde nenhuma das três perguntas, e o volume que interessa ao negócio (pedidos criados) está no terceiro painel.

## SLO e alerta

**SLI.** Proporção das cobranças que o processador de pagamento concluiu, aprovando ou recusando, sobre o total de cobranças tentadas. Recusa é resposta legítima e conta como sucesso; falha técnica é o evento ruim.

```
  sum(rate(cobrancas_processadas_total{resultado!="falha"}[30d]))
/
  sum(rate(cobrancas_processadas_total[30d]))
```

**SLO.** 99,9% das cobranças concluídas sem falha técnica, medido em janela móvel de 30 dias.

O número vem do que a falha significa aqui: cobrança que falha é pedido cujo dinheiro não entrou. Com 99,9%, a loja aceita que no máximo 1 cobrança em cada 1.000 fique sem conclusão antes de alguém ser chamado.

**Error budget.** 1 − 0,999 = 0,001, isto é, **0,1% das cobranças da janela de 30 dias**. No volume do gerador de carga, de 2 pedidos por segundo, são cerca de 5,2 milhões de cobranças em 30 dias e um budget de cerca de 5.200 cobranças com falha.

**Do SLO ao limiar.** Alertar no próprio SLO (0,1% em 30 dias) só avisaria depois de o budget ter acabado. O alerta olha a velocidade com que o budget é gasto, a taxa de queima (burn rate):

```
burn rate = proporção de falha observada / error budget
```

Burn rate 1 gasta o budget exatamente em 30 dias. A decisão de negócio é: **alguém deve ser chamado quando 2% do budget do mês for embora em 1 hora**. A conta:

```
burn rate = fração do budget × (janela do SLO / janela do alerta)
          = 0,02 × (720 h / 1 h)
          = 14,4

limiar = burn rate × error budget
       = 14,4 × 0,001
       = 0,0144   (1,44% das cobranças em falha)
```

Nessa velocidade, o budget de 30 dias inteiro acaba em 720 h / 14,4 = 50 horas. É a condição de página rápida do capítulo de alertas do SRE Workbook.

**A regra**, em `prometheus/regras/cobrancas.yml`:

```
(
    sum(rate(cobrancas_processadas_total{resultado="falha"}[1h]))
  /
    sum(rate(cobrancas_processadas_total[1h]))
) > (14.4 * 0.001)
and
(
    sum(rate(cobrancas_processadas_total{resultado="falha"}[5m]))
  /
    sum(rate(cobrancas_processadas_total[5m]))
) > (14.4 * 0.001)
```

com `for: 30s`. O limiar está escrito como `14.4 * 0.001` para a origem do número ficar na própria regra.

São duas janelas com o mesmo limiar. A de 1 hora é a que a conta acima pede: ela mede se a queima é grande o bastante para pesar no budget. A de 5 minutos confirma que a falha ainda está acontecendo, e é o que faz o alerta fechar poucos minutos depois de o problema parar, em vez de ficar aceso por uma hora.

**Comportamento.**

- `normal`: nenhuma cobrança falha (as recusas legítimas, 8% na reprodução, não contam), a proporção fica em 0 e a regra não dispara.
- `cenario-a`: cerca de 40% das cobranças falham, 28 vezes o limiar.
- Tempo de detecção: a proporção precisa diluir o tráfego saudável que está na janela de 1 hora. Com 40% de falha e `t` minutos de `cenario-a` depois de `n` minutos de `normal`, o limiar é cruzado quando `0,4·t / (n + t) > 0,0144`, isto é, `t > 0,037·n`: 7 segundos depois de 3 minutos de `normal`, 2 minutos e 10 segundos no pior caso (janela de 1 hora cheia de `normal`). Somam-se a isso até 15 s de coleta, até 15 s de avaliação da regra, os 30 s do `for` e os 10 s de `group_wait` do Alertmanager. Na reprodução do post-mortem, o webhook chegou ao receptor 58 segundos depois do início do `cenario-a`.
