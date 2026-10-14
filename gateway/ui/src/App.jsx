// Routes. Everything except the login screen requires being logged in.

import { lazy } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { useAuth } from "./auth-context.js";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import Overview from "./pages/Overview.jsx";
import { pages } from "./pages.js";

const Devices = lazy(pages.Devices);
const DeviceFolders = lazy(pages.DeviceFolders);
const Restore = lazy(pages.Restore);
const Quarantine = lazy(pages.Quarantine);
const Jobs = lazy(pages.Jobs);
const Integrity = lazy(pages.Integrity);
const Audit = lazy(pages.Audit);
const Offsite = lazy(pages.Offsite);
const Security = lazy(pages.Security);
const Alerts = lazy(pages.Alerts);
const Certificate = lazy(pages.Certificate);
const Account = lazy(pages.Account);

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
        <Route path="devices/:id" element={<DeviceFolders />} />
        <Route path="restore" element={<Restore />} />
        <Route path="security" element={<Security />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="domain" element={<Certificate />} />
        <Route path="account" element={<Account />} />
        <Route path="certificate" element={<Navigate to="/domain" replace />} />
        <Route path="quarantine" element={<Quarantine />} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="offsite" element={<Offsite />} />
        <Route path="integrity" element={<Integrity />} />
        <Route path="audit" element={<Audit />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}