"use client";

import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

interface Props {
  /** Customer name/number, shown so the right follow-up is being closed. */
  name?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Warning shown before a follow-up is marked done, so a mis-tap on the
 * tick can't silently remove a reminder.
 */
export function FollowupDoneWarning({ name, busy, onConfirm, onCancel }: Props) {
  const t = useTranslations("Followups");
  return (
    <div role="alertdialog" aria-live="assertive" className="space-y-4">
      <div className="flex gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden />
        <div>
          <p className="text-sm font-medium text-foreground">{t("confirmDoneTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {name ? t("confirmDoneDescNamed", { name }) : t("confirmDoneDesc")}
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="button" disabled={busy} onClick={onConfirm}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {t("confirmDoneYes")}
        </Button>
      </div>
    </div>
  );
}
