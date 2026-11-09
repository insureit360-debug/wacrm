'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { BellRing, Check, CircleAlert, Loader2, Minus, RefreshCw, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  diagnoseClient,
  disablePush,
  enablePush,
  fetchPushStatus,
  fetchServerPublicKey,
  removeDeviceById,
  sendTestPush,
  type EnablePushResult,
  type PushStatusResponse,
} from '@/lib/push/client';
import { evaluateChecks, type CheckState, type ClientFacts, type Diagnosis } from '@/lib/push/doctor';

const STATE_STYLE: Record<CheckState, string> = {
  ok: 'bg-green-500/15 text-green-600',
  fail: 'bg-red-500/15 text-red-500',
  warn: 'bg-amber-500/15 text-amber-500',
  skip: 'bg-muted text-muted-foreground',
};

function StateIcon({ state }: { state: CheckState }) {
  const Icon = state === 'ok' ? Check : state === 'fail' ? X : state === 'warn' ? CircleAlert : Minus;
  return (
    <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full', STATE_STYLE[state])}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function ago(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

function shortBrowser(ua: string | null): string {
  if (!ua) return '?';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : '';
  const br = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome/Brave' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br}${os ? ` · ${os}` : ''}`;
}

/**
 * Settings → Notifications: phone / closed-app push. Instead of a single
 * switch that silently fails, it checks every step between a customer's
 * message and this device, says exactly which one is broken, and offers the
 * button that fixes it.
 */
export function PushDoctor() {
  const t = useTranslations('PushDoctor');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [client, setClient] = useState<ClientFacts | null>(null);
  const [server, setServer] = useState<PushStatusResponse | null>(null);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [busy, setBusy] = useState<null | 'on' | 'repair' | 'test' | 'off'>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const [status, key] = await Promise.all([fetchPushStatus(), fetchServerPublicKey()]);
    const facts = await diagnoseClient(key);
    setClient(facts);
    setServer(status);
    setLoadFailed(status === null);
    setDiagnosis(status ? evaluateChecks(facts, status) : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const explainEnableFailure = (r: Extract<EnablePushResult, { ok: false }>): string => {
    if (r.reason === 'denied') return t('explain_blocked');
    if (r.reason === 'not_configured') return t('explain_not_configured');
    if (r.reason === 'unsupported') return t('explain_unsupported');
    const hint = client?.browser === 'brave' ? ` ${t('tipBrave')}` : '';
    return `${t('enableFailed', { detail: r.detail ?? '' })}${hint}`;
  };

  const turnOn = async (force: boolean) => {
    setBusy(force ? 'repair' : 'on');
    setActionError(null);
    setTestResult(null);
    const r = await enablePush({ force });
    if (r.ok) toast.success(t('enabledToast'));
    else setActionError(explainEnableFailure(r));
    await refresh();
    setBusy(null);
  };

  const turnOff = async () => {
    setBusy('off');
    await disablePush().catch(() => undefined);
    await refresh();
    setBusy(null);
  };

  const sendTest = async () => {
    setBusy('test');
    setTestResult(null);
    const r = await sendTestPush();
    if (!r) setTestResult({ ok: false, text: t('testFailed', { error: 'request failed' }) });
    else if (!r.configured) setTestResult({ ok: false, text: t('explain_not_configured') });
    else if (r.subscriptions === 0) setTestResult({ ok: false, text: t('testNoDevice') });
    else if (r.sent === 0) setTestResult({ ok: false, text: t('testFailed', { error: r.errors[0] ?? 'unknown' }) });
    else setTestResult({ ok: true, text: t('testOk', { count: r.sent }) });
    await refresh();
    setBusy(null);
  };

  const removeDevice = async (id: string) => {
    if (await removeDeviceById(id)) await refresh();
    else toast.error(t('removeFailed'));
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t('checking')}
      </div>
    );
  }

  const needsSetup =
    !client?.hasSubscription || client.permission !== 'granted' || client.swState !== 'active';

  const explain = (code: string, detail?: string): string => {
    if (code === 'last_ok' && server?.lastPush) {
      return t('explain_last_ok', { count: server.lastPush.sent, when: ago(server.lastPush.at) });
    }
    if ((code === 'last_error' || code === 'last_no_devices') && server?.lastPush) {
      return `${ago(server.lastPush.at)}: ${code === 'last_error' ? (detail ?? '') : t('explain_last_no_devices')}`;
    }
    return t(`explain_${code}`, { detail: detail ?? '' });
  };

  const tips: string[] = [];
  if (client?.browser === 'brave') tips.push(t('tipBrave'));
  if (client?.isIOS) tips.push(t('tipIosInstall'));
  else if (client?.isAndroid && !client.standalone) tips.push(t('tipInstall'));
  if (client?.isXiaomiLike) tips.push(t('tipXiaomi'));

  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <BellRing className="size-4 text-muted-foreground" />
          {t('title')}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('intro')}</p>
      </div>

      {loadFailed || !diagnosis ? (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {t('statusLoadFailed')}
        </p>
      ) : (
        <>
          <p
            className={cn(
              'rounded-md border px-3 py-2 text-sm font-medium',
              diagnosis.working
                ? 'border-green-500/30 bg-green-500/10 text-green-600'
                : 'border-red-500/30 bg-red-500/10 text-red-500',
            )}
          >
            {diagnosis.working
              ? t('verdictOk')
              : t('verdictFail', { problem: t(`label_${diagnosis.problem!.id}`) })}
          </p>

          <ul className="space-y-2">
            {diagnosis.checks.map((c) => (
              <li key={c.id} className="flex gap-3">
                <StateIcon state={c.state} />
                <div className="min-w-0">
                  <p className="text-sm text-foreground">{t(`label_${c.id}`)}</p>
                  {(c.state === 'fail' || c.state === 'warn' || c.code === 'last_ok' || c.code === 'none_yet') && (
                    <p className="break-words text-xs text-muted-foreground">{explain(c.code, c.detail)}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {actionError && (
        <p className="break-words rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {actionError}
        </p>
      )}
      {testResult && (
        <p
          className={cn(
            'break-words rounded-md border px-3 py-2 text-xs',
            testResult.ok
              ? 'border-green-500/30 bg-green-500/10 text-green-600'
              : 'border-red-500/30 bg-red-500/10 text-red-500',
          )}
        >
          {testResult.text}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy !== null} onClick={() => void turnOn(!needsSetup)}>
          {busy === 'on' || busy === 'repair' ? <Loader2 className="size-4 animate-spin" /> : <BellRing className="size-4" />}
          {needsSetup ? t('turnOn') : t('repair')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy !== null || needsSetup} onClick={() => void sendTest()}>
          {busy === 'test' && <Loader2 className="size-4 animate-spin" />}
          {t('sendTest')}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void refresh()}>
          <RefreshCw className="size-4" />
          {t('recheck')}
        </Button>
        {client?.hasSubscription && (
          <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void turnOff()}>
            {t('turnOff')}
          </Button>
        )}
      </div>

      {tips.length > 0 && (
        <ul className="space-y-2">
          {tips.map((tip) => (
            <li key={tip} className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{tip}</span>
            </li>
          ))}
        </ul>
      )}

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{t('phoneSettingsTitle')}</summary>
        <p className="mt-2">{t('phoneSettingsBody')}</p>
      </details>

      {server && server.devices.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('devicesTitle')}</p>
          <ul className="space-y-1">
            {server.devices.map((d) => (
              <li key={d.id} className="flex items-center gap-2 rounded-md border border-border p-2 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-foreground">
                    {shortBrowser(d.userAgent)}
                    {d.endpointHash === client?.endpointHash && (
                      <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{t('thisDevice')}</span>
                    )}
                  </p>
                  <p className="truncate text-muted-foreground">
                    {d.endpointHost} · {t('lastSeen', { when: ago(d.lastSeenAt) })}
                  </p>
                </div>
                <Button type="button" size="sm" variant="ghost" aria-label={t('removeDevice')} onClick={() => void removeDevice(d.id)}>
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
