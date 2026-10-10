// Routes. Everything except the login screen requires being logged in.

import { Navigate, Route, Routes, useLocation } from "react-router";
import { useAuth } from "./auth-context.js";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import Overview from "./pages/Overview.jsx";
import Devices from "./pages/Devices.jsx";
import Restore from "./pages/Restore.jsx";
import Quarantine from "./pages/Quarantine.jsx";
import Jobs from "./pages/Jobs.jsx";
import Integrity from "./pages/Integrity.jsx";
import Audit from "./pages/Audit.jsx";

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
        <Route index element={<Overview />} />
        <Route path="devices" element={<Devices />} />
        <Route path="restore" element={<Restore />} />
        <Route path="quarantine" element={<Quarantine />} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="integrity" element={<Integrity />} />
        <Route path="audit" element={<Audit />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}