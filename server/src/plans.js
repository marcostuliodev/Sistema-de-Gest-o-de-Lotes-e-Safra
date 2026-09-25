/**
 * Definições de planos, limites e preços do Agrolote.
 * Centraliza toda a lógica de negócio relacionada a tiers.
 */

/** Dias de trial por plano (quando o usuário escolhe testar) */
export const TRIAL_DAYS = 10;

/**
 * Limites por plano.
 * maxLotes / maxPlantios: 0 = sem acesso, Infinity = ilimitado.
 * maxIaDia: análises de IA (texto ou foto) permitidas por dia.
 */
export const PLANS = Object.freeze({
  free: Object.freeze({
    label: "Gratuito",
    maxLotes: 1,
    maxPlantios: 5,
    maxFotos: 0,
    maxColaboradores: 0,
    maxIaDia: 3,
    relatoriosAvancados: false,
    climaAlertas: false,
  }),
  basico: Object.freeze({
    label: "Básico",
    maxLotes: 5,
    maxPlantios: 15,
    maxFotos: 5,
    maxColaboradores: 2,
    maxIaDia: 30,
    relatoriosAvancados: true,
    climaAlertas: true,
  }),
  pro: Object.freeze({
    label: "Pro",
    maxLotes: 20,
    maxPlantios: 50,
    maxFotos: 20,
    maxColaboradores: 5,
    maxIaDia: 120,
    relatoriosAvancados: true,
    climaAlertas: true,
  }),
  premium: Object.freeze({
    label: "Premium",
    maxLotes: 40,
    maxPlantios: 100,
    maxFotos: Infinity,
    maxColaboradores: 10,
    maxIaDia: 10000,
    relatoriosAvancados: true,
    climaAlertas: true,
  }),
});

export const PLAN_KEYS = Object.keys(PLANS);

/**
 * Preços em centavos (evita problemas de ponto flutuante).
 * monthly: cobrança recorrente mensal.
 * annual: preço mensal quando paga anual (desconto ~20%).
 */
export const PRICES = Object.freeze({
  basico: Object.freeze({ monthly: 1990, annual: 3990 }),
  pro: Object.freeze({ monthly: 2990, annual: 11990 }),
  premium: Object.freeze({ monthly: 5990, annual: 31990 }),
});

/**
 * IDs dos price IDs do Stripe — preencher após criar no Dashboard.
 * Chave: `${plan}_${billing}` → valor: price_xxx do Stripe.
 */
export const STRIPE_PRICE_IDS = Object.freeze({
  basico_monthly: process.env.STRIPE_PRICE_BASICO_MONTHLY || "",
  basico_annual: process.env.STRIPE_PRICE_BASICO_ANNUAL || "",
  pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY || "",
  pro_annual: process.env.STRIPE_PRICE_PRO_ANNUAL || "",
  premium_monthly: process.env.STRIPE_PRICE_PREMIUM_MONTHLY || "",
  premium_annual: process.env.STRIPE_PRICE_PREMIUM_ANNUAL || "",
});

/** Retorna os limites para um plano; fallback = free. */
export function getPlanFeatures(plan) {
  if (typeof plan === "string" && Object.hasOwn(PLANS, plan)) {
    return PLANS[plan];
  }
  return PLANS.free;
}

/** Verifica se o plano é válido (existe na definição). */
export function isValidPlan(plan) {
  return typeof plan === "string" && Object.hasOwn(PLANS, plan);
}

/** Retorna preço formatado em reais. */
export function formatPrice(centavos) {
  return `R$ ${(centavos / 100).toFixed(2).replace(".", ",")}`;
}

/** Lista de planos pagos (exclui free). */
export const PAID_PLANS = ["basico", "pro", "premium"];

export function getSubscriptionPlan(subscription, now = Date.now()) {
  if (!subscription) return "free";
  const status = String(subscription.status || "").toLowerCase();
  if (status === "trial") {
    const configuredEnd = subscription.current_period_end ? new Date(subscription.current_period_end).getTime() : NaN;
    const started = subscription.trial_started_at ? new Date(subscription.trial_started_at).getTime() : NaN;
    const trialEnd = Number.isFinite(configuredEnd)
      ? configuredEnd
      : Number.isFinite(started)
        ? started + TRIAL_DAYS * 86400000
        : NaN;
    return Number.isFinite(trialEnd) && trialEnd > now && isValidPlan(subscription.trial_plan)
      ? subscription.trial_plan
      : "free";
  }
  return ["active", "past_due"].includes(status) && isValidPlan(subscription.plan)
    ? subscription.plan
    : "free";
}

export async function isProjectCollaborator(userId) {
  const { col } = await import("./db.js");
  const { resolveUser } = await import("./authz.js");
  let resolved;
  try {
    resolved = await resolveUser({ uid: userId });
  } catch {
    return false;
  }
  const values = [resolved?._id, resolved?.id, resolved?.user_key, userId]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map(String);
  if (values.length === 0) return false;
  const rows = await (await col("project_members")).find({
    $or: values.flatMap((value) => [{ user_key: value }, { user_id: value }]),
  }).toArray();
  return rows.some((row) => {
    const status = row.status === undefined || row.status === null ? "active" : String(row.status).toLowerCase();
    const role = String(row.role_id || row.role || "").toLowerCase();
    return status === "active" && role !== "owner";
  });
}

/**
 * Resolve o plano efetivo de um usuário.
 * Se for colaborador ativo, herda o plano do dono.
 */
export async function resolveEffectivePlan(userId, projectId = null) {
  const { col } = await import("./db.js");
  let ownerId = userId;
  let isCollaborator = false;
  let role = null;

  if (projectId) {
    const { resolveProject, resolveProjectAccess } = await import("./authz.js");
    const project = await resolveProject(projectId);
    const access = await resolveProjectAccess(projectId, { uid: userId });
    if (project && access) {
      ownerId = project.owner_id || project.owner_key || project.created_by || userId;
      isCollaborator = access.isOwner !== true;
      role = access.role || null;
    }
  } else {
    const collabsCol = await col("collaborators");
    const collab = await collabsCol.findOne({ user_id: userId, status: "active" });
    if (collab) {
      ownerId = collab.owner_id;
      isCollaborator = true;
      role = collab.role;
    }
  }

  const ownerValues = ownerId === undefined || ownerId === null
    ? []
    : [ownerId, String(ownerId)];
  if (ownerId !== undefined && ownerId !== null) {
    try {
      const { resolveUser } = await import("./authz.js");
      const owner = await resolveUser({ uid: ownerId });
      for (const value of [owner?._id, owner?.id, owner?.user_key, owner?.email]) {
        if (value !== undefined && value !== null) ownerValues.push(value, String(value));
      }
    } catch {
      // mantém os IDs legados já coletados
    }
  }
  const sub = ownerValues.length > 0
    ? await (await col("subscriptions")).findOne({ $or: ownerValues.map((value) => ({ user_id: value })) })
    : null;
  const plan = getSubscriptionPlan(sub);

  return { plan, isCollaborator, owner_id: ownerId || null, role };
}
