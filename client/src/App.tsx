import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./store/auth";
import Layout from "./pages/layout";
import Login from "./pages/login";
import Dashboard from "./pages/dashboard";
import Lotes from "./pages/lotes";
import Plantios from "./pages/plantios";
import InsumosPage from "./pages/insumos";
import Gastos from "./pages/gastos";
import Colheitas from "./pages/colheitas";
import Relatorios from "./pages/relatorios";
import Clima from "./pages/clima";

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
        <Route path="/" element={<Dashboard />} />
        <Route path="/lotes" element={<Lotes />} />
        <Route path="/plantios" element={<Plantios />} />
        <Route path="/insumos" element={<InsumosPage />} />
        <Route path="/gastos" element={<Gastos />} />
        <Route path="/colheitas" element={<Colheitas />} />
        <Route path="/relatorios" element={<Relatorios />} />
        <Route path="/clima" element={<Clima />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}