import { useEffect } from "react";
import { Link } from "react-router-dom";
import {
  Chart,
  Check,
  CloudCheck,
  Cloud,
  Grid,
  Leaf,
  Users,
  WifiOff,
} from "../components/icons";

const plans = [
  {
    id: "basico",
    name: "Básico",
    monthly: "R$ 19,90",
    annual: "R$ 15,92/mês",
    annualTotal: "R$ 191,04/ano",
    description: "Para começar a organizar a propriedade com mais controle.",
    features: ["5 lotes", "15 plantios", "5 análises de IA/dia", "Relatórios avançados", "Clima & alertas"],
  },
  {
    id: "pro",
    name: "Pro",
    monthly: "R$ 29,90",
    annual: "R$ 23,92/mês",
    annualTotal: "R$ 287,04/ano",
    description: "Para produtores que querem acompanhar a safra inteira.",
    features: ["20 lotes", "50 plantios", "15 análises de IA/dia", "Relatórios avançados", "Clima & alertas"],
    featured: true,
  },
  {
    id: "premium",
    name: "Premium",
    monthly: "R$ 59,90",
    annual: "R$ 47,92/mês",
    annualTotal: "R$ 575,04/ano",
    description: "Para operações que precisam de mais escala e inteligência.",
    features: ["40 lotes", "100 plantios", "40 análises de IA/dia", "Relatórios avançados", "Clima & alertas"],
  },
];

const faq = [
  ["Funciona sem internet?", "Sim. O Agrolote salva os dados no aparelho e sincroniza quando a conexão voltar."],
  ["Posso usar em várias propriedades?", "Sim. Cada projeto tem seus próprios dados, membros, permissões e histórico."],
  ["Como funciona a IA?", "A IA usa apenas os dados do projeto autorizado, como plantio, clima e fotos, dentro do limite do plano."],
  ["Meus dados ficam seguros?", "A aplicação separa o escopo de cada projeto e mantém a sincronização autenticada."],
];

