# Agrolote — Gestão de Lotes e Safras (PWA Offline-First)

SaaS agrícola leve para pequenos/médios produtores: cadastre lotes, planeje plantios, controle insumos/gastos, registre colheitas e veja relatórios de custo/lucro — **100% offline** via PWA + IndexedDB, com sincronização resiliente quando a conexão volta.

Deploy gratuito no Render: **https://agrolote.onrender.com**

---

## 🎯 Funcionalidades

| Módulo | Descrição |
|--------|-----------|
| **Lotes** | Talhões, estufas, bancadas — área, tipo, localização |
| **Plantios** | Cultura, cultivar, datas, quantidade, status (planejado/ativo/colhido/perdido) |
| **Insumos** | Sementes, fertilizantes, defensivos — categoria, unidade |
| **Gastos** | Vinculados a plantio + insumo — qtd, valor unitário, data |
| **Colheitas** | Quantidade, preço de venda, data — calcula receita automaticamente |
| **Relatórios** | Dashboard (ativos, custos 30d, receitas 30d, lucro) + Performance por cultura |
| **Export CSV** | Todos os dados do usuário em um clique |
| **Sync Offline-First** | Edita offline → push de operações + snapshot completo ao reconectar |

---

## 🛡️ Segurança (Hardening Completo)

> Todas as vulnerabilidades abaixo foram **testadas ao vivo** contra a API em produção e corrigidas.

