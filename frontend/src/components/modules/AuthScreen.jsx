import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { formatApiError } from "../../lib/api";
import { Field } from "../ui/Shell";
import { Sprout } from "lucide-react";

export default function AuthScreen() {
  const nav = useNavigate();
  const { login, register, continueAsGuest } = useAuth();
  const [mode, setMode] = useState("signin"); // signin | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "signin") await login(email.trim(), password);
      else await register(email.trim(), password, name);
      nav("/dashboard", { replace: true });
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  }

  function asGuest() {
    continueAsGuest();
    nav("/dashboard", { replace: true });
  }

  return (
    <div className="page-shell px-5 pt-14 pb-10 min-h-[100dvh] flex flex-col">
      <div className="flex flex-col items-center mb-8">
        <div className="w-14 h-14 rounded-2xl bg-brand/15 border border-brand/30 flex items-center justify-center mb-3">
          <Sprout size={28} className="text-brand" />
        </div>
        <h1 className="font-heading text-2xl font-bold text-ink-primary tracking-tight">RootRecord</h1>
        <p className="text-xs text-ink-secondary mt-1">Business Manager</p>
        <p className="text-xs text-ink-tertiary mt-3 text-center max-w-[300px]">
          Use the same email and password as your Windows installer. Your account, plan, and sync follow you across every device.
        </p>
      </div>

      <div className="card p-1 flex mb-5" role="tablist">
        <button
          data-testid="auth-tab-signin"
          role="tab"
          aria-selected={mode === "signin"}
          onClick={() => setMode("signin")}
          className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
            mode === "signin" ? "bg-bg-elevated text-ink-primary" : "text-ink-tertiary"
          }`}
        >
          Sign in
        </button>
        <button
          data-testid="auth-tab-signup"
          role="tab"
          aria-selected={mode === "signup"}
          onClick={() => setMode("signup")}
          className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
            mode === "signup" ? "bg-bg-elevated text-ink-primary" : "text-ink-tertiary"
          }`}
        >
          Create account
        </button>
      </div>

      <form onSubmit={submit} className="card p-4">
        {mode === "signup" && (
          <Field label="Name">
            <input
              data-testid="auth-name-input"
              className="input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What should we call you?"
              autoComplete="name"
            />
          </Field>
        )}
        <Field label="Email">
          <input
            data-testid="auth-email-input"
            className="input"
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoComplete="email"
          />
        </Field>
        <Field label="Password" hint={mode === "signup" ? "At least 6 characters." : ""}>
          <input
            data-testid="auth-password-input"
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            minLength={6}
            required
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
          />
        </Field>

        {error && (
          <p data-testid="auth-error" className="text-sm text-[#FB7185] mb-3">{error}</p>
        )}

        <button data-testid="auth-submit-btn" type="submit" disabled={busy} className="btn btn-primary w-full">
          {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>

      <button
        data-testid="auth-guest-btn"
        onClick={asGuest}
        className="btn btn-ghost mt-5 self-center text-ink-secondary text-sm"
      >
        Continue without an account
      </button>

      <p className="text-xs text-ink-tertiary text-center mt-auto pt-6">
        Powered by the RootRecord licence Worker — same account, same email/password, every device.
      </p>
    </div>
  );
}
