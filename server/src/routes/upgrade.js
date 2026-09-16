/**
 * Rotas de upgrade, checkout, webhook e licença.
 *
 * Fluxo:
 * 1. POST /checkout       → Cria sessão Stripe Checkout
 * 2. POST /webhook         → Recebe eventos do Stripe, atualiza assinatura
 * 3. POST /trial           → Inicia trial de um plano
 * 4. GET  /license         → Retorna licença assinada do usuário
 * 5. POST /verify          → Verifica licença (check periódico)
 * 6. POST /heartbeat       → Envia device time para check de relógio
 * 7. POST /integrity       → Envia relatório de integridade do dispositivo
 */

import express, { Router } from "express";
import crypto from "node:crypto";
import { db } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { PLANS, PRICES, STRIPE_PRICE_IDS, TRIAL_DAYS, PAID_PLANS, getPlanFeatures, isValidPlan } from "../plans.js";
import { generateLicense, verifyLicense, getPublicKeyPem } from "../license.js";
import { checkClock } from "../clock-guard.js";
import { reportIntegrity, isUserBlocked } from "../integrity.js";

const router = Router();
const IS_PROD = process.env.NODE_ENV === "production";
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const APP_URL = process.env.APP_URL || (IS_PROD ? "https://agrolote.onrender.com" : "http://localhost:5173");

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
router.post("/checkout", authMiddleware, asyncHandler(async (req, res) => {
  if (!STRIPE_SECRET) {
    return res.status(503).json({ error: "Stripe não configurado. Defina STRIPE_SECRET_KEY." });
  }

  const { plan, billing = "monthly" } = req.body || {};
  if (!isValidPlan(plan) || plan === "free") {
    return res.status(400).json({ error: "Plano inválido" });
  }
  if (billing !== "monthly" && billing !== "annual") {
    return res.status(400).json({ error: "Ciclo de cobrança inválido" });
  }

  const priceKey = `${plan}_${billing}`;
  const priceId = STRIPE_PRICE_IDS[priceKey];
  if (!priceId) {
    return res.status(400).json({ error: `Price ID não configurado para ${priceKey}. Crie o produto/price no Stripe e defina a env var.` });
  }

  // Busca ou cria customer
  const sub = await db.prepare("SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?").get(req.user.uid);
  let customerId = sub?.stripe_customer_id;

  if (!customerId) {
    const stripe = (await import("stripe")).default(STRIPE_SECRET);
    const customer = await stripe.customers.create({
      email: req.user.email,
      metadata: { userId: String(req.user.uid) },
    });
    customerId = customer.id;
    await db.prepare(
      `INSERT INTO subscriptions (user_id, stripe_customer_id)
       VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`
    ).run(req.user.uid, customerId);
  }

  const stripe = (await import("stripe")).default(STRIPE_SECRET);
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${APP_URL}/upgrade?success=1`,
    cancel_url: `${APP_URL}/upgrade?cancelled=1`,
    metadata: { userId: String(req.user.uid), plan, billing },
    subscription_data: {
      metadata: { userId: String(req.user.uid), plan },
    },
  });

  res.json({ url: session.url, sessionId: session.id });
}));

// ═══════════════════════════════════════════════════════════════════════
// POST /api/upgrade/webhook — Recebe eventos do Stripe
// ═══════════════════════════════════════════════════════════════════════
// NOTA: Este endpoint NÃO usa authMiddleware — o Stripe valida o signature.
router.post("/webhook", expressRawBody(), asyncHandler(async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET || !STRIPE_SECRET) {
    return res.status(503).json({ error: "Webhook não configurado" });
  }

  const stripe = (await import("stripe")).default(STRIPE_SECRET);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[webhook] Signature inválida:", err.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = Number(session.metadata?.userId);
        const plan = session.metadata?.plan || "basico";
        const billing = session.metadata?.billing || "monthly";
        if (userId && isValidPlan(plan)) {
          await activatePlan(userId, plan, billing, session.subscription);
        }
        break;
      }
      case "invoice.paid": {
        // Renovação — estende o período
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          await renewSubscription(subId);
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await deactivatePlan(sub.id);
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object;
        if (sub.status === "past_due" || sub.status === "unpaid") {
          // Ainda mantém acesso, mas marca aviso
          console.warn(`[webhook] Assinatura ${sub.id} com status ${sub.status}`);
        }
        break;
      }
    }
  } catch (err) {
    console.error(`[webhook] Erro ao processar ${event.type}:`, err.message);
  }

  res.json({ received: true });
}));

// Helper para raw body (Stripe webhook precisa do body bruto)
function expressRawBody() {
  return express.raw({ type: "application/json", limit: "1mb" });
}

// ═══════════════════════════════════════════════════════════════════════
// POST /api/upgrade/trial — Inicia trial de um plano
// ═══════════════════════════════════════════════════════════════════════
router.post("/trial", authMiddleware, asyncHandler(async (req, res) => {
  const { plan } = req.body || {};
  if (!isValidPlan(plan) || plan === "free") {
    return res.status(400).json({ error: "Plano inválido" });
  }

  const existing = await db.prepare(
    "SELECT plan, status, trial_started_at FROM subscriptions WHERE user_id = ?"
  ).get(req.user.uid);

  // Já tem trial ou assinatura ativa
  if (existing && existing.status === "active" && existing.plan !== "free") {
    return res.status(400).json({ error: "Você já possui um plano ativo." });
  }
  if (existing && existing.status === "trial" && existing.trial_started_at) {
    const started = new Date(existing.trial_started_at);
    const daysSince = (Date.now() - started.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < TRIAL_DAYS && existing.trial_plan === plan) {
      // Já está em trial deste plano — retorna licença atual
      const license = generateLicense(req.user.uid, plan, null, new Date(started.getTime() + TRIAL_DAYS * 86400000));
      return res.json({ plan, trialEnd: new Date(started.getTime() + TRIAL_DAYS * 86400000).toISOString(), license });
    }
    if (daysSince < TRIAL_DAYS) {
      return res.status(400).json({ error: `Você já está testando o plano ${PLANS[existing.trial_plan]?.label || existing.trial_plan}.` });
    }
  }

  const trialEnd = new Date(Date.now() + TRIAL_DAYS * 86400000);

  await db.prepare(
    `INSERT INTO subscriptions (user_id, plan, status, trial_started_at, trial_plan, current_period_start, current_period_end, updated_at)
     VALUES (?, 'free', 'trial', now()::text, ?, now()::text, ?, now()::text)
     ON CONFLICT (user_id) DO UPDATE SET
       status = 'trial',
       trial_started_at = now()::text,
       trial_plan = EXCLUDED.trial_plan,
       current_period_start = now()::text,
       current_period_end = EXCLUDED.current_period_end,
       updated_at = now()::text`
  ).run(req.user.uid, plan, trialEnd.toISOString());

  const license = generateLicense(req.user.uid, plan, null, trialEnd);
  res.json({ plan, trialEnd: trialEnd.toISOString(), license });
}));

// ═══════════════════════════════════════════════════════════════════════
// GET /api/upgrade/license — Retorna licença assinada do usuário
// ═══════════════════════════════════════════════════════════════════════
router.get("/license", authMiddleware, asyncHandler(async (req, res) => {
  const sub = await db.prepare(
    "SELECT plan, status, trial_plan, trial_started_at, stripe_subscription_id, current_period_end FROM subscriptions WHERE user_id = ?"
  ).get(req.user.uid);

  if (!sub || (sub.plan === "free" && sub.status !== "trial")) {
    // Sem assinatura — retorna plano free sem licença assinada
    return res.json({ plan: "free", features: getPlanFeatures("free"), license: null });
  }

  let activePlan = sub.plan;
  let license = null;

  if (sub.status === "trial" && sub.trial_started_at) {
    const trialEnd = new Date(sub.trial_started_at);
    trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);

    if (new Date() > trialEnd) {
      // Trial expirou — volta para free
      await db.prepare(
        "UPDATE subscriptions SET status = 'expired', plan = 'free', updated_at = now()::text WHERE user_id = ?"
      ).run(req.user.uid);
      activePlan = "free";
    } else {
      activePlan = sub.trial_plan;
      license = generateLicense(req.user.uid, activePlan, null, trialEnd);
    }
  } else if (sub.status === "active" && sub.plan !== "free") {
    license = generateLicense(req.user.uid, activePlan, sub.stripe_subscription_id);
  }

  res.json({
    plan: activePlan,
    features: getPlanFeatures(activePlan),
    license,
    status: sub.status,
    trialEnd: sub.status === "trial" && sub.trial_started_at
      ? new Date(new Date(sub.trial_started_at).getTime() + TRIAL_DAYS * 86400000).toISOString()
      : null,
  });
}));

// ═══════════════════════════════════════════════════════════════════════
// POST /api/upgrade/verify — Verificação periódica da licença
// ═══════════════════════════════════════════════════════════════════════
router.post("/verify", authMiddleware, asyncHandler(async (req, res) => {
  const { license: signedLicense } = req.body || {};
  if (!signedLicense) {
    return res.json({ valid: false, plan: "free", features: getPlanFeatures("free") });
  }

  const result = verifyLicense(signedLicense, req.user.uid);
  res.json(result);
}));

// ═══════════════════════════════════════════════════════════════════════
// POST /api/upgrade/heartbeat — Check de relógio
// ═══════════════════════════════════════════════════════════════════════
router.post("/heartbeat", authMiddleware, asyncHandler(async (req, res) => {
  const { deviceTime } = req.body || {};
  if (!deviceTime) {
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
    finalScore = await reportIntegrity(req.user.uid, s.signal, s.severity, s.detail);
    if (finalScore.blocked) break;
  }

  res.json(finalScore);
}));

// ═══════════════════════════════════════════════════════════════════════
// Helpers internos
// ═══════════════════════════════════════════════════════════════════════

async function activatePlan(userId, plan, billing, stripeSubId) {
  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  await db.prepare(
    `INSERT INTO subscriptions (user_id, plan, status, stripe_subscription_id, billing, current_period_start, current_period_end, updated_at)
     VALUES (?, ?, 'active', ?, ?, now()::text, ?, now()::text)
     ON CONFLICT (user_id) DO UPDATE SET
       plan = EXCLUDED.plan,
       status = 'active',
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       billing = EXCLUDED.billing,
       current_period_start = now()::text,
       current_period_end = EXCLUDED.current_period_end,
       trial_started_at = NULL,
       trial_plan = NULL,
       updated_at = now()::text`
  ).run(userId, plan, stripeSubId, billing, periodEnd.toISOString());

  console.log(`[upgrade] Plano ${plan} ativado para user ${userId}`);
}

async function renewSubscription(stripeSubId) {
  const row = await db.prepare("SELECT user_id, current_period_end FROM subscriptions WHERE stripe_subscription_id = ?").get(stripeSubId);
  if (!row) return;

  const newEnd = new Date(row.current_period_end || new Date());
  newEnd.setMonth(newEnd.getMonth() + 1);

  await db.prepare(
    "UPDATE subscriptions SET current_period_end = ?, updated_at = now()::text WHERE stripe_subscription_id = ?"
  ).run(newEnd.toISOString(), stripeSubId);
}

async function deactivatePlan(stripeSubId) {
  await db.prepare(
    "UPDATE subscriptions SET plan = 'free', status = 'cancelled', stripe_subscription_id = NULL, updated_at = now()::text WHERE stripe_subscription_id = ?"
  ).run(stripeSubId);
}

export default router;
