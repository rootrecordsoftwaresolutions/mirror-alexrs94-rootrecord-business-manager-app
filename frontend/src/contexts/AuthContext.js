import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, getToken, setToken, getDeviceId } from "../lib/api";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  // user: undefined while loading, null when not authed, object when authed
  const [user, setUser] = useState(undefined);
  const [guest, setGuest] = useState(() => localStorage.getItem("rrbm_guest") === "1");

  const refresh = useCallback(async () => {
    const t = getToken();
    if (!t) {
      setUser(null);
      return;
    }
    try {
      const { data } = await api.get("/auth/me");
      setUser(data);
    } catch {
      setToken("");
      setUser(null);
    }
  }, []);

  useEffect(() => {
    if (guest) {
      setUser(null);
      return;
    }
    refresh();
  }, [guest, refresh]);

  const login = useCallback(async (email, password) => {
    const { data } = await api.post("/auth/login", {
      email, password, device_id: getDeviceId(),
    });
    setToken(data.access_token);
    localStorage.removeItem("rrbm_guest");
    setGuest(false);
    setUser(data.user);
    return data.user;
  }, []);

  const register = useCallback(async (email, password, name) => {
    const { data } = await api.post("/auth/register", {
      email, password, name, device_id: getDeviceId(),
    });
    setToken(data.access_token);
    localStorage.removeItem("rrbm_guest");
    setGuest(false);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* ignore */
    }
    setToken("");
    setUser(null);
  }, []);

  const refreshEntitlement = useCallback(async () => {
    try {
      const { data } = await api.post("/auth/entitlement", { device_id: getDeviceId() });
      setUser((u) => (u ? { ...u, plan: data.plan, subscription_status: data.subscription_status } : u));
      return data;
    } catch (e) {
      throw e;
    }
  }, []);

  const continueAsGuest = useCallback(() => {
    localStorage.setItem("rrbm_guest", "1");
    setGuest(true);
    setUser(null);
  }, []);

  const exitGuest = useCallback(() => {
    localStorage.removeItem("rrbm_guest");
    setGuest(false);
  }, []);

  return (
    <AuthCtx.Provider
      value={{ user, guest, login, register, logout, continueAsGuest, exitGuest, refresh, refreshEntitlement }}
    >
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
