/**
 * Rotas de upgrade, checkout, webhook, licença e cancelamento.
 *
 * Fluxo:
 * 1. POST /checkout       → Cria sessão Stripe Checkout
 * 2. POST /portal         → Abre Stripe Customer Portal (cancelar/gerenciar)
 * 3. POST /webhook        → Recebe eventos do Stripe, atualiza assinatura
 * 4. POST /trial          → Inicia trial de um plano
 * 5. GET  /license        → Retorna licença assinada do usuário
 * 6. POST /verify         → Verifica licença (check periódico)
 * 7. POST /heartbeat      → Envia device time para check de relógio
 * 8. POST /integrity      → Envia relatório de integridade do dispositivo
 *
 * Cancelamento (Stripe Customer Portal):
 * - Usuário clica em "Cancelar assinatura" → POST /portal → URL do Stripe
 * - No Portal o usuário escolhe cancelar (fim do período ou imediato)
 * - Webhook customer.subscription.updated persiste cancel_at_period_end
 * - Webhook customer.subscription.deleted → deactivatePlan (downgrade free)
 * - Acesso é mantido até o fim do período pago; dados NÃO são apagados.
 */

import express, { Router } from "express";
import crypto from "node:crypto";
import Stripe from "stripe";
import { col, withMongoTransaction } from "../db.js";
import { authMiddleware } from "../auth.js";
import { projectMiddleware } from "../authz.js";
import { asyncHandler } from "../asyncHandler.js";
import { PLANS, PRICES, STRIPE_PRICE_IDS, TRIAL_DAYS, PAID_PLANS, getPlanFeatures, getSubscriptionPlan, isValidPlan, isProjectCollaborator, resolveEffectivePlan } from "../plans.js";
import { generateLicense, verifyLicense, getPublicKeyPem } from "../license.js";
import { checkClock } from "../clock-guard.js";
import { reportIntegrity } from "../integrity.js";
import { listAccessibleProjects, resolveUser } from "../authz.js";

const router = Router();
const CHECKOUT_LOCK_MS = 60 * 60 * 1000;
const IS_PROD = process.env.NODE_ENV === "production";
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const APP_URL = process.env.APP_URL || (IS_PROD ? "https://agrolote.marcostuliogc.com.br" : "http://localhost:5173");

function stripeEventRank(event) {
  const type = String(event?.type || "");
  const status = String(event?.data?.object?.status || "").toLowerCase();
  if (type === "customer.subscription.deleted" || ["canceled", "cancelled"].includes(status)) return 100;
  if (["unpaid", "incomplete_expired", "paused"].includes(status)) return 90;
  if (type === "invoice.payment_failed" || status === "past_due") return 80;
  if (type === "invoice.paid") return 95;
  if (type === "checkout.session.completed") return 70;
  return 50;
}

function stripeEventIsStale(row, created, rank) {
  if (!row || !created) return false;
  const currentCreated = Number(row.last_stripe_event_created || 0);
  if (currentCreated > Number(created)) return true;
  if (currentCreated === Number(created)) {
    return Number(row.last_stripe_event_rank || 0) > Number(rank || 0);
  }
  return false;
}

function stripeEventFilter(created, rank) {
  if (!created) return {};
  const numeric = Number(created);
  return {
    $or: [
      { last_stripe_event_created: { $exists: false } },
      { last_stripe_event_created: { $lt: numeric } },
      { last_stripe_event_created: numeric, last_stripe_event_rank: { $lte: Number(rank || 0) } },
      { last_stripe_event_created: numeric, last_stripe_event_rank: { $exists: false } },
    ],
  };
}

// Import estático: o bundler do Vercel garante que `stripe` entre na function.
// Dynamic import("stripe") não era resolvido → 500 no checkout/webhook.
function stripeClient() {
  if (!STRIPE_SECRET) return null;
  return new Stripe(STRIPE_SECRET);
}

async function checkoutSubscriptionIsPaid(session) {
  if (!session || session.status !== "complete") return false;
  if (!["paid", "no_payment_required"].includes(String(session.payment_status || ""))) return false;
  if (!session.subscription) return false;
  const stripe = stripeClient();
  if (!stripe) return false;
  const subscription = await stripe.subscriptions.retrieve(String(session.subscription));
  return ["active", "trialing"].includes(String(subscription.status || "").toLowerCase());
}

async function recordPendingSubscription(userId, session, eventCreated = 0, eventRank = 50) {
  if (!session?.subscription) return;
  const resolved = await resolveUser({ uid: userId });
  const canonicalId = billingId(resolved);
  const stripe = stripeClient();
  let remoteStatus = "incomplete";
  if (stripe) {
    try {
      remoteStatus = String((await stripe.subscriptions.retrieve(String(session.subscription))).status || remoteStatus);
    } catch {
      remoteStatus = "incomplete";
    }
  }
  const status = ["unpaid", "incomplete_expired", "paused"].includes(remoteStatus) ? remoteStatus : "incomplete";
  const subs = await col("subscriptions");
  const existing = await subs.findOne(subscriptionUserFilter(resolved));
  if (existing && isActiveSubscription(existing)) return;
  await subs.updateOne(
    existing ? { _id: existing._id } : { user_id: canonicalId },
    {
      $set: {
        plan: existing?.plan || "free",
        status,
        stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id,
        stripe_subscription_id: String(session.subscription),
        pending_plan: session.metadata?.plan || null,
         last_stripe_event_created: Number(eventCreated || 0),
         last_stripe_event_rank: Number(eventRank || 50),
         updated_at: new Date().toISOString(),
      },
    },
    { upsert: !existing },
  );
}