| Vetor de Ataque | Status | Mitigação Implementada |
|-----------------|--------|------------------------|
| **Brute-force login** | ✅ Bloqueado | `express-rate-limit`: 10 req/15min em `/auth/login` e `/auth/register` (429 Too Many Requests) |
| **Stored XSS** | ✅ Sanitizado | `sanitizeText()` remove `< > " ' \`` em todos os outputs JSON (CRUD, sync, relatórios) |
| **Validação de entrada fraca** | ✅ Rígida | **Zod schemas** por entidade: email regex, UUID, ranges numéricos, datas ISO, tamanhos máximos |
| **JWT `alg=none`** | ✅ Prevenido | `jwt.verify(token, secret, { algorithms: ["HS256"], issuer, audience })` |
| **JWT secret default / expiração longa** | ✅ Corrigido | `JWT_SECRET` **obrigatório em produção** (crash no boot se ausente); TTL **7 dias** |
| **Headers de segurança ausentes** | ✅ Completos | **Helmet** com: HSTS (1 ano + preload), CSP strict (`default-src 'self'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `COOP`, `CORP`, `hidePoweredBy` |
| **CORS aberto (`*`)** | ✅ Restrito | Apenas `https://agrolote.onrender.com` em produção; credenciais permitidas |
| **DoS via payload gigante (sync)** | ✅ Limitado | `express.json({ limit: "256kb" })` + **máx 100 ops** por request de sync |
| **SQL Injection** | ✅ Prevenido | **Prepared statements** nativos do `node:sqlite` + validação Zod antes de tocar no DB |
| **Vazamento de erro interno** | ✅ Genérico | Em produção: `"Sincronização falhou"` sem stack trace; dev vê mensagem real |
| **Path traversal** | ✅ Não explorável | SPA fallback só serve `index.html`; arquivos estáticos com `express.static` seguro |

### Arquitetura de Segurança em Camadas

```
┌─────────────────────────────────────────────────────────────┐
│  EDGE (Cloudflare/Render)                                   │
│  - TLS 1.3, HSTS, WAF básico                                │
├─────────────────────────────────────────────────────────────┤
│  HELMET (Express)                                           │
│  - CSP, HSTS, X-Frame, nosniff, referrer, COOP, CORP       │
├─────────────────────────────────────────────────────────────┤
│  CORS RESTRICTIVO                                           │
│  - origin allowlist, credentials, métodos/headers permitidos│
├─────────────────────────────────────────────────────────────┤
│  RATE LIMIT                                                 │
│  - login/register: 10/15min por IP                          │
├─────────────────────────────────────────────────────────────┤
│  JWT STRICT                                                 │
│  - HS256 only, issuer/audience, 7d TTL, secret obrigatório │
├─────────────────────────────────────────────────────────────┤
│  VALIDAÇÃO ZOD (por entidade)                               │
│  - tipos, ranges, formatos, sanitização XSS no output       │
├─────────────────────────────────────────────────────────────┤
│  PREPARED STATEMENTS (node:sqlite)                          │
│  - zero concatenação de SQL                                 │
├─────────────────────────────────────────────────────────────┤
│  SANITIZAÇÃO DE SAÍDA                                       │
│  - strip HTML chars em todo JSON retornado ao cliente       │
└─────────────────────────────────────────────────────────────┘
```

---

## 🏗️ Tech Stack

| Camada | Tecnologia | Versão |
|--------|------------|--------|
| **Runtime** | Node.js | ≥ 22 (LTS) — `node:sqlite` nativo |
| **API** | Express | 4.21 |
| **Banco** | SQLite (WAL + FK) | `node:sqlite` `DatabaseSync` |
| **Auth** | JWT (HS256) + bcryptjs | 9.0 / 2.4 |
| **Validação** | Zod | 3.25 |
| **Segurança** | Helmet, express-rate-limit | 8.3 / 8.6 |
| **Frontend** | React 18 + Vite 5 + TypeScript | 18 / 5 / 5 |
| **Offline DB** | Dexie.js (IndexedDB) | 4.0 |
| **PWA** | vite-plugin-pwa (Workbox) | 0.20 |
| **Deploy** | Docker (node:22-alpine) → Render Free | — |

---

## 📁 Estrutura do Monorepo

```
.
├── client/                 # React PWA (Vite + TS)
│   ├── src/
│   │   ├── db/             # Dexie + sync engine
│   │   ├── components/     # UI (lotes, plantios, insumos, gastos, colheitas)
│   │   ├── pages/          # Dashboard, Relatórios, Configurações
│   │   └── store/          # Auth context + Zustand
│   └── vite.config.ts      # PWA config
│
├── server/                 # Express API
│   ├── src/
│   │   ├── routes/
│   │   │   ├── auth.js     # login/register + JWT
│   │   │   ├── crud.js     # CRUD genérico por entidade
│   │   │   ├── sync.js     # Sync offline-first (ops + snapshot)
│   │   │   └── reports.js  # Dashboard + Performance
│   │   ├── auth.js         # JWT sign/verify + middleware
│   │   ├── db.js           # SQLite schema + migrate
│   │   ├── validation.js   # Zod schemas + sanitizeText
│   │   ├── index.js        # App entry + helmet/cors/ratelimit
│   │   └── seed.js         # Dados demo
│   └── package.json
│
├── Dockerfile              # Multi-stage: build client → copy → run server
├── render.yaml             # Render Blueprint (free tier)
├── .dockerignore
└── README.md
```

---

## 🚀 Deploy no Render (Free Tier)

### 1. Push para GitHub
```bash
git init
git add .
git commit -m "initial"
git branch -M master
git remote add origin https://github.com/SEU_USUARIO/agrolote.git
git push -u origin master
```

### 2. No Render Dashboard
- **New → Blueprint** → conecte o repositório → **Apply**
- O `render.yaml` cria:
  - **Web Service** (`agrolote`) — Docker, plano Free, região Virginia
  - **Health Check** em `/api/health`
  - **Auto-deploy** a cada push no `master`
  - **Env vars**: `NODE_ENV=production`, `SEED_DEMO=true`, `JWT_SECRET` (gerado automaticamente)

### 3. Acesso
- URL: `https://agrolote.onrender.com`
- Demo: `demo@agrolote.app` / `demo123` (auto-seed no primeiro boot)

> **Nota:** O plano Free do Render usa disco efêmero — o banco SQLite é recriado a cada deploy. A conta demo é re-semeada automaticamente via `SEED_DEMO=true`. Usuários reais devem fazer sync (push) após cada novo deploy para restaurar seus dados locais.

---

## 💻 Desenvolvimento Local

```bash
# 1. Server
cd server
npm install
npm run dev          # http://localhost:4000 (nodestyle --watch)

# 2. Client (terminal separado)
cd client
npm install
npm run dev          # http://localhost:5173 (Vite HMR)

# 3. Build produção local
cd client && npm run build
cd ../server && npm start   # serve client/dist + API
```

### Variáveis de Ambiente (`.env` na raiz do `server/`)
```env
NODE_ENV=development
PORT=4000
JWT_SECRET=seu-secret-super-seguro-aqui
JWT_TTL=7d
SEED_DEMO=true
```

---

## 🔌 API Reference

Base: `https://agrolote.onrender.com/api`

### Auth
| Método | Rota | Body | Resp |
|--------|------|------|------|
| `POST` | `/auth/register` | `{name, email, password}` | `{user, token}` |
| `POST` | `/auth/login` | `{email, password}` | `{user, token}` |

### CRUD (todas exigem `Authorization: Bearer <token>`)
| Entidade | Listar | Criar | Atualizar | Deletar |
|----------|--------|-------|-----------|---------|
| Lotes | `GET /lotes` | `POST /lotes` | `PUT /lotes/:id` | `DELETE /lotes/:id` |
| Plantios | `GET /plantios` | `POST /plantios` | `PUT /plantios/:id` | `DELETE /plantios/:id` |
| Insumos | `GET /insumos` | `POST /insumos` | `PUT /insumos/:id` | `DELETE /insumos/:id` |
| Gastos | `GET /gastos` | `POST /gastos` | `PUT /gastos/:id` | `DELETE /gastos/:id` |
| Colheitas | `GET /colheitas` | `POST /colheitas` | `PUT /colheitas/:id` | `DELETE /colheitas/:id` |

**Exemplo criar lote:**
```json
POST /api/lotes
{
  "nome": "Talhão 1",
  "tipo": "talhao",
  "area": 1500,
  "localizacao": "Setor A"
}
```

### Relatórios
| Rota | Descrição |
|------|-----------|
| `GET /reports/dashboard` | Contadores + custos/receitas 30d + próximas colheitas |
| `GET /reports/performance` | Agrupado por cultura: plantios, rendimento, receita, custo, lucro |

### Sync Offline-First
```http
POST /api/sync
Authorization: Bearer <token>
Content-Type: application/json

{
  "ops": [
    { "entity": "lotes", "action": "upsert", "data": { "id": "uuid-v4", "nome": "Novo", "tipo": "talhao" } },
    { "entity": "plantios", "action": "delete", "data": { "id": "uuid-existente" } }
  ],
  "clientLastSync": "2026-08-12T20:00:00.000Z"
}
```

**Resposta:**
```json
{
  "ok": true,
  "snapshot": { "lotes": [...], "plantios": [...], "insumos": [...], "gastos": [...], "colheitas": [...] },
  "serverTime": "2026-08-12T20:45:02.499Z"
}
```

- **Máx 100 ops** por request (400 se exceder)
- `action`: `"upsert"` (padrão) | `"delete"`
- IDs são **UUIDs v4 gerados no cliente** — sem conflito em sincronização multi-dispositivo
- `ensureUser()` recria o usuário no server se o banco foi limpo (disco efêmero) — token continua válido

### Health
```http
GET /api/health
→ { "ok": true, "name": "agrolote-api", "time": "..." }
```

---

## 📱 PWA — Instalação Offline

1. Acesse `https://agrolote.onrender.com` no celular/desktop
2. **Chrome/Edge**: menu ⋮ → "Instalar Agrolote"
3. **Safari iOS**: Compartilhar → "Adicionar à Tela de Início"
4. Funciona 100% offline — dados salvos no IndexedDB (Dexie)
5. Ao reconectar: botão "Sincronizar" envia ops + puxa snapshot completo

---

## 🔐 Variáveis de Produção (Render)

| Variável | Obrigatória? | Descrição |
|----------|--------------|-----------|
| `NODE_ENV` | Sim | `production` |
| `JWT_SECRET` | **Sim** | 64+ chars aleatórios (Render gera auto no Blueprint) |
| `JWT_TTL` | Não | Ex: `7d` (padrão) |
| `SEED_DEMO` | Não | `true` recria demo a cada boot (útil no free tier) |
| `PORT` | Não | Render injeta automaticamente |

> **Nunca** commite `.env` ou segredos. O `render.yaml` usa `generateValue: true` para `JWT_SECRET`.

---

## 🧪 Testes de Segurança (Manual)

```bash
# 1. Rate limit login (deve retornar 429 após ~8 tentativas)
for i in {1..15}; do curl -s -o /dev/null -w "%{http_code}\n" -X POST https://agrolote.onrender.com/api/auth/login -H "Content-Type: application/json" -d '{"email":"demo@agrolote.app","password":"wrong'$i'"}'; done

# 2. XSS no nome (deve retornar sanitizado)
curl -X POST https://agrolote.onrender.com/api/lotes -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"nome":"<script>alert(1)</script>","tipo":"talhao","area":100}'
curl -H "Authorization: Bearer $TOKEN" https://agrolote.onrender.com/api/lotes | grep script

# 3. JWT alg=none (deve 401)
curl -X POST https://agrolote.onrender.com/api/sync -H "Authorization: Bearer eyJhbGciOiJub25lIn0.eyJ1aWQiOjk5OTk5LCJlbWFpbCI6ImhheEB4LmNvbSJ9." -H "Content-Type: application/json" -d '{"ops":[]}'

# 4. Headers de segurança
curl -I https://agrolote.onrender.com/ | grep -iE "strict-transport|content-security|x-frame|x-content|referrer|coop|corp"

# 5. CORS bloqueado
curl -X OPTIONS https://agrolote.onrender.com/api/health -H "Origin: https://evil.com" -I
```

---

## 📦 Scripts Úteis

```bash
# Server
cd server
npm run dev      # watch mode
npm run start    # produção
npm run seed     # semear dados demo manualmente

# Client
cd client
npm run dev      # Vite dev server
npm run build    # build produção (client/dist)
npm run preview  # serve build local
npm run lint     # ESLint
```

---

## 🤝 Contribuindo

1. Fork → branch `feat/nova-funcionalidade`
2. Commits semânticos (`feat:`, `fix:`, `security:`, `docs:`)
3. PR com descrição + screenshots se UI
4. Testes manuais de segurança (ver seção acima)

---

## ⚠️ Limitações Conhecidas

| Limitação | Mitigação / Roadmap |
|-----------|---------------------|
| **Disco efêmero no Render Free** | Sync push/restore resolve; migração para PostgreSQL persistente no plano pago |
| **Single-node (sem HA)** | Arquitetura stateless + SQLite — escalável com volume persistente + Redis para rate-limit distribuído |
| **Sem MFA/2FA** | Roadmap: WebAuthn + TOTP |
| **Logs apenas stdout** | Roadmap: integração Loki/Grafana ou Datadog |

---

## 📄 Licença

MIT — use livremente, inclusive comercialmente. Veja `LICENSE`.

---

## 🙏 Agradecimentos

- **Render** — free tier generoso para projetos open-source
- **Node.js** — `node:sqlite` nativo eliminou `better-sqlite3` + build nativo
- **Dexie.js** — IndexedDB agradável
- **Zod** — validação TypeScript-first
- **Helmet** — headers de segurança em 3 linhas

---

**Deploy ativo:** https://agrolote.onrender.com  
**Demo:** `demo@agrolote.app` / `demo123`  
**Repo:** https://github.com/marcostuliodev/Sistema-de-Gest-o-de-Lotes-e-Safra