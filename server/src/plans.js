/**
 * Definições de planos, limites e preços do Agrolote.
 * Centraliza toda a lógica de negócio relacionada a tiers.
 */

/** Dias de trial por plano (quando o usuário escolhe testar) */
export const TRIAL_DAYS = 10;

/**
 * Limites por plano.
 * maxLotes / maxPlantios: 0 = sem acesso, Infinity = ilimitado.
 */
export const PLANS = Object.freeze({
  free: Object.freeze({
    label: "Gratuito",
    maxLotes: 1,
    maxPlantios: 5,
    maxFotos: 0,
    maxColaboradores: 0,
    relatoriosAvancados: false,
    climaAlertas: false,
  }),
  basico: Object.freeze({
    label: "Básico",
    maxLotes: 5,
    maxPlantios: 15,
    maxFotos: 5,
    maxColaboradores: 2,
    relatoriosAvancados: true,
    climaAlertas: true,
  }),
  pro: Object.freeze({
    label: "Pro",
    maxLotes: 20,
    maxPlantios: 50,
    maxFotos: 20,
    maxColaboradores: 5,
    relatoriosAvancados: true,
    climaAlertas: true,
  }),
  premium: Object.freeze({
    label: "Premium",
    maxLotes: 40,
    maxPlantios: 100,
    maxFotos: Infinity,
    maxColaboradores: 10,
    relatoriosAvancados: true,
    climaAlertas: true,
  }),
});

/**
 * Preços em centavos (evita problemas de ponto flutuante).
 * monthly: cobrança recorrente mensal.
 * annual: preço mensal quando paga anual (desconto ~20%).
 */
export const PRICES = Object.freeze({
  basico: Object.freeze({ monthly: 4990, annual: 3990 }),
  pro: Object.freeze({ monthly: 14990, annual: 11990 }),
  premium: Object.freeze({ monthly: 39990, annual: 31990 }),
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
  return PLANS[plan] || PLANS.free;
}

/** Verifica se o plano é válido (existe na definição). */
export function isValidPlan(plan) {
  return plan in PLANS;
}

/** Retorna preço formatado em reais. */
export function formatPrice(centavos) {
  return `R$ ${(centavos / 100).toFixed(2).replace(".", ",")}`;
}

/** Lista de planos pagos (exclui free). */
export const PAID_PLANS = ["basico", "pro", "premium"];