function isActiveSubscription(row) {
  if (!row) return false;
  const status = String(row.status || "").toLowerCase();
  if (["active", "trialing", "past_due"].includes(status)) return true;
  const end = row.current_period_end ? new Date(row.current_period_end).getTime() : 0;
  return Boolean(
    row.stripe_subscription_id &&
    end > Date.now() &&
    ["active", "trialing", "past_due"].includes(status),
  );
}

async function acquireCheckoutLock(userId, sessionId = null) {
  const locks = await col("stripe_checkout_locks");
  const expiresAt = new Date(Date.now() + CHECKOUT_LOCK_MS);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await locks.insertOne({
        _id: String(userId),
        user_id: String(userId),
        lock_token: sessionId ? String(sessionId) : null,
        session_id: null,
        expires_at: expiresAt,
        created_at: new Date(),
      });
      return true;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const current = await locks.findOne({ _id: String(userId) });
      if (current?.expires_at && new Date(current.expires_at).getTime() <= Date.now()) {
        await locks.deleteOne({ _id: current._id, expires_at: current.expires_at });
        continue;
      }
      if (sessionId && current?.lock_token && String(current.lock_token) !== String(sessionId)) return false;
      return false;
    }
  }
  return false;
}

async function releaseCheckoutLock(userId, sessionId = null) {
  const filter = { _id: String(userId) };
  if (sessionId) filter.lock_token = String(sessionId);
  await (await col("stripe_checkout_locks")).deleteOne(filter);
}

async function recordDuplicateSubscription(stripeSubscriptionId, userId) {
  if (!stripeSubscriptionId || !userId) return;
  await (await col("stripe_duplicate_actions")).updateOne(
    { stripe_subscription_id: String(stripeSubscriptionId) },
    { $setOnInsert: { stripe_subscription_id: String(stripeSubscriptionId), user_id: String(userId), status: "pending", created_at: new Date().toISOString() } },
    { upsert: true },
  );
}

async function retryDuplicateCancellations() {
  const stripe = stripeClient();
  if (!stripe) return;
  const actions = await (await col("stripe_duplicate_actions")).find({ status: "pending" }).limit(10).toArray();
  for (const action of actions) {
    try {
      await stripe.subscriptions.cancel(String(action.stripe_subscription_id));
      await (await col("stripe_duplicate_actions")).deleteOne({ _id: action._id });
    } catch (error) {
      console.error(`[upgrade] retry de cancelamento duplicado falhou (${action.stripe_subscription_id}):`, error.message);
    }
  }
}

