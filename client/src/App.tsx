import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./store/auth";
import { PlanProvider } from "./store/plan";
import Layout from "./pages/layout";
import Login from "./pages/login";

const Dashboard = lazy(() => import("./pages/dashboard"));
const Lotes = lazy(() => import("./pages/lotes"));
const Plantios = lazy(() => import("./pages/plantios"));
const InsumosPage = lazy(() => import("./pages/insumos"));
const Gastos = lazy(() => import("./pages/gastos"));
const Colheitas = lazy(() => import("./pages/colheitas"));
const Relatorios = lazy(() => import("./pages/relatorios"));
const Clima = lazy(() => import("./pages/clima"));
const Historico = lazy(() => import("./pages/historico"));
const Analytics = lazy(() => import("./pages/analytics"));
const Upgrade = lazy(() => import("./pages/upgrade"));
const Colaboradores = lazy(() => import("./pages/colaboradores"));
const ForgotPassword = lazy(() => import("./pages/forgot-password"));
const ResetPassword = lazy(() => import("./pages/reset-password"));

function Loading() {
  return <p className="p-6 text-sm text-stone-400">Carregando…</p>;
}

export default function App() {
  const { session } = useAuth();

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/forgot-password"
          element={
            <Suspense fallback={<Loading />}>
              <ForgotPassword />
            </Suspense>
          }
        />
        <Route
          path="/reset-password"
          element={
            <Suspense fallback={<Loading />}>
              <ResetPassword />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <PlanProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route
            path="/"
            element={
              <Suspense fallback={<Loading />}>
                <Dashboard />
              </Suspense>
            }
          />
          <Route
            path="/lotes"
            element={
              <Suspense fallback={<Loading />}>
                <Lotes />
              </Suspense>
            }
          />
          <Route
            path="/plantios"
            element={
              <Suspense fallback={<Loading />}>
                <Plantios />
              </Suspense>
            }
          />
          <Route
            path="/insumos"
            element={
              <Suspense fallback={<Loading />}>
                <InsumosPage />
              </Suspense>
            }
          />
          <Route
            path="/gastos"
            element={
              <Suspense fallback={<Loading />}>
                <Gastos />
              </Suspense>
            }
          />
          <Route
            path="/colheitas"
            element={
              <Suspense fallback={<Loading />}>
                <Colheitas />
              </Suspense>
            }
          />
          <Route
            path="/relatorios"
            element={
              <Suspense fallback={<Loading />}>
                <Relatorios />
              </Suspense>
            }
          />
          <Route
            path="/clima"
            element={
              <Suspense fallback={<Loading />}>
                <Clima />
              </Suspense>
            }
          />
          <Route
            path="/historico"
            element={
              <Suspense fallback={<Loading />}>
                <Historico />
              </Suspense>
            }
          />
          <Route
            path="/analytics"
            element={
              <Suspense fallback={<Loading />}>
                <Analytics />
              </Suspense>
            }
          />
          <Route
            path="/upgrade"
            element={
              <Suspense fallback={<Loading />}>
                <Upgrade />
              </Suspense>
            }
          />
          <Route
            path="/colaboradores"
            element={
              <Suspense fallback={<Loading />}>
                <Colaboradores />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </PlanProvider>
  );
}
