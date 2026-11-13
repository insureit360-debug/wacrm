"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  KeyboardEvent,
} from "react";
import {
  Send,
  LayoutTemplate,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  Square,
  X,
  Loader2,
  Sparkles,
  Plus,
  MessageSquareDashed,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  MAX_ATTACHMENTS,
  UPLOAD_CONCURRENCY,
  limitToRoom,
  runPool,
  sendInOrder,
} from "@/lib/inbox/attachments";
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { ReplyQuote } from "./reply-quote";
import { useTranslations } from "next-intl";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import { validateInteractivePayload } from "@/lib/whatsapp/interactive";
import type { InteractiveMessagePayload, QuickReply } from "@/types";
import { QuickReplyPicker } from "./quick-reply-picker";

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = "image" | "video" | "document" | "audio";

/** Supabase Storage bucket holding agent-sent chat attachments (migration 023). */
export const CHAT_MEDIA_BUCKET = "chat-media";

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

/** Hard cap on a single voice recording so it can't blow the upload/
 *  transcode limits — auto-stops the recorder when reached. */
const MAX_RECORDING_SECONDS = 5 * 60;

const newDraftId = () =>
  `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  /** Public chat-media URL Meta fetches at send time. */
  mediaUrl: string;
  /** Storage object path — lets the caller GC the object if the send fails. */
  path: string;
  /** Optional caption (image/video/document only). */
  caption?: string;
  /** Original file name — surfaced to the recipient for documents. */
  filename?: string;
  replyToId?: string;
}

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
}

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error. Audio has no picker — it's
// captured via the recorder.
const PICKER_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

interface MediaDraft {
  /** Client-side id: keys the tray and targets caption edits. */
  id: string;
  kind: ComposerMediaKind;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
}

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia: (payload: SendMediaPayload) => void | Promise<void>;
  onSendInteractive: (payload: InteractiveMessagePayload, replyToId?: string) => void;
  onOpenTemplates: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  Meta-accepted format means no server ffmpeg / transcode step. */
const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";

export function MessageComposer({
  conversationId,
  sessionExpired,
  onSend,
  onSendMedia,
  onSendInteractive,
  onOpenTemplates,
  replyTo,
  onClearReply,
}: MessageComposerProps) {
  const t = useTranslations("Inbox.composer");
  const tGate = useTranslations("GatedButton");

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Enter-to-send only on devices with a mouse/keyboard (fine pointer).
  // On touch devices (phones) Enter inserts a newline and the Send button
  // is the only way to send — there's no practical Shift+Enter on a phone,
  // so intercepting Enter there blocks multi-line messages.
  const [enterSends, setEnterSends] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: fine)");
    const apply = () => setEnterSends(mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  // Interactive-message builder dialog + quick-reply picker.
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [interactivePayload, setInteractivePayload] =
    useState<InteractiveMessagePayload>(blankButtonsPayload);
  const [savingQuickReply, setSavingQuickReply] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);

  // Media attachment state. `draft` holds an uploaded-but-not-yet-sent
  // attachment; `busy` covers the upload/transcode window.
  // Several attachments can wait in the tray; `draft` is the one currently
  // shown in the preview (its caption is the one being edited).
  const [drafts, setDrafts] = useState<MediaDraft[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const draft = drafts.find((d) => d.id === activeId) ?? drafts[0] ?? null;
  const [busy, setBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  // Mirror of `draft` for the unmount cleanup, which can't read render
  // state. Kept in sync below so navigating away with a staged-but-unsent
  // attachment GCs the orphaned object.
  const draftsRef = useRef<MediaDraft[]>([]);
  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  // Best-effort GC of a staged object the user never sent. Fire-and-forget.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  // Voice recording state. The recorder encodes Ogg/Opus in-browser
  // (opus-recorder) so there's no server-side transcode.
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const canSend = useCan("send-messages");
  const readOnly = !canSend;
  // Media (like free-form text) is only allowed inside the 24h window.
  const inputsDisabled = readOnly || sessionExpired;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Tear down any live recording + timer on unmount so a mid-record
  // navigation doesn't leak the mic, and GC a staged-but-unsent
  // attachment so it doesn't orphan in the bucket.
  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      // stop() releases the mic stream + audio context inside opus-recorder.
      void recorderRef.current?.stop().catch(() => {});
      draftsRef.current.forEach((d) => removeStaged(d.path));
    };
  }, [clearTimer, removeStaged]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Max 4 lines (~96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || sessionExpired) return;

    setSending(true);
    try {
      onSend(trimmed, replyTo?.id);
      setText("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, sessionExpired, onSend, replyTo?.id]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && enterSends) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, enterSends]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      adjustHeight();
    },
    [adjustHeight]
  );

  // Ask the AI assistant for a suggested reply and drop it into the
  // composer for the agent to edit + send. Read-only server-side —
  // nothing is sent until the agent hits Send.
  const handleDraft = useCallback(async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const res = await fetch("/api/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === "ai_not_configured") {
          toast.error(t("aiNotConfigured"));
        } else {
          toast.error(data.error ?? t("draftFailed"));
        }
        return;
      }
      const draftText = typeof data.draft === "string" ? data.draft.trim() : "";
      if (!draftText) {
        toast.error(t("draftEmpty"));
        return;
      }
      setText(draftText);
      // Let the textarea grow to fit and drop the cursor at the end so
      // the agent can tweak immediately.
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } catch {
      toast.error(t("aiUnreachable"));
    } finally {
      setDrafting(false);
    }
  }, [drafting, conversationId, adjustHeight, t]);

  // ---- Interactive message + quick replies --------------------------

  const openInteractiveBuilder = useCallback(
    (seed?: InteractiveMessagePayload) => {
      setInteractivePayload(seed ?? blankButtonsPayload());
      setInteractiveOpen(true);
    },
    [],
  );

  const sendInteractive = useCallback(() => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onSendInteractive(interactivePayload, replyTo?.id);
    setInteractiveOpen(false);
    onClearReply?.();
  }, [interactivePayload, onSendInteractive, replyTo?.id, onClearReply]);

  // Persist the current builder payload as a reusable interactive snippet.
  const saveAsQuickReply = useCallback(async () => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const title = window
      .prompt(t("quickReplyNamePrompt"))
      ?.trim();
    if (!title) return;
    setSavingQuickReply(true);
    try {
      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          kind: "interactive",
          interactive_payload: interactivePayload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("quickReplySaveError"));
        return;
      }
      toast.success(t("quickReplySaved"));
    } catch {
      toast.error(t("quickReplySaveError"));
    } finally {
      setSavingQuickReply(false);
    }
  }, [interactivePayload, t]);

  // A picked quick reply: text fills the composer; interactive opens the
  // builder pre-filled so the agent can tweak before sending.
  const handlePickQuickReply = useCallback(
    (qr: QuickReply) => {
      setQuickReplyOpen(false);
      if (qr.kind === "interactive" && qr.interactive_payload) {
        openInteractiveBuilder(qr.interactive_payload);
        return;
      }
      const body = qr.content_text ?? "";
      // Separate the snippet from any existing draft with a newline so the
      // words don't run together ("Thanks" + "we'll…" → "Thankswe'll…").
      setText((prev) =>
        prev && !/\s$/.test(prev) ? `${prev}\n${body}` : `${prev}${body}`,
      );
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    },
    [openInteractiveBuilder, adjustHeight],
  );

  // Upload one or more picked files to chat-media and stage them in the tray.
  // Uploads run a few at a time but keep the order the user picked them in.
  const stageFiles = useCallback(
    async (kind: ComposerMediaKind, files: File[]) => {
      if (files.length === 0) return;
      const { accepted, dropped } = limitToRoom(draftsRef.current.length, files);
      if (dropped > 0) toast.error(t("tooManyFiles", { max: MAX_ATTACHMENTS }));
      // Per-kind ceiling mirrors Meta's caps (image 5 MB, etc.) so we reject
      // before upload rather than orphaning an object Meta would refuse.
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      const valid: File[] = [];
      for (const file of accepted) {
        if (file.size > max) {
          toast.error(
            t("fileTooLarge", {
              size: (file.size / 1024 / 1024).toFixed(1),
              kind: t(`mediaKind.${kind}`),
              max: Math.round(max / 1024 / 1024),
            }),
          );
        } else {
          valid.push(file);
        }
      }
      if (valid.length === 0) return;

      setBusy(true);
      setUploadProgress({ done: 0, total: valid.length });
      const results = await runPool(
        valid,
        UPLOAD_CONCURRENCY,
        async (file) => {
          const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
          return { id: newDraftId(), kind, mediaUrl: publicUrl, path, filename: file.name, caption: "" } as MediaDraft;
        },
        (done, total) => setUploadProgress({ done, total }),
      );
      const staged: MediaDraft[] = [];
      let failed = 0;
      let firstError: string | null = null;
      for (const r of results) {
        if (r.ok) staged.push(r.value);
        else {
          failed++;
          if (!firstError && r.error instanceof Error) firstError = r.error.message;
        }
      }
      if (staged.length > 0) {
        setDrafts((prev) => [...prev, ...staged]);
        setActiveId(staged[0].id);
      }
      if (failed > 0) {
        toast.error(valid.length === 1 ? (firstError ?? t("uploadFailed")) : t("someUploadsFailed", { count: failed }));
      }
      setUploadProgress(null);
      setBusy(false);
    },
    [t],
  );

  const handlePicked = useCallback(
    (kind: "image" | "video" | "document", files: FileList | null | undefined) => {
      // Copy NOW: the input is cleared right after, which empties a live FileList.
      const picked = Array.from(files ?? []);
      if (picked.length > 0) void stageFiles(kind, picked);
    },
    [stageFiles],
  );

  // ---- Voice recording (client-side Ogg/Opus, no server transcode) ---

  // The encoded Ogg/Opus file from opus-recorder → upload as an audio
  // draft. WhatsApp renders Ogg/Opus as a playable voice note.
  const finalizeRecording = useCallback(
    async (bytes: Uint8Array) => {
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
      // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
      const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
        type: "audio/ogg",
      });
      if (file.size === 0) return; // cancelled / empty take
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        toast.error(t("recordingTooLong"));
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        const voice: MediaDraft = { id: newDraftId(), kind: "audio", mediaUrl: publicUrl, path, filename: file.name, caption: "" };
        setDrafts((prev) => [...prev, voice]);
        setActiveId(voice.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("uploadFailed"));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const startRecording = useCallback(async () => {
    if (inputsDisabled || busy || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      toast.error(t("recordingUnsupported"));
      return;
    }
    try {
      // Lazy-load the encoder (≈400 KB worker) only when the user records,
      // keeping it out of the main bundle.
      const { default: Recorder } = await import("opus-recorder");
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048, // VOIP — tuned for speech
        encoderSampleRate: 48000,
        streamPages: false, // one callback with the complete file on stop
      });
      cancelledRef.current = false;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        void finalizeRecording(bytes);
      };
      recorderRef.current = recorder;
      await recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      toast.error(t("microphoneDenied"));
    }
  }, [inputsDisabled, busy, recording, finalizeRecording, t]);

  const stopRecording = useCallback(() => {
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  // Auto-stop at the cap so a forgotten recording can't blow the
  // upload size limit.
  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [recording, recordSeconds, stopRecording]);

  // ---- Draft send / discard -----------------------------------------

  const sendDrafts = useCallback(async () => {
    if (drafts.length === 0 || busy) return;
    const batch = drafts;
    const replyToId = replyTo?.id;
    // The objects are now owned by the sent messages — clear without GC.
    setDrafts([]);
    setActiveId(null);
    onClearReply?.();
    // One message per file, in the order picked; the reply quote goes on the first.
    await sendInOrder(batch, (d, i) =>
      onSendMedia({
        kind: d.kind,
        mediaUrl: d.mediaUrl,
        path: d.path,
        // Audio takes no caption (Meta rejects it). Everything else: the
        // trimmed caption, or undefined when blank.
        caption: d.kind === "audio" ? undefined : d.caption.trim() || undefined,
        filename: d.kind === "document" ? d.filename : undefined,
        replyToId: i === 0 ? replyToId : undefined,
      }),
    );
  }, [drafts, busy, onSendMedia, replyTo?.id, onClearReply]);

  // Discard GCs the staged object — it was uploaded but never sent.
  const discardDraft = useCallback(() => {
    if (!draft) return;
    removeStaged(draft.path);
    setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
    setActiveId(null);
  }, [draft, removeStaged]);

  const clearAllDrafts = useCallback(() => {
    draftsRef.current.forEach((d) => removeStaged(d.path));
    setDrafts([]);
    setActiveId(null);
  }, [removeStaged]);

  const activeDraftId = draft?.id;
  const setCaption = useCallback(
    (caption: string) => {
      setDrafts((prev) => prev.map((d) => (d.id === activeDraftId ? { ...d, caption } : d)));
    },
    [activeDraftId],
  );

  // ---- Render --------------------------------------------------------

  return (
    <div className="border-t border-border bg-card p-3">
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}
      {sessionExpired && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">
            {t("sessionExpiredHint")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-400 hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            {t("templates")}
          </Button>
        </div>
      )}

      {/* Hidden file inputs driven by the attach menu. */}
      <input
        ref={imageInputRef}
        type="file"
        accept={PICKER_ACCEPT.image}
        multiple
        className="hidden"
        onChange={(e) => {
          handlePicked("image", e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept={PICKER_ACCEPT.video}
        multiple
        className="hidden"
        onChange={(e) => {
          handlePicked("video", e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={PICKER_ACCEPT.document}
        multiple
        className="hidden"
        onChange={(e) => {
          handlePicked("document", e.target.files);
          e.target.value = "";
        }}
      />

      {uploadProgress && (
        <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("uploadingProgress", { done: uploadProgress.done, total: uploadProgress.total })}
        </p>
      )}

      {draft ? (
        <div className="space-y-2">
          {drafts.length > 1 && (
            <MediaDraftStrip
              drafts={drafts}
              activeId={draft.id}
              onSelect={setActiveId}
              onClearAll={clearAllDrafts}
              t={t}
            />
          )}
          <MediaDraftPreview
            draft={draft}
            count={drafts.length}
            busy={busy}
            readOnly={readOnly}
            onCaptionChange={setCaption}
            onDiscard={discardDraft}
            onSend={sendDrafts}
            t={t}
          />
        </div>
      ) : recording ? (
        // Recording bar — replaces the composer while the mic is live.
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted px-4 py-2.5">
          <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
          <span className="flex-1 text-sm text-foreground">
            {t("recording", { current: formatDuration(recordSeconds), max: formatDuration(MAX_RECORDING_SECONDS) })}
          </span>
          <button
            type="button"
            onClick={cancelRecording}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-card hover:text-foreground"
          >
            {t("cancel")}
          </button>
          <Button
            size="sm"
            onClick={stopRecording}
            className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90"
            title={t("stopAndAttach")}
          >
            <Square className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          {/* Action buttons. On mobile this group wraps to its own row
              below the textarea (basis-full + order-2) so the input gets
              the full width; on sm+ it sits inline before the textarea. */}
          <div className="order-2 flex basis-full items-end gap-2 sm:order-1 sm:basis-auto">
          {/* Attach menu — photo / video / document / voice. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled || busy}
              title={
                readOnly
                  ? t("readOnlyTitle")
                  : inputsDisabled
                    ? undefined
                    : t("attachMedia")
              }
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover">
              <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                <ImageIcon className="mr-2 h-4 w-4" />
                {t("photo")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                <Video className="mr-2 h-4 w-4" />
                {t("video")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => documentInputRef.current?.click()}>
                <FileText className="mr-2 h-4 w-4" />
                {t("document")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void startRecording()}>
                <Mic className="mr-2 h-4 w-4" />
                {t("voiceNote")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* + menu — interactive messages + quick replies. Gated on the
              24h window like free-form text (interactive requires it). */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled}
              title={
                readOnly
                  ? t("readOnlyTitle")
                  : inputsDisabled
                    ? undefined
                    : t("moreActions")
              }
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover">
              <DropdownMenuItem onClick={() => openInteractiveBuilder()}>
                <MessageSquareDashed className="mr-2 h-4 w-4" />
                {t("interactiveMessage")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setQuickReplyOpen(true)}>
                <Zap className="mr-2 h-4 w-4" />
                {t("quickReplies")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason={tGate("reasons.sendMessages")}
            title={readOnly ? undefined : t("sendTemplate")}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-foreground"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="h-4 w-4" />
          </GatedButton>

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason={tGate("reasons.sendMessages")}
            disabled={drafting}
            title={readOnly ? undefined : t("draftWithAI")}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-primary"
            onClick={handleDraft}
          >
            {drafting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
          </GatedButton>
          </div>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              readOnly
                ? t("readOnlyPlaceholder")
                : sessionExpired
                  ? t("sessionExpiredPlaceholder")
                  : t("typeMessagePlaceholder")
            }
            disabled={sessionExpired || readOnly}
            rows={1}
            // Textarea keeps its own inline title — the GatedButton
            // wrapping pattern doesn't apply to non-button inputs.
            // The placeholder text also surfaces the read-only state.
            title={readOnly ? t("readOnlyTitle") : undefined}
            className={cn(
              "order-1 min-w-0 flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50 sm:order-2",
              (sessionExpired || readOnly) && "cursor-not-allowed opacity-50"
            )}
          />

          <GatedButton
            size="sm"
            canAct={!readOnly}
            gateReason={tGate("reasons.sendMessages")}
            disabled={!text.trim() || sessionExpired || sending}
            onClick={handleSend}
            className="order-1 h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40 sm:order-3"
          >
            <Send className="h-4 w-4" />
          </GatedButton>
        </div>
      )}

      {/* Hint sits outside the flex row so its height doesn't push
          `items-end` buttons below the textarea. Indented to line up
          under the textarea left edge. */}
      {drafts.length === 0 && !recording && (
        <p className="mt-1 pl-1 text-[10px] text-muted-foreground sm:pl-[5.5rem]">
          {t("draftHint")}
        </p>
      )}

      {/* Interactive-message builder dialog. */}
      <Dialog open={interactiveOpen} onOpenChange={setInteractiveOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("interactiveMessage")}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto">
            <InteractiveBuilder
              value={interactivePayload}
              onChange={setInteractivePayload}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={savingQuickReply}
              onClick={saveAsQuickReply}
            >
              {savingQuickReply ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Zap className="mr-1 h-4 w-4" />
              )}
              {t("saveAsQuickReply")}
            </Button>
            <Button onClick={sendInteractive}>
              <Send className="mr-1 h-4 w-4" />
              {t("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick-reply picker. */}
      <QuickReplyPicker
        open={quickReplyOpen}
        onOpenChange={setQuickReplyOpen}
        onPick={handlePickQuickReply}
      />
    </div>
  );
}

/**
 * Thumbnails of every staged attachment. Tap one to preview it and edit its
 * caption; "Remove all" empties the tray.
 */
function MediaDraftStrip({
  drafts,
  activeId,
  onSelect,
  onClearAll,
  t,
}: {
  drafts: MediaDraft[];
  activeId: string;
  onSelect: (id: string) => void;
  onClearAll: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto py-1">
        {drafts.map((d, i) => (
          <button
            key={d.id}
            type="button"
            onClick={() => onSelect(d.id)}
            aria-label={t("attachmentN", { n: i + 1 })}
            aria-current={d.id === activeId}
            className={cn(
              "relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted",
              d.id === activeId ? "border-primary ring-2 ring-primary/40" : "border-border",
            )}
          >
            {d.kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={d.mediaUrl} alt="" className="h-full w-full object-cover" />
            ) : d.kind === "video" ? (
              <video src={d.mediaUrl} className="h-full w-full object-cover" muted />
            ) : (
              <FileText className="h-5 w-5 text-muted-foreground" />
            )}
            <span className="absolute bottom-0 right-0 rounded-tl bg-black/60 px-1 text-[10px] text-white">
              {i + 1}
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onClearAll}
        className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
      >
        {t("removeAll")}
      </button>
    </div>
  );
}

/**
 * Staged-attachment preview with caption + send/discard. Declared at
 * module scope (not nested in MessageComposer) so React keeps it mounted
 * across the parent's re-renders — a nested component would remount the
 * caption input on every keystroke and drop focus.
 */
function MediaDraftPreview({
  draft,
  count,
  busy,
  readOnly,
  onCaptionChange,
  onDiscard,
  onSend,
  t,
}: {
  draft: MediaDraft;
  /** How many attachments will be sent together. */
  count: number;
  busy: boolean;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const tGate = useTranslations("GatedButton");
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {draft.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === "video" && (
            <video src={draft.mediaUrl} controls className="max-h-40 rounded-lg" />
          )}
          {draft.kind === "audio" && (
            <audio src={draft.mediaUrl} controls className="w-full" />
          )}
          {draft.kind === "document" && (
            <div className="flex items-center gap-2 text-sm text-foreground">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">{draft.filename}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label={t("removeAttachment")}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex items-end gap-2">
        {draft.kind !== "audio" && (
          <input
            value={draft.caption}
            maxLength={MEDIA_CAPTION_MAX}
            onChange={(e) => onCaptionChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={t("addCaption")}
            className="flex-1 rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50"
          />
        )}
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason={tGate("reasons.sendMessages")}
          disabled={busy}
          onClick={onSend}
          aria-label={count > 1 ? t("sendCount", { count }) : undefined}
          className={cn(
            "h-9 shrink-0 bg-primary hover:bg-primary/90 disabled:opacity-40",
            count > 1 ? "gap-1 px-3" : "w-9 p-0",
            draft.kind === "audio" && "ml-auto",
          )}
        >
          <Send className="h-4 w-4" />
          {count > 1 && <span className="text-xs font-medium">{count}</span>}
        </GatedButton>
      </div>
    </div>
  );
}