function billingIdentityValues(user) {
  const values = [user?._id, user?.id, user?.user_key, user?.email]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .flatMap((value) => {
      const text = String(value);
      const variants = [value, text];
      if (/^\d+$/.test(text)) variants.push(Number(text));
      return variants;
    });
  const seen = new Set();
  return values.filter((value) => {
    const key = `${typeof value}:${String(value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function billingId(user) {
  return String(user?.user_key || user?.id || user?._id || user?.email);
}

function subscriptionUserFilter(user) {
  const clauses = billingIdentityValues(user).map((value) => ({ user_id: value }));
  return clauses.length > 0 ? { $or: clauses } : { $or: [{ user_id: "__invalid__" }] };
}

async function ownsAnyProject(user) {
  try {
    const projects = await listAccessibleProjects(user);
    return projects.some((entry) => entry.access?.isOwner === true);
  } catch {
    return false;
  }
}

/** VULN-018: bloqueia APENAS por relógio adulterado (bypass de licença).
 *  DevTools/UA não devem travar checkout de usuário legítimo. Fail-open. */
async function requireNotBlocked(req, res, next) {
  try {
    const scoreCol = await col("integrity_score");
    const row = await scoreCol.findOne({ user_id: req.user.uid });
    const reason = String(row?.block_reason || "");
    if (row?.blocked && (reason === "clock_rolled_back" || reason === "excessive_drift")) {
      return res.status(403).json({ error: "Acesso bloqueado" });
    }
  } catch {
    // DB indisponível não deve travar checkout/trial
  }
  next();
}

// ═══════════════════════════════════════════════════════════════════════
// GET /api/upgrade/plans — Lista planos públicos (não requer auth)
// ═══════════════════════════════════════════════════════════════════════
router.get("/plans", (_req, res) => {
  const plans = Object.entries(PLANS).map(([key, f]) => ({
    id: key,
    label: f.label,
    features: { ...f },
    price: PRICES[key]
      ? { monthly: PRICES[key].monthly, annual: PRICES[key].annual }
      : null,
  }));
  res.json({ plans, trialDays: TRIAL_DAYS });
});

// ═══════════════════════════════════════════════════════════════════════
// GET /api/upgrade/public-key — Chave pública para validação offline
// ═══════════════════════════════════════════════════════════════════════
router.get("/public-key", (_req, res) => {
  res.json({ publicKey: getPublicKeyPem() });
});

// ═══════════════════════════════════════════════════════════════════════
// POST /api/upgrade/checkout — Cria sessão Stripe Checkout
// ═══════════════════════════════════════════════════════════════════════
router.post("/checkout", authMiddleware, requireNotBlocked, asyncHandler(async (req, res) => {
  let checkoutLockHeld = false;
  let keepCheckoutLock = false;
  let billingKey = String(req.user.uid);
  const checkoutLockToken = crypto.randomUUID();
  try {
    const billingUser = await resolveUser(req.user);
    billingKey = billingId(billingUser);
    // Bloquear checkout para colaboradores
    const { col } = await import("../db.js");
    const collabsCol = await col("collaborators");
     const legacyCollab = await collabsCol.findOne({ $or: billingIdentityValues(billingUser).map((value) => ({ user_id: value })), status: "active" });
     const asCollab = !await ownsAnyProject(billingUser) && (legacyCollab || await isProjectCollaborator(billingKey));
    if (asCollab) {
      return res.status(403).json({ error: "Colaboradores nao podem gerenciar planos." });
    }

    if (!STRIPE_SECRET) {
      return res.status(503).json({ error: "Stripe nao configurado. Defina STRIPE_SECRET_KEY." });
    }

    const { plan, billing = "monthly" } = req.body || {};
    if (!isValidPlan(plan) || plan === "free") {
      return res.status(400).json({ error: "Plano invalido" });
    }
    if (billing !== "monthly" && billing !== "annual") {
      return res.status(400).json({ error: "Ciclo de cobranca invalido" });
    }

    const priceKey = `${plan}_${billing}`;
    const priceId = STRIPE_PRICE_IDS[priceKey];
    if (!priceId) {
      return res.status(400).json({ error: `Price ID nao configurado para ${priceKey}. Crie o produto/price no Stripe e defina a env var.` });
    }

    checkoutLockHeld = await acquireCheckoutLock(billingKey, checkoutLockToken);
    if (!checkoutLockHeld) {
      return res.status(409).json({ error: "Ja existe uma criacao de checkout em andamento. Tente novamente em alguns minutos." });
    }

    // Busca ou cria customer. O lock e unico por usuario e impede que
    // duas sessoes de checkout sejam abertas simultaneamente.
    const subs = await col("subscriptions");
    const sub = await subs.findOne(subscriptionUserFilter(billingUser));
    let customerId = sub?.stripe_customer_id;
    const stripe = stripeClient();

    if (isActiveSubscription(sub)) {
      return res.status(409).json({ error: "Voce ja possui uma assinatura ativa. Use o portal para gerenciar o plano." });
    }

    if (customerId) {
      const remoteSubscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
      });
      const remoteActive = remoteSubscriptions.data.find((item) => isActiveSubscription({
        status: item.status,
        stripe_subscription_id: item.id,
        current_period_end: item.current_period_end,
      }));
      if (remoteActive) {
        return res.status(409).json({ error: "Ja existe uma assinatura ativa no Stripe. Use o portal para gerenciar o plano." });
      }
    }

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: { userId: billingKey },
      });
      customerId = customer.id;
      await subs.updateOne(
        sub ? { _id: sub._id } : { user_id: billingKey },
        { $set: { stripe_customer_id: customerId } },
        { upsert: !sub }
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/upgrade?success=1`,
      cancel_url: `${APP_URL}/upgrade?cancelled=1`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      metadata: { userId: billingKey, plan, billing, lockToken: checkoutLockToken },
      subscription_data: {
        metadata: { userId: billingKey, plan, lockToken: checkoutLockToken },
      },
    });

    await (await col("stripe_checkout_locks")).updateOne(
      { _id: billingKey, lock_token: checkoutLockToken },
      { $set: { session_id: session.id, updated_at: new Date().toISOString() } },
    );
    // Mantem o lock ate o webhook ou o prazo de 10 minutos, para impedir
    // checkout duplicado caso o usuario clique novamente rapidamente.
    keepCheckoutLock = true;
    res.json({ url: session.url, sessionId: session.id });
  } catch (e) {
    console.error("[checkout] Erro:", e.message);
    // Em prod não vaza e.message (pode conter detalhes internos do Stripe/infra)
    res.status(500).json({ error: IS_PROD ? "Erro ao criar checkout" : (e.message || "Erro ao criar checkout") });
  } finally {
    if (checkoutLockHeld && !keepCheckoutLock) await releaseCheckoutLock(billingKey, checkoutLockToken);
  }
}));

