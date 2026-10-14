// Checks on start-up whether we already have a valid session, and keeps track of the logged-in admin.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, setUnauthorizedHandler } from "./api.js";
import { AuthContext } from "./auth-context.js";

export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null)); // session expired -> back to login
    api
      .get("/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  // Returns { needsCode: true } when two-factor login is on and the code is still to type
  const login = useCallback(async (username, password, code) => {
    const me = await api.post("/login", { username, password, ...(code ? { code } : {}) });
    if (me?.needsCode) return me;
    setUser(await api.get("/me"));
    return null;
  }, []);

  // Fresh details (two-factor, lockdown) after changing them
  const refresh = useCallback(async () => setUser(await api.get("/me")), []);

  const logout = useCallback(async () => {
    try {
      await api.post("/logout");
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo(() => ({ user, checking, login, logout, refresh }), [user, checking, login, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}