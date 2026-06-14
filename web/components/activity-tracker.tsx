'use client';

// =============================================================================
// ActivityTracker — invisible global presence/activity beacon.
//
// Mounted once in the root layout. While the user is signed in it:
//   • posts a one-time `login` ping when the app boots,
//   • posts a `heartbeat` every 30s with active=true when the mouse/keyboard
//     moved during that interval (otherwise active=false → "passive, tab open").
//
// No token → no pings (login page, signed-out). Writes to /api/activity/ping.
// =============================================================================
import { useEffect, useRef } from 'react';
import { getToken } from '@/lib/auth';

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';
const HEARTBEAT_MS = 30_000;

let mounted = false; // guard against accidental double-mount

export default function ActivityTracker() {
  const active = useRef(false);

  useEffect(() => {
    if (mounted) return;
    mounted = true;

    const markActive = () => { active.current = true; };
    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'];
    events.forEach((e) => window.addEventListener(e, markActive, { passive: true }));

    const ping = (kind: 'login' | 'heartbeat', isActive: boolean) => {
      const token = getToken();
      if (!token) return;
      fetch(`${API_BASE}/api/activity/ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind, active: isActive, path: window.location.pathname }),
        keepalive: true,
      }).catch(() => { /* network blip — drop this beat */ });
    };

    ping('login', true);

    const id = window.setInterval(() => {
      const wasActive = active.current;
      active.current = false;
      ping('heartbeat', wasActive);
    }, HEARTBEAT_MS);

    return () => {
      window.clearInterval(id);
      events.forEach((e) => window.removeEventListener(e, markActive));
      mounted = false;
    };
  }, []);

  return null;
}
