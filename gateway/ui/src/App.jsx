// Routes. Everything except the login screen requires being logged in.

import { Navigate, Route, Routes, useLocation } from "react-router";
import { useAuth } from "./auth-context.js";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import ComingSoon from "./pages/ComingSoon.jsx";

function RequireLogin({ children }) {
  const { user, checking } = useAuth();
  const location = useLocation();
  if (checking) return null;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireLogin>
            <Layout />
          </RequireLogin>
        }
      >
        <Route index element={<ComingSoon title="Overview" step="7c" />} />
        <Route path="devices" element={<ComingSoon title="Devices" step="7c" />} />
        <Route path="restore" element={<ComingSoon title="Restore" step="7d" />} />
        <Route path="jobs" element={<ComingSoon title="Jobs" step="7e" />} />
        <Route path="integrity" element={<ComingSoon title="Integrity" step="7e" />} />
        <Route path="audit" element={<ComingSoon title="Audit log" step="7e" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}