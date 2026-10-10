// Loads data from the API and refreshes it every few seconds, so device status stays live.
// Pauses while the browser tab is hidden.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

export function usePolling(path, intervalMs = 15000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const result = await api.get(path);
      if (!alive.current) return;
      setData(result);
      setError("");
    } catch (err) {
      if (alive.current) setError(err.message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [reload, intervalMs]);

  return { data, error, loading, reload };
}