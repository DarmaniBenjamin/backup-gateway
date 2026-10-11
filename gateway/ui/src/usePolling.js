// Loads data from the API and refreshes it every few seconds, so device status stays live.
// Pauses while the browser tab is hidden.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

export function usePolling(path, intervalMs = 15000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const busy = useRef(null);
  const again = useRef(false);
  const last = useRef("");
  const current = useRef(path);

  const reload = useCallback(async function load() {
    // A refresh is already on its way: run one more right after it (an action may have changed things)
    if (busy.current === path) {
      again.current = true;
      return;
    }
    busy.current = path;
    again.current = false;
    try {
      const result = await api.get(path);
      if (!alive.current || current.current !== path) return; // the page moved on meanwhile
      // Only redraw the page when something actually changed
      const text = JSON.stringify(result);
      if (text !== last.current) {
        last.current = text;
        setData(result);
      }
      setError("");
    } catch (err) {
      if (alive.current) setError(err.message);
    } finally {
      if (busy.current === path) busy.current = null;
      if (alive.current) setLoading(false);
      if (again.current && alive.current && current.current === path) load();
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    current.current = path;
    last.current = "";
    reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, intervalMs);
    // Coming back to the tab: refresh right away instead of waiting for the next tick
    const onVisible = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload, path, intervalMs]);

  return { data, error, loading, reload };
}