export default function Landing() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Agrolote | Gestão de lotes e safras";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f7f8f3] text-stone-900 selection:bg-green-200 selection:text-green-950">
      <header className="sticky top-0 z-40 border-b border-stone-200/80 bg-[#f7f8f3]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <Link to="/" className="flex items-center gap-2.5" aria-label="Agrolote, início">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-green-700 text-xl text-white shadow-lg shadow-green-700/20">
              <Leaf />
            </span>
            <span className="text-lg font-black tracking-tight text-stone-900">Agrolote</span>
          </Link>
          <nav className="hidden items-center gap-7 text-sm font-semibold text-stone-600 md:flex" aria-label="Navegação principal">
            <a className="transition hover:text-green-700" href="#recursos">Recursos</a>
            <a className="transition hover:text-green-700" href="#como-funciona">Como funciona</a>
            <a className="transition hover:text-green-700" href="#planos">Planos</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/login" className="hidden min-h-11 items-center justify-center rounded-xl px-3 text-sm font-bold text-stone-700 transition hover:bg-white sm:inline-flex">
              Entrar
            </Link>
            <Link to="/login" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-green-700 px-4 text-sm font-bold text-white shadow-lg shadow-green-700/20 transition hover:bg-green-800">
              Criar conta
            </Link>
          </div>
        </div>
      </header>

      <a href="#conteudo" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-white focus:px-4 focus:py-3 focus:text-sm focus:font-bold focus:text-green-800 focus:shadow-xl">Pular para o conteúdo</a>
      <main id="conteudo">
        <section className="relative overflow-hidden border-b border-stone-200/70">
          <div className="pointer-events-none absolute -left-24 top-20 h-72 w-72 rounded-full bg-green-200/50 blur-3xl" aria-hidden="true" />
          <div className="pointer-events-none absolute -right-20 top-0 h-96 w-96 rounded-full bg-amber-200/40 blur-3xl" aria-hidden="true" />
          <div className="relative mx-auto grid max-w-6xl gap-12 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1.05fr_.95fr] lg:items-center lg:px-8 lg:py-28">
            <div className="max-w-2xl">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-green-200 bg-white/80 px-3 py-1.5 text-xs font-extrabold uppercase tracking-[0.16em] text-green-800 shadow-sm">
                <CloudCheck className="text-base" />
                Gestão agrícola que acompanha você
              </div>
              <h1 className="max-w-xl text-4xl font-black leading-[1.04] tracking-[-0.04em] text-stone-950 sm:text-6xl">
                Da lavoura à colheita, <span className="text-green-700">tudo no mesmo lugar.</span>
              </h1>
              <p className="mt-6 max-w-xl text-base leading-7 text-stone-600 sm:text-lg">
                O Agrolote organiza lotes, plantios, insumos, custos e colheitas em uma visão simples — com IA, clima e funcionamiento offline para você decidir com confiança.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link to="/login" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-green-700 px-6 text-sm font-extrabold text-white shadow-xl shadow-green-700/20 transition hover:-translate-y-0.5 hover:bg-green-800">
                  Começar agora <span aria-hidden="true">→</span>
                </Link>
                <a href="#como-funciona" className="inline-flex min-h-12 items-center justify-center rounded-2xl border border-stone-300 bg-white px-6 text-sm font-extrabold text-stone-700 transition hover:border-green-300 hover:text-green-700">
                  Ver como funciona
                </a>
              </div>
              <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-semibold text-stone-500">
                <span className="inline-flex items-center gap-1.5"><Check className="text-green-600" /> 10 dias de teste</span>
                <span className="inline-flex items-center gap-1.5"><Check className="text-green-600" /> Sem cartão para testar</span>
                <span className="inline-flex items-center gap-1.5"><Check className="text-green-600" /> Funciona offline</span>
              </div>
            </div>

            <div className="relative mx-auto w-full max-w-lg" aria-label="Prévia do painel do Agrolote">
              <div className="absolute -inset-4 rounded-[2.5rem] bg-gradient-to-br from-green-200/60 via-transparent to-amber-200/50 blur-2xl" aria-hidden="true" />
              <div className="relative overflow-hidden rounded-[2rem] border border-white/80 bg-white/90 p-3 shadow-2xl shadow-stone-900/10 backdrop-blur sm:p-4">
                <div className="flex items-center justify-between border-b border-stone-100 px-2 pb-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-stone-400">Visão geral</p>
                    <p className="mt-1 font-black text-stone-900">Fazenda Boa Esperança</p>
                  </div>
                  <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-bold text-green-700">Safra ativa</span>
                </div>
                <div className="grid grid-cols-2 gap-3 p-2 pt-4 sm:grid-cols-4">
                  {[
                    ["Lotes", "12", "ativos"],
                    ["Plantios", "28", "em curso"],
                    ["Chuva", "34 mm", "7 dias"],
                    ["Margem", "24,8%", "projeção"],
                  ].map(([label, value, hint]) => (
                    <div key={label} className="rounded-2xl bg-stone-50 p-3">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-stone-400">{label}</p>
                      <p className="mt-1 text-lg font-black text-stone-900">{value}</p>
                      <p className="text-[10px] text-stone-400">{hint}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-3 rounded-2xl bg-gradient-to-br from-green-700 to-emerald-800 p-4 text-white">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold text-green-100">Clima agora</p>
                      <p className="mt-1 text-3xl font-black">24°</p>
                      <p className="text-xs text-green-100">Parcialmente nublado · brisa leve</p>
                    </div>
                    <Cloud className="text-5xl text-amber-200" />
                  </div>
                  <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/15"><div className="h-full w-3/4 rounded-full bg-amber-300" /></div>
                  <div className="mt-2 flex justify-between text-[10px] text-green-100"><span>07h</span><span>13h</span><span>19h</span></div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 p-2">
                  <div className="rounded-2xl border border-stone-100 p-3"><p className="text-xs font-bold text-stone-800"> AgroIA</p><p className="mt-1 text-xs leading-5 text-stone-500">Sugestões para o plantio da semana.</p></div>
                  <div className="rounded-2xl border border-stone-100 p-3"><p className="text-xs font-bold text-stone-800">Offline-first</p><p className="mt-1 text-xs leading-5 text-stone-500">Seus dados continuam com você.</p></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="recursos" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <p className="text-xs font-black uppercase tracking-[0.18em] text-green-700">Tudo o que importa no campo</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-stone-950 sm:text-4xl">Menos planilhas. Mais clareza para crescer.</h2>
            <p className="mt-4 leading-7 text-stone-600">Informação simples para quem precisa tomar decisões todos os dias — do plantio à venda.</p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              [Grid, "Tudo por projeto", "Lotes, plantio, insumos, gastos e colheitas separados por propriedade e equipe."],
              [Chart, "Relatórios que ajudam", "Acompanhe custos, receitas, produtividade e margem sem perder o fio da safra."],
              [Cloud, "Clima no seu ritmo", "Veja previsão, UV, vento e alertas no momento em que o campo muda."],
              [Check, "IA com contexto", "A AgroIA consulta somente os dados autorizados do projeto, com limite diário por plano."],
              [WifiOff, "Offline de verdade", "Registre no aparelho mesmo sem sinal. A sincronização acontece quando você voltar."],
              [Users, "Colaboração segura", "Convide sua equipe e defina o nível de acesso de cada pessoa."],
            ].map(([Icon, title, description]) => (
              <article key={title as string} className="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:border-green-200 hover:shadow-xl hover:shadow-green-900/5">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-green-100 text-xl text-green-700"><Icon /></span>
                <h3 className="mt-5 font-black text-stone-900">{title as string}</h3>
                <p className="mt-2 text-sm leading-6 text-stone-600">{description as string}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="como-funciona" className="border-y border-stone-200 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
            <div className="max-w-2xl">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-green-700">Comece em minutos</p>
              <h2 className="mt-3 text-3xl font-black tracking-tight text-stone-950 sm:text-4xl">Seu campo, finalmente organizado.</h2>
            </div>
            <div className="mt-12 grid gap-8 md:grid-cols-3">
              {[
                ["01", "Crie sua conta", "Escolha uma senha e comece com um projeto gratuito ou seu plano."],
                ["02", "Monte o campo", "Cadastre lotes, plantios e insumos. O Agrolote funciona mesmo offline."],
                ["03", "Decida com dados", "Use relatórios, clima e AgroIA para cuidar da próxima etapa."],
              ].map(([number, title, text]) => (
                <div key={number} className="relative rounded-3xl bg-[#f7f8f3] p-6">
                  <span className="text-5xl font-black text-green-200">{number}</span>
                  <h3 className="mt-4 text-lg font-black text-stone-900">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-stone-600">{text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="planos" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div className="max-w-2xl">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-green-700">Planos simples</p>
              <h2 className="mt-3 text-3xl font-black tracking-tight text-stone-950 sm:text-4xl">Escolha o ritmo da sua safra.</h2>
              <p className="mt-4 leading-7 text-stone-600">Comece com 10 dias grátis. Depois, você escolhe o plano que acompanha a sua operação.</p>
            </div>
            <span className="inline-flex w-fit items-center gap-2 rounded-full bg-amber-100 px-3 py-1.5 text-xs font-black text-amber-800">Anual com 20% de desconto</span>
          </div>
          <div className="mt-10 grid gap-5 lg:grid-cols-3">
            {plans.map((plan) => (
              <article key={plan.id} className={`relative flex flex-col rounded-3xl border p-6 shadow-sm ${plan.featured ? "border-green-500 bg-green-700 text-white shadow-xl shadow-green-900/15" : "border-stone-200 bg-white text-stone-900"}`}>
                {plan.featured && <span className="absolute -top-3 left-6 rounded-full bg-amber-300 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-amber-950">Mais escolhido</span>}
                <h3 className="text-xl font-black">{plan.name}</h3>
                <p className={`mt-2 min-h-12 text-sm leading-6 ${plan.featured ? "text-green-100" : "text-stone-500"}`}>{plan.description}</p>
                <div className="mt-6 flex items-end gap-1"><span className="text-3xl font-black">{plan.monthly}</span><span className={`pb-1 text-sm ${plan.featured ? "text-green-100" : "text-stone-500"}`}>/mês</span></div>
                <p className={`mt-1 text-xs ${plan.featured ? "text-green-100" : "text-stone-400"}`}>ou {plan.annual} · {plan.annualTotal}</p>
                <ul className="mt-6 flex-1 space-y-3">
                  {plan.features.map((feature) => <li key={feature} className="flex items-center gap-2 text-sm"><Check className={plan.featured ? "text-amber-200" : "text-green-600"} />{feature}</li>)}
                </ul>
                <Link to="/login" className={`mt-7 inline-flex min-h-12 items-center justify-center rounded-2xl px-4 text-sm font-black transition ${plan.featured ? "bg-white text-green-800 hover:bg-green-50" : "bg-green-700 text-white hover:bg-green-800"}`}>Começar agora →</Link>
              </article>
            ))}
          </div>
        </section>

        <section className="bg-stone-950 text-white">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
            <div className="grid gap-12 lg:grid-cols-[.8fr_1.2fr] lg:items-start">
              <div><p className="text-xs font-black uppercase tracking-[0.18em] text-green-300">Dúvidas frequentes</p><h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Antes de começar.</h2></div>
              <div className="divide-y divide-white/10">
                {faq.map(([question, answer]) => <details key={question} className="group py-5"><summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-bold marker:hidden">{question}<span className="text-xl text-green-300 transition group-open:rotate-45">+</span></summary><p className="mt-3 max-w-2xl text-sm leading-6 text-stone-300">{answer}</p></details>)}
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="relative overflow-hidden rounded-[2rem] bg-green-700 px-6 py-12 text-white sm:px-12">
            <div className="absolute -right-10 -top-20 h-64 w-64 rounded-full bg-white/10 blur-2xl" aria-hidden="true" />
            <div className="relative max-w-2xl"><p className="text-xs font-black uppercase tracking-[0.18em] text-green-100">Pronto para cultivar?</p><h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Comece a organizar sua próxima safra hoje.</h2><p className="mt-4 text-green-50">Crie sua conta, conecte sua propriedade e deixe o Agrolote cuidar da complexidade.</p><Link to="/login" className="mt-7 inline-flex min-h-12 items-center justify-center rounded-2xl bg-white px-6 text-sm font-black text-green-800 transition hover:bg-green-50">Criar minha conta →</Link></div>
          </div>
        </section>
      </main>

      <footer className="border-t border-stone-200 bg-[#f7f8f3]">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-stone-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div className="flex items-center gap-2 font-black text-stone-800"><span className="flex h-8 w-8 items-center justify-center rounded-xl bg-green-700 text-white"><Leaf /></span>Agrolote</div>
          <p>Feito para quem cuida do campo.</p>
          <div className="flex gap-4"><Link className="hover:text-green-700" to="/login">Entrar</Link><a className="hover:text-green-700" href="#planos">Planos</a></div>
        </div>
      </footer>
    </div>
  );
}
