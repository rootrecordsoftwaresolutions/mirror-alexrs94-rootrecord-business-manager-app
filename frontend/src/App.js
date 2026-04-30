import React from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import BottomNav from "./components/ui/BottomNav";
import AuthScreen from "./components/modules/AuthScreen";
import Dashboard from "./components/modules/Dashboard";
import TimeTracking from "./components/modules/TimeTracking";
import Finance from "./components/modules/Finance";
import Schedule from "./components/modules/Schedule";
import More from "./components/modules/More";
import WorkLog from "./components/modules/WorkLog";
import Reports from "./components/modules/Reports";
import Stock from "./components/modules/Stock";
import { AccountSettings, BusinessSettings, ProgramSettings, About, Feedback } from "./components/modules/Settings";

function Gate({ children }) {
  const { user, guest } = useAuth();
  const loc = useLocation();
  if (user === undefined) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center text-ink-tertiary text-sm">Loading…</div>
    );
  }
  if (!user && !guest) {
    return <Navigate to="/auth" replace state={{ from: loc.pathname }} />;
  }
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/auth" element={<AuthScreen />} />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<Gate><Dashboard /></Gate>} />
      <Route path="/track" element={<Gate><TimeTracking /></Gate>} />
      <Route path="/money" element={<Gate><Finance /></Gate>} />
      <Route path="/schedule" element={<Gate><Schedule /></Gate>} />
      <Route path="/more" element={<Gate><More /></Gate>} />
      <Route path="/work-log" element={<Gate><WorkLog /></Gate>} />
      <Route path="/reports" element={<Gate><Reports /></Gate>} />
      <Route path="/stock" element={<Gate><Stock /></Gate>} />
      <Route path="/account" element={<Gate><AccountSettings /></Gate>} />
      <Route path="/business" element={<Gate><BusinessSettings /></Gate>} />
      <Route path="/program" element={<Gate><ProgramSettings /></Gate>} />
      <Route path="/about" element={<Gate><About /></Gate>} />
      <Route path="/feedback" element={<Gate><Feedback /></Gate>} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="min-h-[100dvh]">
          <AppRoutes />
          <BottomNav />
        </div>
      </BrowserRouter>
    </AuthProvider>
  );
}
