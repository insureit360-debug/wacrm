"use client";

import { useCallback, useMemo, useState } from "react";
import { format } from "date-fns";
import { AlertTriangle, FileText, HardDrive, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface Item {
  id: string;
  contentType: string;
  mimeType: string | null;
  name: string;
  url: string;
  createdAt: string;
  senderType: string;
  bytes: number | null;
}

type Filter = "all" | "image" | "document" | "other";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const PAGE = 50;

interface Props {
  conversationId: string;
  /** Called with the message ids whose file was deleted, so the thread can update. */
  onDeleted: (messageIds: string[]) => void;
}

export function MediaManagerButton({ conversationId, onDeleted }: Props) {
  const t = useTranslations("MediaManager");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [whatsappHosted, setWhatsappHosted] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState(PAGE);
  const [step, setStep] = useState<"list" | "confirm">("list");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(
        `/api/messages/media?conversation_id=${encodeURIComponent(conversationId)}`,
        { credentials: "same-origin" },
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { items: Item[]; hostedByWhatsapp: number };
      setItems(data.items);
      setWhatsappHosted(data.hostedByWhatsapp);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  const openDialog = () => {
    setOpen(true);
    setStep("list");
    setTyped("");
    setSelected(new Set());
    setVisible(PAGE);
    setFilter("all");
    void load();
  };

  const shown = useMemo(
    () =>
      items.filter((i) =>
        filter === "all"
          ? true
          : filter === "image"
            ? i.contentType === "image"
            : filter === "document"
              ? i.contentType === "document"
              : i.contentType !== "image" && i.contentType !== "document",
      ),
    [items, filter],
  );

  const totalBytes = items.reduce((s, i) => s + (i.bytes ?? 0), 0);
  const selectedItems = items.filter((i) => selected.has(i.id));
  const selectedBytes = selectedItems.reduce((s, i) => s + (i.bytes ?? 0), 0);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const doDelete = async () => {
    if (typed !== "DELETE" || selected.size === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/messages/media", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          message_ids: Array.from(selected),
          confirm: "DELETE",
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        results: Array<{ id: string; status: string }>;
        deleted: number;
        freedBytes: number;
      };
      const deletedIds = data.results.filter((r) => r.status === "deleted").map((r) => r.id);
      const untouched = data.results.length - deletedIds.length;
      if (deletedIds.length > 0) {
        toast.success(
          t("deletedToast", { count: deletedIds.length, size: formatBytes(data.freedBytes) }),
        );
        onDeleted(deletedIds);
      }
      if (untouched > 0) toast.error(t("partialToast", { count: untouched }));
      setItems((prev) => prev.filter((i) => !deletedIds.includes(i.id)));
      setSelected(new Set());
      setTyped("");
      setStep("list");
    } catch {
      toast.error(t("failedToast"));
    } finally {
      setBusy(false);
    }
  };

  const filters: Array<[Filter, string]> = [
    ["all", t("filter_all")],
    ["image", t("filter_image")],
    ["document", t("filter_document")],
    ["other", t("filter_other")],
  ];

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        title={t("button")}
        aria-label={t("button")}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <HardDrive className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{t("button")}</span>
      </button>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="flex max-h-[85vh] flex-col border-border bg-popover sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <HardDrive className="h-4 w-4 text-primary" />
              {t("title")}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("description")}
            </DialogDescription>
          </DialogHeader>

          {step === "confirm" ? (
            <div role="alertdialog" className="space-y-4">
              <div className="flex gap-3 rounded-md border border-red-500/40 bg-red-500/10 p-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" aria-hidden />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t("confirmTitle", { count: selected.size })}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("confirmBody", { size: formatBytes(selectedBytes) })}
                  </p>
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="media-confirm" className="text-sm text-foreground">
                  {t("confirmType")}
                </label>
                <Input
                  id="media-confirm"
                  value={typed}
                  autoComplete="off"
                  placeholder="DELETE"
                  onChange={(e) => setTyped(e.target.value)}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={() => setStep("list")}>
                  {t("back")}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy || typed !== "DELETE"}
                  onClick={() => void doDelete()}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  {t("confirmYes")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              {loading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : failed ? (
                <div className="py-8 text-center">
                  <p className="text-sm text-muted-foreground">{t("loadFailed")}</p>
                  <Button className="mt-3" variant="outline" onClick={() => void load()}>
                    {t("retry")}
                  </Button>
                </div>
              ) : items.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t("summary", { count: items.length, size: formatBytes(totalBytes) })}
                    {whatsappHosted > 0 && ` · ${t("whatsappHosted", { count: whatsappHosted })}`}
                  </p>

                  <div className="flex flex-wrap items-center gap-2">
                    {filters.map(([key, label]) => (
                      <Button
                        key={key}
                        type="button"
                        size="sm"
                        variant={filter === key ? "secondary" : "outline"}
                        onClick={() => setFilter(key)}
                      >
                        {label}
                      </Button>
                    ))}
                    <span className="flex-1" />
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelected(new Set(shown.map((i) => i.id)))}
                    >
                      {t("selectAll")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={selected.size === 0}
                      onClick={() => setSelected(new Set())}
                    >
                      {t("clear")}
                    </Button>
                  </div>

                  <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
                    {shown.slice(0, visible).map((i) => (
                      <li key={i.id}>
                        <label
                          className={cn(
                            "flex cursor-pointer items-center gap-3 rounded-md border border-border p-2 hover:bg-muted/50",
                            selected.has(i.id) && "border-primary bg-primary/5",
                          )}
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 shrink-0"
                            checked={selected.has(i.id)}
                            onChange={() => toggle(i.id)}
                          />
                          {i.contentType === "image" ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={i.url}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              className="h-12 w-12 shrink-0 rounded object-cover"
                            />
                          ) : (
                            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-muted">
                              <FileText className="h-5 w-5 text-muted-foreground" />
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-foreground">{i.name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {format(new Date(i.createdAt), "dd MMM yyyy, HH:mm")} ·{" "}
                              {i.bytes != null ? formatBytes(i.bytes) : t("sizeUnknown")}
                            </span>
                          </span>
                          <a
                            href={i.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="shrink-0 text-xs text-primary hover:underline"
                          >
                            {t("view")}
                          </a>
                        </label>
                      </li>
                    ))}
                    {shown.length > visible && (
                      <li className="pt-1 text-center">
                        <Button type="button" size="sm" variant="ghost" onClick={() => setVisible((v) => v + PAGE)}>
                          {t("showMore")}
                        </Button>
                      </li>
                    )}
                  </ul>

                  <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
                    <span className="text-xs text-muted-foreground">
                      {t("selectedSummary", { count: selected.size, size: formatBytes(selectedBytes) })}
                    </span>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={selected.size === 0}
                      onClick={() => setStep("confirm")}
                    >
                      <Trash2 className="h-4 w-4" />
                      {t("deleteSelected", { count: selected.size })}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
