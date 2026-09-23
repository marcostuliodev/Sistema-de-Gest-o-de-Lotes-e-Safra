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
import { col } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { PLANS, PRICES, STRIPE_PRICE_IDS, TRIAL_DAYS, PAID_PLANS, getPlanFeatures, isValidPlan, resolveEffectivePlan } from "../plans.js";
import { generateLicense, verifyLicense, getPublicKeyPem } from "../license.js";
import { checkClock } from "../clock-guard.js";
import { reportIntegrity, isUserBlocked } from "../integrity.js";

const router = Router();
const IS_PROD = process.env.NODE_ENV === "production";
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const APP_URL = process.env.APP_URL || (IS_PROD ? "https://agrolote.marcostuliogc.com.br" : "http://localhost:5173");

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
  try {
    // Bloquear checkout para colaboradores
    const { col } = await import("../db.js");
    const collabsCol = await col("collaborators");
    const asCollab = await collabsCol.findOne({ user_id: req.user.uid, status: "active" });
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

    // Busca ou cria customer
    const subs = await col("subscriptions");
    const sub = await subs.findOne({ user_id: req.user.uid });
    let customerId = sub?.stripe_customer_id;

    if (!customerId) {
      const stripe = (await import("stripe")).default(STRIPE_SECRET);
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: { userId: String(req.user.uid) },
      });
      customerId = customer.id;
      await subs.updateOne(
        { user_id: req.user.uid },
        { $set: { stripe_customer_id: customerId } },
        { upsert: true }
      );
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
  } catch (e) {
    console.error("[checkout] Erro:", e.message);
    // Em prod não vaza e.message (pode conter detalhes internos do Stripe/infra)
    res.status(500).json({ error: IS_PROD ? "Erro ao criar checkout" : (e.message || "Erro ao criar checkout") });
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
        // IDs mistos: Date.now() (números) e uuid (strings). Number(uuid) = NaN
        // faria a ativação do plano ser SEMPRE ignorada para usuários novos.
        const rawUserId = String(session.metadata?.userId || "");
        const userId = /^\d+$/.test(rawUserId) ? Number(rawUserId) : rawUserId;
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
  try {
    // Bloquear trial para colaboradores
    const { col } = await import("../db.js");
    const collabsCol = await col("collaborators");
    const asCollab = await collabsCol.findOne({ user_id: req.user.uid, status: "active" });
    if (asCollab) {
      return res.status(403).json({ error: "Colaboradores nao podem gerenciar planos." });
    }

    const { plan } = req.body || {};
    if (!isValidPlan(plan) || plan === "free") {
      return res.status(400).json({ error: "Plano invalido" });
    }

    const subs = await col("subscriptions");
    const existing = await subs.findOne({ user_id: req.user.uid });

    // Ja tem trial ou assinatura ativa
    if (existing && existing.status === "active" && existing.plan !== "free") {
      return res.status(400).json({ error: "Voce ja possui um plano ativo." });
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
          try { license = generateLicense(req.user.uid, plan, null, trialEnd); } catch (e) { console.error("[trial] generateLicense error:", e.message); }
          return res.json({ plan, trialEnd: trialEnd.toISOString(), license });
        }
        return res.status(400).json({ error: "Voce ja esta testando o plano " + (PLANS[existing.trial_plan]?.label || existing.trial_plan) + "." });
      }
      return res.status(400).json({ error: "Voce ja utilizou o periodo de teste." });
    }

    const trialEnd = new Date(Date.now() + TRIAL_DAYS * 86400000);

    await subs.updateOne(
      { user_id: req.user.uid },
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
      { upsert: true }
    );

    let license = null;
    try {
      license = generateLicense(req.user.uid, plan, null, trialEnd);
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
router.get("/license", authMiddleware, asyncHandler(async (req, res) => {
  try {
    // Plano efetivo: colaboradores herdam o plano do dono
    const { plan, isCollaborator, owner_id, role } = await resolveEffectivePlan(req.user.uid);

    const subs = await col("subscriptions");
    const lookupId = owner_id || req.user.uid;
    const sub = await subs.findOne({ user_id: lookupId });

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
            { user_id: lookupId },
            { $set: { status: "expired", plan: "free", updated_at: new Date().toISOString() } }
          );
        }
        activePlan = "free";
      } else {
        activePlan = sub.trial_plan;
        try {
          license = generateLicense(req.user.uid, activePlan, null, trialEnd);
        } catch (e) {
          console.error("[license] generateLicense error:", e.message);
        }
      }
    } else if (sub.status === "active" && sub.plan !== "free") {
      try {
        license = generateLicense(req.user.uid, activePlan, sub.stripe_subscription_id);
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

  const result = verifyLicense(signedLicense, req.user.uid);
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

async function activatePlan(userId, plan, billing, stripeSubId) {
  const now = new Date();
  const periodEnd = new Date(now);
  if (billing === "annual") {
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  const subs = await col("subscriptions");
  await subs.updateOne(
    { user_id: userId },
    {
      $set: {
        plan,
        status: "active",
        stripe_subscription_id: stripeSubId,
        billing,
        current_period_start: now.toISOString(),
        current_period_end: periodEnd.toISOString(),
        // trial_started_at NÃO é limpo: mantém a marca de "trial já usado"
        // para impedir novo trial após cancelamento/ciclo pago.
        trial_plan: null,
        updated_at: now.toISOString(),
      },
    },
    { upsert: true }
  );

  console.log(`[upgrade] Plano ${plan} ativado para user ${userId}`);
}

async function renewSubscription(stripeSubId) {
  const subs = await col("subscriptions");
  const row = await subs.findOne({ stripe_subscription_id: stripeSubId });
  if (!row) return;

  const newEnd = new Date(row.current_period_end || new Date());
  if (row.billing === "annual") {
    newEnd.setFullYear(newEnd.getFullYear() + 1);
  } else {
    newEnd.setMonth(newEnd.getMonth() + 1);
  }

  await subs.updateOne(
    { stripe_subscription_id: stripeSubId },
    { $set: { current_period_end: newEnd.toISOString(), updated_at: new Date().toISOString() } }
  );
}

async function deactivatePlan(stripeSubId) {
  const subs = await col("subscriptions");
  await subs.updateOne(
    { stripe_subscription_id: stripeSubId },
    {
      $set: {
        plan: "free",
        status: "cancelled",
        stripe_subscription_id: null,
        updated_at: new Date().toISOString(),
      },
    }
  );
}

export default router;
