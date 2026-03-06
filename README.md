# Delivery API

API backend (NestJS + GraphQL) do sistema de delivery.

## Pré-requisitos

- Node.js 18+
- Docker e Docker Compose (recomendado) **ou** PostgreSQL 16+ e Redis 7+ instalados localmente

## Instalação

```bash
npm install
```

## Variáveis de ambiente

Copie o arquivo de exemplo e configure:

```bash
cp .env.example .env
```

## Rodando

### Com Docker (recomendado)

Sobe a API + PostgreSQL + Redis:

```bash
docker compose up
```

### Sem Docker

Certifique-se de ter PostgreSQL e Redis rodando, configure o `.env` e execute:

```bash
npm run start:dev   # Desenvolvimento (watch mode)
npm run start       # Produção
```

A API estará disponível em `http://localhost:3000/graphql`.

## Scripts

| Comando | Descrição |
|---|---|
| `npm run start:dev` | Desenvolvimento com hot-reload |
| `npm run start` | Iniciar servidor |
| `npm run build` | Build de produção |
| `npm run start:prod` | Rodar build de produção |
| `npm test` | Rodar testes unitários |
| `npm run test:e2e` | Rodar testes e2e |

## Estrutura

- `src/auth/` - Autenticação (JWT, guards, strategies)
- `src/users/` - Módulo de usuários
- `src/stores/` - Módulo de lojas
- `src/products/` - Módulo de produtos
- `src/categories/` - Módulo de categorias
- `src/orders/` - Módulo de pedidos
- `src/deliveries/` - Módulo de entregas (WebSocket)
- `src/addresses/` - Módulo de endereços
