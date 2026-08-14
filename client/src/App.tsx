import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./store/auth";
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

function Loading() {
  return <p className="p-6 text-sm text-stone-400">Carregando…</p>;
}

export default function App() {
  const { session } = useAuth();

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
