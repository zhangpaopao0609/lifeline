import { useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ToastHost } from './components/ToastHost';
import { machineLabel } from './lib/machine-name';
import { CONSOLE_PATH, LANDING_PATH } from './lib/routes';
import { useViewState } from './lib/useViewState';
import { useConnectionStore } from './store/connection';
import { useMachinesStore } from './store/machines';
import { useUiStore } from './store/ui';
import { BootOverlay, SkeletonShell } from './views/BootOverlay';
import { LandingPage } from './views/LandingPage';
import { OnboardingPage } from './views/OnboardingPage';
import { ReconnectPage } from './views/ReconnectPage';

/**
 * Two-screen routing (react-router, history mode — the URL is the real path; back/forward is left to the browser):
 *  - `/` → landing page (LandingPage), independent of console state
 *  - `/console` → console (ConsoleApp)
 *  - any other path → back to landing (`/home` and mistyped URLs don't stay in the address bar)
 */
export function App() {
  return (
    <div className="h-full">
      <Routes>
        <Route path={LANDING_PATH} element={<LandingPage />} />
        <Route path={CONSOLE_PATH} element={<ConsoleApp />} />
        <Route path="*" element={<Navigate to={LANDING_PATH} replace />} />
      </Routes>
      <ToastHost />
    </div>
  );
}

/**
 * The console screen (spec §3):
 *  - offline → P8a reconnect page
 *  - online && no machines → P1 enroll wizard
 *  - connecting >5s and no machines → degrade to P8a (spec P0 state)
 *  - connecting → P0: SkeletonShell skeleton + BootOverlay (appear only after >300ms, stay ≥400ms, 200ms exit)
 *  - online && has machines → P2 main UI (fade in in place)
 *
 * Only mounted on `/console`: while browsing the landing page this whole tree unmounts, so useViewState's
 * mirroring and restore don't need a switch to stop themselves.
 */
function ConsoleApp() {
  const status = useConnectionStore(s => s.status);
  const machines = useMachinesStore(s => s.machines);
  const pushToast = useUiStore(s => s.pushToast);
  const [graceElapsed, setGraceElapsed] = useState(false);
  const prevMachineCount = useRef(0);

  // Machine + IDE + session "last viewed": restore + mirror onto `/console` query and localStorage.
  useViewState();

  useEffect(() => {
    const t = window.setTimeout(setGraceElapsed, 5000, true);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (prevMachineCount.current === 0 && machines.length > 0) {
      const first = machines.find(m => m.connected) ?? machines[0];
      pushToast(`${first ? machineLabel(first) : '电脑'} 已上线`);
    }
    prevMachineCount.current = machines.length;
  }, [machines, pushToast]);

  const booting = status === 'connecting' && !(graceElapsed && machines.length === 0);

  return (
    <>
      <div key={status} className="boot-fade">
        {status === 'offline' || (status === 'connecting' && graceElapsed && machines.length === 0)
          ? (
              <ReconnectPage />
            )
          : status === 'online'
            ? (
                machines.length === 0 ? <OnboardingPage /> : <AppShell />
              )
            : (
                <SkeletonShell />
              )}
      </div>
      {booting && <BootOverlay />}
    </>
  );
}
