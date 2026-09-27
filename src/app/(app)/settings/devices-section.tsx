"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { MonitorSmartphone } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Badge, Button, Card, Spinner, softDisabledClass } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import { Notice, Section } from "./settings-ui";

interface DeviceSession {
  id: string;
  token: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  expiresAt: Date | string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";

  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /(?:Chrome|CriOS)\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : null;
  const device = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Macintosh|Mac OS X/.test(userAgent)
            ? "Mac"
            : /Linux/.test(userAgent)
              ? "Linux"
              : null;

  if (browser && device) return `${browser} on ${device}`;
  return browser ?? device ?? "Unknown device";
}

function sessionTimestamp(value: Date | string): number {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function formatSessionTime(value: Date | string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  // Pinned to the app's canonical en-US formatting (see lib/format's fullDate)
  // rather than the viewer's locale, so dates read the same across the app.
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function DevicesSection() {
  const { confirm, dialog } = useConfirm();
  const { data: currentSession } = authClient.useSession();
  const currentToken = currentSession?.session.token ?? null;
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadSessions() {
      setLoadError(null);
      setSessions(null);
      try {
        const { data, error } = await authClient.listSessions();
        if (cancelled) return;
        if (error) {
          setLoadError(error.message ?? "Celluloid couldn't load your devices. Try again.");
          return;
        }
        setSessions((data ?? []) as DeviceSession[]);
      } catch {
        if (!cancelled) {
          setLoadError("Celluloid couldn't load your devices. Check your connection and retry.");
        }
      }
    }

    void loadSessions();
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  const orderedSessions = useMemo(
    () =>
      [...(sessions ?? [])].sort((a, b) => {
        const aCurrent = a.token === currentToken;
        const bCurrent = b.token === currentToken;
        if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
        return sessionTimestamp(b.updatedAt) - sessionTimestamp(a.updatedAt);
      }),
    [currentToken, sessions],
  );
  const otherSessionCount = currentToken
    ? orderedSessions.filter((session) => session.token !== currentToken).length
    : 0;
  const busy = pendingToken !== null || revokingOthers;

  async function revokeSession(session: DeviceSession) {
    const label = deviceLabel(session.userAgent);
    const accepted = await confirm({
      title: `Sign out ${label}?`,
      body: "That device will need to sign in again.",
      confirmLabel: "Sign out",
      destructive: true,
    });
    if (!accepted) return;

    setActionError(null);
    setPendingToken(session.token);
    try {
      const { error } = await authClient.revokeSession({ token: session.token });
      if (error) {
        setActionError(error.message ?? "Celluloid couldn't sign out that device. Try again.");
        return;
      }
      setSessions((current) =>
        current?.filter((item) => item.token !== session.token) ?? current,
      );
      toast.success(`${label} signed out`);
      // The row, and the Sign out button that had focus, are gone.
      document.getElementById("settings-devices-heading")?.focus();
    } catch {
      setActionError("Celluloid couldn't sign out that device. Check your connection and retry.");
    } finally {
      setPendingToken(null);
    }
  }

  async function revokeOtherSessions() {
    const accepted = await confirm({
      title: "Sign out everywhere else?",
      body: `${otherSessionCount} other ${otherSessionCount === 1 ? "device" : "devices"} will need to sign in again.`,
      confirmLabel: "Sign out everywhere else",
      destructive: true,
    });
    if (!accepted) return;

    setActionError(null);
    setRevokingOthers(true);
    try {
      const { error } = await authClient.revokeOtherSessions();
      if (error) {
        setActionError(error.message ?? "Celluloid couldn't sign out your other devices. Try again.");
        return;
      }
      setSessions((current) =>
        current?.filter((session) => session.token === currentToken) ?? current,
      );
      toast.success("Other devices signed out");
    } catch {
      setActionError(
        "Celluloid couldn't sign out your other devices. Check your connection and retry.",
      );
    } finally {
      setRevokingOthers(false);
    }
  }

  return (
    <>
      {dialog}
      <Section
        icon={MonitorSmartphone}
        title="Devices"
        headingId="settings-devices-heading"
        description="Review active sign-ins and remove devices you no longer use."
      >
        <div className="flex flex-col gap-3">
          {sessions === null && !loadError ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> Loading devices…
            </p>
          ) : null}

          {loadError ? (
            <div className="flex flex-col items-start gap-3">
              <Notice kind="error">{loadError}</Notice>
              <Button variant="secondary" size="sm" onClick={() => setRetryKey((key) => key + 1)}>
                Retry
              </Button>
            </div>
          ) : null}

          {sessions && sessions.length === 0 ? (
            <p className="text-sm text-muted">No active sessions.</p>
          ) : null}

          {orderedSessions.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {orderedSessions.map((session) => {
                const label = deviceLabel(session.userAgent);
                const isCurrent = session.token === currentToken;
                return (
                  <li key={session.id}>
                    <Card
                      variant="inset"
                      className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">{label}</p>
                          {isCurrent ? (
                            <Badge className="bg-brand/15 text-brand ring-brand/30">
                              Current device
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs text-muted">
                          Last active {formatSessionTime(session.updatedAt)} ·{" "}
                          {session.ipAddress ? `IP ${session.ipAddress}` : "IP unavailable"}
                        </p>
                      </div>
                      {!isCurrent ? (
                        <Button
                          variant="danger"
                          size="sm"
                          className={cn("self-start sm:self-auto", softDisabledClass)}
                          aria-label={`Sign out ${label}`}
                          aria-disabled={busy || !currentToken}
                          onClick={() => {
                            if (busy || !currentToken) return;
                            void revokeSession(session);
                          }}
                        >
                          {pendingToken === session.token ? "Signing out…" : "Sign out"}
                        </Button>
                      ) : null}
                    </Card>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {actionError ? <Notice kind="error">{actionError}</Notice> : null}

          {sessions && sessions.length > 0 ? (
            <div className="flex flex-col items-start gap-1.5 border-t border-line pt-3">
              <Button
                variant="danger"
                size="sm"
                className={softDisabledClass}
                aria-disabled={busy || !currentToken || otherSessionCount === 0}
                onClick={() => {
                  if (busy || !currentToken || otherSessionCount === 0) return;
                  void revokeOtherSessions();
                }}
              >
                {revokingOthers ? "Signing out…" : "Sign out everywhere else"}
              </Button>
              {currentToken && otherSessionCount === 0 ? (
                <p className="text-xs text-muted">No other active sessions.</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </Section>
    </>
  );
}