// ═══════════════════════════════════════════════════════════════════════
// POST /api/upgrade/portal — Stripe Customer Portal (cancelar/gerenciar)
// ═══════════════════════════════════════════════════════════════════════
// O Portal do Stripe cuida da UI de cancelamento (fim do período ou
// imediato), troca de cartão e reativação. O webhook já trata o efeito.
router.post("/portal", authMiddleware, requireNotBlocked, asyncHandler(async (req, res) => {
  try {
    const billingUser = await resolveUser(req.user);
    const billingKey = billingId(billingUser);
    // Bloquear para colaboradores (não gerenciam plano)
    const { col } = await import("../db.js");
     const collabsCol = await col("collaborators");
     const legacyCollab = await collabsCol.findOne({ $or: billingIdentityValues(billingUser).map((value) => ({ user_id: value })), status: "active" });
     const asCollab = !await ownsAnyProject(billingUser) && (legacyCollab || await isProjectCollaborator(billingKey));
     if (asCollab) {
       return res.status(403).json({ error: "Colaboradores nao podem gerenciar planos." });
     }

     if (!STRIPE_SECRET) {
       return res.status(503).json({ error: "Stripe nao configurado. Defina STRIPE_SECRET_KEY." });
     }

     const subs = await col("subscriptions");
     const sub = await subs.findOne(subscriptionUserFilter(billingUser));
    const customerId = sub?.stripe_customer_id;

    if (!customerId) {
      return res.status(400).json({ error: "Nenhuma assinatura encontrada para gerenciar." });
    }

    // Portal do Stripe: cancelar (fim/imediato), reativar, trocar cartão.
    // Só bloqueia free puro SEM customer Stripe (nunca assinou).
    const stripe = stripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${APP_URL}/upgrade?portal=1`,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("[portal] Erro:", e.message);
    res.status(500).json({ error: IS_PROD ? "Erro ao abrir portal de assinatura" : (e.message || "Erro ao abrir portal") });
  }
}));

// ═══════════════════════════════════════════════════════════════════════
// POST /api/upgrade/webhook — Recebe eventos do Stripe
// ═══════════════════════════════════════════════════════════════════════
// NOTA: Este endpoint NÃO usa authMiddleware — o Stripe valida o signature.
router.post("/webhook", expressRawBody(), asyncHandler(async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET || !STRIPE_SECRET) {
    return res.status(503).json({ error: "Webhook não configurado" });
  }

  const stripe = stripeClient();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[webhook] Signature inválida:", err.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  // VULN-020: idempotência — Stripe pode reentregar o mesmo evento.
  // event.id é único; se já processado, ACK com 200 sem reprocessar.
  try {
    const eventsCol = await col("stripe_events");
    const prior = await eventsCol.findOne({ event_id: event.id });
    if (prior) {
      return res.json({ received: true, duplicate: true });
    }
  } catch (e) {
    // Se a checagem falhar (DB), segue o processamento — melhor arriscar
    // reprocessar do que perder um pagamento legítimo.
    console.error("[webhook] Falha ao checar idempotência:", e.message);
  }

  try {
    await retryDuplicateCancellations();
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        // IDs mistos: Date.now() (números) e uuid (strings). Number(uuid) = NaN
        // faria a ativação do plano ser SEMPRE ignorada para usuários novos.
        const rawUserId = String(session.metadata?.userId || "");
        const userId = /^\d+$/.test(rawUserId) ? Number(rawUserId) : rawUserId;
        const plan = session.metadata?.plan || "basico";
         const billing = session.metadata?.billing || "monthly";
         if (userId && isValidPlan(plan)) {
           if (await checkoutSubscriptionIsPaid(session)) {
             await activatePlan(userId, plan, billing, session.subscription, event.created, stripeEventRank(event), String(session.metadata?.lockToken || ""));
           } else {
             await recordPendingSubscription(userId, session, event.created, stripeEventRank(event));
           }
         }
        break;
      }
       case "checkout.session.expired": {
         const expiredSession = event.data.object;
         const rawOwner = String(expiredSession.metadata?.userId || "");
         const lockToken = String(expiredSession.metadata?.lockToken || "");
         if (rawOwner && lockToken) {
           try {
             const owner = await resolveUser({ uid: rawOwner });
             await releaseCheckoutLock(billingId(owner), lockToken);
           } catch (error) {
             console.error("[webhook]Falha ao liberar checkout expirado:", error.message);
           }
         }
         break;
       }
       case "invoice.paid": {
        // Renovação — usa o período do próprio Stripe quando disponível
        // (não soma +1 mês cegamente; dedup por event.id acima).
        const invoice = event.data.object;
        const subId =
          invoice.subscription ||
          invoice.parent?.subscription_details?.subscription ||
          null;
         if (subId) {
           const stripe = stripeClient();
           if (stripe) {
             const subscription = await stripe.subscriptions.retrieve(String(subId));
             const rawUserId = String(subscription.metadata?.userId || "");
             const userId = /^\d+$/.test(rawUserId) ? Number(rawUserId) : rawUserId;
             const plan = subscription.metadata?.plan;
             const billing = sessionBilling(subscription);
             if (userId && isValidPlan(plan) && ["active", "trialing"].includes(String(subscription.status || "").toLowerCase())) {
                 await activatePlan(userId, plan, billing, String(subId), event.created, stripeEventRank(event));
             }
           }
           await renewSubscription(subId, invoicePeriodEnd(invoice), event.created, stripeEventRank(event));
         }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
          await deactivatePlan(sub.id, event.created, stripeEventRank(event));
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object;
        if (sub.status === "canceled" || sub.status === "cancelled") {
          await deactivatePlan(sub.id, event.created, stripeEventRank(event));
          break;
        }
        // Persiste estado de cancelamento agendado e status para a UI.
        // Stripe envia status: active + cancel_at_period_end:true quando o
        // usuário cancelou no Portal mas o período ainda não acabou.
         const subs = await col("subscriptions");
         const current = await subs.findOne({ stripe_subscription_id: sub.id });
          if (stripeEventIsStale(current, event.created, stripeEventRank(event))) break;
         const periodEnd =
           sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : undefined;
        const set = {
           cancel_at_period_end: !!sub.cancel_at_period_end,
           canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
            last_stripe_event_created: event.created,
            last_stripe_event_rank: stripeEventRank(event),
            updated_at: new Date().toISOString(),
        };
        // Mapeia status Stripe → status interno (mantém active em cancel_at_period_end)
         if (sub.status === "active" || sub.status === "trialing") {
           set.status = "active";
           if (current?.pending_plan && isValidPlan(current.pending_plan)) {
             set.plan = current.pending_plan;
             set.pending_plan = null;
           }
        } else if (sub.status === "canceled") {
          // O evento deleted logo abaixo faz deactivatePlan; aqui só marca.
          set.status = "cancelled";
         } else if (["past_due", "unpaid", "incomplete", "incomplete_expired", "paused"].includes(sub.status)) {
           set.status = sub.status; // estados sem entitlement são tratados como free
         }
        if (periodEnd) set.current_period_end = periodEnd;

        try {
           const updated = await subs.updateOne(
             {
               stripe_subscription_id: sub.id,
                  ...stripeEventFilter(event.created, stripeEventRank(event)),
             },
             { $set: set }
           );
           if (updated.matchedCount === 0) {
             console.warn(`[webhook] Evento Stripe ignorado por ordem: ${sub.id}`);
           }
         } catch (e) {
           console.error("[webhook] Falha ao persistir subscription.updated:", e.message);
           throw e;
         }
        if (sub.status === "past_due" || sub.status === "unpaid") {
          console.warn(`[webhook] Assinatura ${sub.id} com status ${sub.status}`);
        }
        break;
      }
      case "invoice.payment_failed": {
        // Falha de cobrança (cartão recusado etc) — marca past_due para UI.
        const invoice = event.data.object;
        const subId =
          invoice.subscription ||
          invoice.parent?.subscription_details?.subscription ||
          null;
        if (subId) {
          try {
             const subs = await col("subscriptions");
            await subs.updateOne(
                {
                  stripe_subscription_id: subId,
                  status: { $ne: "unpaid" },
               ...stripeEventFilter(event.created, stripeEventRank(event)),
                },
                { $set: { status: "past_due", payment_failed_at: new Date().toISOString(), last_stripe_event_created: Number(event.created || 0), last_stripe_event_rank: stripeEventRank(event), updated_at: new Date().toISOString() } }
            );
           } catch (e) {
             console.error("[webhook] Falha ao marcar past_due:", e.message);
             throw e;
           }
          console.warn(`[webhook] Pagamento falhou para assinatura ${subId}`);
        }
        break;
      }
    }
   } catch (err) {
     console.error(`[webhook] Erro ao processar ${event.type}:`, err.message);
     return res.status(500).json({ error: "Webhook processing failed" });
   }

   // Registra o event.id somente depois que o entitlement foi persistido.
  try {
    const eventsCol = await col("stripe_events");
    await eventsCol.updateOne(
      { event_id: event.id },
      { $setOnInsert: { event_id: event.id, type: event.type, processed_at: new Date().toISOString() } },
      { upsert: true }
    );
   } catch (e) {
     console.error("[webhook] Falha ao registrar event.id:", e.message);
     return res.status(500).json({ error: "Webhook persistence failed" });
   }

   res.json({ received: true });
}));

function sessionBilling(subscription) {
  const interval = subscription?.items?.data?.[0]?.price?.recurring?.interval;
  return interval === "year" ? "annual" : "monthly";
}

/** Extrai o fim de período do invoice do Stripe (epoch seconds → Date). */
function invoicePeriodEnd(invoice) {
  const line = invoice?.lines?.data?.[0];
  if (line?.period?.end) return new Date(line.period.end * 1000);
  if (invoice?.period_end) return new Date(invoice.period_end * 1000);
  return null;
}

// Helper para raw body (Stripe webhook precisa do body bruto)
function expressRawBody() {
  return express.raw({ type: "application/json", limit: "1mb" });
}

// ═══════════════════════════════════════════════════════════════════════
// POST /api/upgrade/trial — Inicia trial de um plano
// ═══════════════════════════════════════════════════════════════════════
router.post("/trial", authMiddleware, requireNotBlocked, asyncHandler(async (req, res) => {
  try {
    const billingUser = await resolveUser(req.user);
    const billingKey = billingId(billingUser);
    // Bloquear trial para colaboradores
    const { col } = await import("../db.js");
     const collabsCol = await col("collaborators");
      const legacyCollab = await collabsCol.findOne({ $or: billingIdentityValues(billingUser).map((value) => ({ user_id: value })), status: "active" });
      const asCollab = !await ownsAnyProject(billingUser) && (legacyCollab || await isProjectCollaborator(billingKey));
     if (asCollab) {
      return res.status(403).json({ error: "Colaboradores nao podem gerenciar planos." });
    }

    const { plan } = req.body || {};
    if (!isValidPlan(plan) || plan === "free") {
      return res.status(400).json({ error: "Plano invalido" });
    }

    const subs = await col("subscriptions");
     const existing = await subs.findOne(subscriptionUserFilter(billingUser));

     // Ja tem trial ou assinatura ativa/pendente. Não permitir que um unpaid
     // seja convertido em trial e volte a conceder plano pago.
     if (existing && ["active", "past_due", "unpaid", "incomplete", "incomplete_expired", "paused"].includes(String(existing.status || "").toLowerCase())) {
       return res.status(400).json({ error: "Voce ja possui uma assinatura ativa ou pendente." });
     }
    // Trial só UMA vez por conta (enquanto ativo devolve o mesmo; expirado
    // bloqueia novo trial — antes era possível reiniciar infinitamente).
    if (existing && existing.trial_started_at) {
      const started = new Date(existing.trial_started_at);
      const daysSince = (Date.now() - started.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < TRIAL_DAYS) {
        if (existing.trial_plan === plan) {
          const trialEnd = new Date(started.getTime() + TRIAL_DAYS * 86400000);
          let license = null;
           try { license = generateLicense(billingKey, plan, null, trialEnd); } catch (e) { console.error("[trial] generateLicense error:", e.message); }
          return res.json({ plan, trialEnd: trialEnd.toISOString(), license });
        }
        return res.status(400).json({ error: "Voce ja esta testando o plano " + (PLANS[existing.trial_plan]?.label || existing.trial_plan) + "." });
      }
      return res.status(400).json({ error: "Voce ja utilizou o periodo de teste." });
    }

    const trialEnd = new Date(Date.now() + TRIAL_DAYS * 86400000);

     await subs.updateOne(
       existing ? { _id: existing._id } : { user_id: billingKey },
       {
         $set: {
           plan: "free",
           status: "trial",
          trial_started_at: new Date().toISOString(),
          trial_plan: plan,
          current_period_start: new Date().toISOString(),
          current_period_end: trialEnd.toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
       { upsert: !existing }
     );

     let license = null;
     try {
       license = generateLicense(billingKey, plan, null, trialEnd);
    } catch (e) {
      console.error("[trial] generateLicense error:", e.message);
    }

    res.json({ plan, trialEnd: trialEnd.toISOString(), license });
  } catch (e) {
    console.error("[trial] Erro:", e.message, e.stack);
    res.status(500).json({ error: IS_PROD ? "Erro interno no trial" : (e.message || "Erro interno no trial") });
  }
}));

// ═══════════════════════════════════════════════════════════════════════
// GET /api/upgrade/license — Retorna licença assinada do usuário
// ═══════════════════════════════════════════════════════════════════════
router.get("/license", authMiddleware, projectMiddleware, asyncHandler(async (req, res) => {
  try {
    const requestUser = await resolveUser(req.user);
    const requestId = billingId(requestUser);
    // Plano efetivo do projeto selecionado; o servidor resolve o owner.
    const { plan, isCollaborator, owner_id, role } = await resolveEffectivePlan(requestId, req.projectId);

    const subs = await col("subscriptions");
     const lookupId = owner_id || requestId;
    const ownerDoc = await (await col("users")).findOne({
      $or: [
        { user_key: lookupId },
        { _id: lookupId },
        { id: lookupId },
        { email: lookupId },
      ],
    });
    const ownerValues = [lookupId, String(lookupId), ownerDoc?._id, ownerDoc?.id, ownerDoc?.user_key, ownerDoc?.email]
      .filter((value) => value !== undefined && value !== null);
    const sub = await subs.findOne({ $or: ownerValues.map((value) => ({ user_id: value })) });

    if (!sub || (sub.plan === "free" && sub.status !== "trial")) {
      return res.json({
        plan: "free",
        features: getPlanFeatures("free"),
        license: null,
        status: "free",
        isCollaborator,
        owner_id,
        role,
      });
    }

    let activePlan = plan;
    let license = null;

    if (sub.status === "trial" && sub.trial_started_at) {
      const trialEnd = new Date(sub.trial_started_at);
      trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);

      if (new Date() > trialEnd) {
        if (!isCollaborator) {
          await subs.updateOne(
             { _id: sub._id },
            { $set: { status: "expired", plan: "free", updated_at: new Date().toISOString() } }
          );
        }
        activePlan = "free";
      } else {
         activePlan = getSubscriptionPlan(sub);
        try {
           license = generateLicense(requestId, activePlan, null, trialEnd);
        } catch (e) {
          console.error("[license] generateLicense error:", e.message);
        }
      }
    } else if ((sub.status === "active" || sub.status === "past_due") && sub.plan !== "free") {
      // past_due mantém acesso até o Stripe cancelar (deleted → deactivatePlan)
      try {
         license = generateLicense(requestId, activePlan, sub.stripe_subscription_id);
      } catch (e) {
        console.error("[license] generateLicense error:", e.message);
      }
    }

    res.json({
      plan: activePlan,
      features: getPlanFeatures(activePlan),
      license,
      status: sub.status,
      trialEnd: sub.status === "trial" && sub.trial_started_at
        ? new Date(new Date(sub.trial_started_at).getTime() + TRIAL_DAYS * 86400000).toISOString()
        : null,
      // Estado de cancelamento (para UI: banner "cancelada em XX")
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      currentPeriodEnd: sub.current_period_end || null,
      canceledAt: sub.canceled_at || null,
      isCollaborator,
      owner_id,
      role,
    });
  } catch (e) {
    console.error("[license] Erro:", e.message);
    res.status(500).json({ error: IS_PROD ? "Erro interno" : e.message });
  }
}));

// ═══════════════════════════════════════════════════════════════════════
// POST /api/upgrade/verify — Verificação periódica da licença
// ═══════════════════════════════════════════════════════════════════════
router.post("/verify", authMiddleware, asyncHandler(async (req, res) => {
  const { license: signedLicense } = req.body || {};
  if (typeof signedLicense !== "string" || !signedLicense) {
    return res.json({ valid: false, plan: "free", features: getPlanFeatures("free") });
  }

  const user = await resolveUser(req.user);
  const result = verifyLicense(signedLicense, billingId(user));
  res.json(result);
}));

// ═══════════════════════════════════════════════════════════════════════
// POST /api/upgrade/heartbeat — Check de relógio
// ═══════════════════════════════════════════════════════════════════════
router.post("/heartbeat", authMiddleware, asyncHandler(async (req, res) => {
  const { deviceTime } = req.body || {};
  if (typeof deviceTime !== "string" || !deviceTime) {
    return res.status(400).json({ error: "deviceTime obrigatório" });
  }

  const result = await checkClock(req.user.uid, deviceTime);
  res.json(result);
}));

// ═══════════════════════════════════════════════════════════════════════
// POST /api/upgrade/integrity — Relatório de integridade
// ═══════════════════════════════════════════════════════════════════════
router.post("/integrity", authMiddleware, asyncHandler(async (req, res) => {
  const { signals } = req.body || {};
  if (!Array.isArray(signals)) {
    return res.status(400).json({ error: "signals deve ser um array" });
  }

  let finalScore = { score: 100, blocked: false };
  for (const s of signals) {
    if (!s || typeof s !== "object") continue;
    const signal = typeof s.signal === "string" ? s.signal.slice(0, 100) : "unknown";
    const severity = ["low", "medium", "high", "critical"].includes(s.severity) ? s.severity : "low";
    const detail = typeof s.detail === "string" ? s.detail.slice(0, 500) : null;
    finalScore = await reportIntegrity(req.user.uid, signal, severity, detail);
    if (finalScore.blocked) break;
  }

  res.json(finalScore);
}));

// ═══════════════════════════════════════════════════════════════════════
// Helpers internos
// ═══════════════════════════════════════════════════════════════════════

async function activatePlan(userId, plan, billing, stripeSubId, eventCreated = 0, eventRank = 50, lockToken = "") {
  const resolvedUser = await resolveUser({ uid: userId });
  const canonicalId = billingId(resolvedUser);
  const now = new Date();
  const periodEnd = new Date(now);
  if (billing === "annual") {
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  let duplicateSubscription = false;
   const activated = await withMongoTransaction(async (session) => {
     const subs = await col("subscriptions");
     const existing = await subs.findOne(subscriptionUserFilter(resolvedUser), { session });
      if (stripeEventIsStale(existing, eventCreated, eventRank)) return false;
     if (stripeSubId) {
       const cancelled = await (await col("stripe_cancelled_subscriptions")).findOne(
         { stripe_subscription_id: String(stripeSubId) },
         { session },
       );
       const sameSubscription = String(existing?.stripe_subscription_id || "") === String(stripeSubId);
       const cancelledStatus = ["cancelled", "canceled"].includes(String(existing?.status || "").toLowerCase());
       const differentActiveSubscription = existing && !sameSubscription && existing.stripe_subscription_id && isActiveSubscription(existing);
       if (cancelled || differentActiveSubscription || (sameSubscription && cancelledStatus)) {
         duplicateSubscription = differentActiveSubscription;
         return false;
       }
    }
    await subs.updateOne(
       existing ? { _id: existing._id } : { user_id: canonicalId },
      {
        $set: {
          plan,
          status: "active",
          stripe_subscription_id: stripeSubId,
          billing,
          current_period_start: now.toISOString(),
          current_period_end: periodEnd.toISOString(),
          trial_plan: null,
          cancel_at_period_end: false,
          canceled_at: null,
           payment_failed_at: null,
           ...(eventCreated ? { last_stripe_event_created: Number(eventCreated), last_stripe_event_rank: Number(eventRank || 50) } : {}),
           updated_at: now.toISOString(),
        },
      },
      { upsert: true, session },
     );
      if (lockToken) {
        await (await col("stripe_checkout_locks")).deleteOne({ _id: canonicalId, lock_token: String(lockToken) }, { session });
      }
     return true;
   });
   if (!activated && duplicateSubscription && stripeSubId) {
     await recordDuplicateSubscription(stripeSubId, canonicalId);
     try {
       const stripe = stripeClient();
       if (stripe) {
         await stripe.subscriptions.cancel(String(stripeSubId));
         await (await col("stripe_duplicate_actions")).deleteOne({ stripe_subscription_id: String(stripeSubId) });
       }
     } catch (error) {
       console.error(`[upgrade] Falha ao cancelar assinatura duplicada ${stripeSubId}:`, error.message);
     }
   }
   if (!activated) {
    console.warn(`[upgrade] Ignorando reativação fora de ordem da assinatura ${stripeSubId}`);
    return;
  }

  console.log(`[upgrade] Plano ${plan} ativado para user ${userId}`);
}

async function renewSubscription(stripeSubId, stripePeriodEnd = null, eventCreated = 0, eventRank = 50) {
  const subs = await col("subscriptions");
  const row = await subs.findOne({ stripe_subscription_id: stripeSubId });
  if (!row) return;

  let newEnd;
  if (stripePeriodEnd instanceof Date && !isNaN(stripePeriodEnd.getTime())) {
    // Periode vindo do Stripe (fonte autoritativa) — não soma +1 cegamente.
    newEnd = stripePeriodEnd;
    const currentEnd = row.current_period_end ? new Date(row.current_period_end) : null;
    // Nunca encurtar o período já concedido (ex.: reentrega atrasada).
    if (currentEnd && !isNaN(currentEnd.getTime()) && newEnd.getTime() < currentEnd.getTime()) {
      newEnd = currentEnd;
    }
  } else {
    // Fallback legado: estende a partir do período atual.
    newEnd = new Date(row.current_period_end || new Date());
    if (row.billing === "annual") {
      newEnd.setFullYear(newEnd.getFullYear() + 1);
    } else {
      newEnd.setMonth(newEnd.getMonth() + 1);
    }
  }

   await subs.updateOne(
     {
       stripe_subscription_id: stripeSubId,
       ...(eventCreated ? stripeEventFilter(eventCreated, eventRank) : {}),
     },
     {
       $set: {
         current_period_end: newEnd.toISOString(),
         ...(eventCreated ? { last_stripe_event_created: Number(eventCreated), last_stripe_event_rank: Number(eventRank || 50) } : {}),
         updated_at: new Date().toISOString(),
       },
     }
   );
}

async function deactivatePlan(stripeSubId, eventCreated = 0, eventRank = 100) {
  const cancelledAt = new Date().toISOString();
  await withMongoTransaction(async (session) => {
    const cancelledCol = await col("stripe_cancelled_subscriptions");
    await cancelledCol.updateOne(
      { stripe_subscription_id: String(stripeSubId) },
      { $setOnInsert: { stripe_subscription_id: String(stripeSubId), cancelled_at: cancelledAt, created_at: cancelledAt } },
      { upsert: true, session },
    );
     const subs = await col("subscriptions");
     const current = await subs.findOne({ stripe_subscription_id: stripeSubId }, { session });
     if (stripeEventIsStale(current, eventCreated, eventRank)) return;
     await subs.updateOne(
       { stripe_subscription_id: stripeSubId, ...(eventCreated ? stripeEventFilter(eventCreated, eventRank) : {}) },
       {
         $set: {
           ...(eventCreated || current?.last_stripe_event_created ? { last_stripe_event_created: eventCreated || current.last_stripe_event_created, last_stripe_event_rank: Number(eventRank || current?.last_stripe_event_rank || 100) } : {}),
           plan: "free",
          status: "cancelled",
          stripe_subscription_id: null,
          cancel_at_period_end: false,
          canceled_at: cancelledAt,
          updated_at: cancelledAt,
        },
      },
      { session },
    );
  });
  console.log(`[upgrade] Assinatura ${stripeSubId} cancelada → plano free`);
}

export default router;
