# Design: Módulo de Vendas — Integração Mercado Livre

**Data:** 2026-08-03
**Status:** Aprovado para planejamento

## Contexto

Dashboard interna para a empresa acompanhar vendas, estoque, faturamento, anúncios,
financeiro e margem de contribuição, integrando com os marketplaces em que a empresa
vende (Mercado Livre, Shopee, Amazon, TikTok Shop). Esta é a primeira entrega do
projeto: escopo limitado a **Mercado Livre** e ao módulo de **Vendas**, ponta a ponta,
antes de expandir para os demais marketplaces e módulos.

## Restrição de segurança (obrigatória)

**Acesso somente leitura.** O aplicativo do Mercado Livre foi criado com todos os
escopos de permissão configurados como "Leitura" — nenhum como "Leitura e escrita".
O código da aplicação nunca deve implementar chamadas de escrita (criar, editar ou
excluir recursos) contra a API do Mercado Livre ou de qualquer outro marketplace,
mesmo que tecnicamente possível. Essa é uma decisão de design permanente até o
usuário decidir explicitamente liberar escrita.

## Infraestrutura já provisionada

- VPS Hostinger (KVM 2), IP `2.25.95.146`, com EasyPanel instalado (porta 3000).
- Domínio `salfhcosmeticos.tech` com DNS apontado para o VPS (registro A `@` e
  CNAME `www`), SSL emitido automaticamente pelo EasyPanel.
- Projeto EasyPanel `dashboard-marketplaces`, atualmente com um serviço placeholder
  (`nginxdemos/hello`) que será substituído pela aplicação real.
- App criado no DevCenter do Mercado Livre: fluxos OAuth Authorization Code +
  Refresh Token (Client Credentials e PKCE desativados), redirect URI
  `https://salfhcosmeticos.tech/auth/mercadolivre/callback`, com todos os escopos
  necessários (Usuários, Vendas e envios, Faturamento, Métricas de negócio,
  Publicidade em anúncios) configurados como leitura.

## Arquitetura

Aplicação única em **Next.js**, rodando como um único container Docker no
EasyPanel, servida em `https://salfhcosmeticos.tech`, substituindo o placeholder
atual.

- **Frontend:** páginas Next.js com a dashboard de vendas.
- **Backend (API Routes do Next.js):**
  - Callback OAuth do Mercado Livre (`/auth/mercadolivre/callback`)
  - Endpoint que recebe webhooks de pedidos do Mercado Livre
  - Rotina de sincronização periódica (job de segurança)
- **Dados e autenticação:** Supabase (Postgres gerenciado + Supabase Auth para o
  login do usuário dono da conta).
- **Segredos:** Client ID/Secret do Mercado Livre e chaves do Supabase ficam como
  variáveis de ambiente no serviço do EasyPanel — nunca no código.

Escolhida entre três alternativas (app único Next.js / frontend+backend separados /
lógica em Supabase Edge Functions) por ser a mais simples de implantar e manter
sobre a infraestrutura já provisionada, mantendo espaço para separar serviços no
futuro se necessário.

## Fluxo de dados

1. **Conexão da conta (uma vez):** usuário clica em "Conectar Mercado Livre" →
   autoriza no ML (somente leitura) → ML redireciona para o callback com um código
   → backend troca o código por access token + refresh token → tokens salvos de
   forma segura no Supabase, vinculados à conta do usuário.
2. **Carga inicial (backfill de 12 meses):** ao conectar, processo em segundo
   plano busca todos os pedidos dos últimos 12 meses (em lotes, respeitando limites
   de requisição da API) e grava no Supabase. UI mostra indicador de carregamento
   enquanto isso roda.
3. **Tempo real:** Mercado Livre envia webhook ao endpoint da aplicação quando um
   pedido é criado ou muda de status (contém só o ID do recurso) → backend busca os
   detalhes completos na API → atualiza o Supabase → frontend escuta mudanças via
   Supabase Realtime e atualiza a tela sem reload.
4. **Sincronização periódica de segurança:** a cada 15–30 min, revalida pedidos
   recentes para cobrir eventuais falhas de entrega de webhook.
5. **Renovação de token:** access token (validade de poucas horas) é renovado
   automaticamente via refresh token, sem exigir nova autorização do usuário.

## Modelo de dados (Supabase)

- **`marketplace_accounts`** — conta de marketplace conectada: dono (Supabase
  Auth), marketplace (`mercado_livre`, extensível para os demais), ID do vendedor
  no ML, tokens de acesso/renovação, data de expiração.
- **`orders`** — pedidos importados: ID do pedido no ML, status, valor total,
  moeda, data, vinculado a `marketplace_accounts`.
- **`order_items`** — itens de cada pedido (título, quantidade, valor unitário) —
  já prepara a base para cálculo futuro de margem de contribuição por produto.
- **`sync_runs`** — log de cada execução de sincronização (backfill/periódica):
  quando rodou, quantos pedidos processados, erros — usado para diagnóstico.

Row Level Security habilitada em todas as tabelas, restringindo o acesso aos dados
ao dono da conta — já deixa o caminho pronto para liberar acesso a funcionários no
futuro.

## Funcionalidades da tela (v1 — Vendas)

- Lista de pedidos: status, valor, data, produto.
- Resumo: faturamento e quantidade de pedidos do período, ticket médio.
- Gráfico de vendas com faturamento (R$) e quantidade de pedidos, com alternância
  de visualização por dia / semana / mês / ano.

## Autenticação da dashboard

Login único (o dono da conta) via Supabase Auth nesta primeira versão. O modelo de
dados já contempla extensão futura para liberar acesso a funcionários com
permissões específicas — esse sistema de papéis/permissões não será construído
agora (YAGNI), apenas não bloqueado estruturalmente.

## Tratamento de erros

- **Token expirado/revogado:** dashboard exibe aviso claro pedindo reconexão, sem
  quebrar o restante da aplicação.
- **Rate limit da API do Mercado Livre:** backend aguarda e tenta novamente
  automaticamente durante o backfill, em vez de falhar.
- **Webhook duplicado/fora de ordem:** atualizações são idempotentes por ID do
  pedido — não duplicam dados.
- **Falha de sincronização:** registrada em `sync_runs`; processo é reexecutável
  sem duplicar dados.
- **Garantia de só-leitura:** nenhuma função do código monta chamadas de escrita
  para a API do Mercado Livre.

## Testes e verificação

- Testes automatizados para lógica isolada: agregação dos totais do gráfico
  (dia/semana/mês/ano), renovação de token, deduplicação de pedidos.
- Verificação manual da conexão real: conectar a conta de verdade e confirmar que
  os tokens são salvos e que a carga de 12 meses aparece corretamente.
- Verificação do tempo real: confirmar que um pedido novo/atualizado aparece na
  dashboard sem reload.
- Nenhuma etapa será declarada "pronta" sem evidência de execução real.

## Fora de escopo nesta entrega

- Shopee, Amazon, TikTok Shop (marketplaces futuros).
- Módulos de estoque, faturamento, anúncios, financeiro, margem de contribuição.
- Sistema de permissões por funcionário (estrutura de dados preparada, mas não
  implementado).
- Qualquer operação de escrita nos marketplaces.
