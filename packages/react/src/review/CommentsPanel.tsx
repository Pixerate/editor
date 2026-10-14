import React, { useState } from "react";
import type { Editor } from "@tiptap/core";
import {
  formatReviewTime,
  getCommentAuthor,
  type CommentStore,
  type CommentThread,
  type ReviewAuthor,
} from "@pixerate/editor";
import { useComments } from "./useReview";

export interface CommentsPanelProps {
  editor: Editor | null;
  /** Defaults to the store of the editor's `Comments` extension. */
  store?: CommentStore;
  /** Author of replies. Defaults to the `Comments` extension's author. */
  author?: ReviewAuthor;
  /** Initially show resolved threads. */
  showResolved?: boolean;
  className?: string;
  formatTime?: (timestamp: number) => string;
  emptyMessage?: string;
}

const buttonClass =
  "rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50";
const primaryButtonClass =
  "rounded px-2 py-1 text-xs bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50";
const textareaClass =
  "w-full resize-y rounded-md border border-input bg-background p-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary";

/**
 * Lists comment threads with reply, resolve and delete actions. Clicking a
 * thread selects its text in the editor. Threads with an empty body are
 * drafts (e.g. created by `CommentButton`) and show a compose box.
 */
export const CommentsPanel: React.FC<CommentsPanelProps> = ({
  editor,
  store: storeProp,
  author: authorProp,
  showResolved: showResolvedInitial = false,
  className = "flex flex-col gap-2 text-sm text-foreground",
  formatTime = (t) => formatReviewTime(t),
  emptyMessage = "No comments yet. Select text and add a comment.",
}) => {
  const { threads, activeThreadId, store } = useComments(storeProp ?? editor);
  const [showResolved, setShowResolved] = useState(showResolvedInitial);
  const author = authorProp ?? getCommentAuthor(editor) ?? { id: "anonymous", name: "Anonymous" };

  const visible = threads.filter((t) => showResolved || !t.resolved);
  const resolvedCount = threads.filter((t) => t.resolved).length;

  return (
    <aside className={className} aria-label="Comments">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {threads.length - resolvedCount} open
          {resolvedCount > 0 ? ` · ${resolvedCount} resolved` : ""}
        </span>
        {resolvedCount > 0 && (
          <button
            type="button"
            className={buttonClass}
            aria-pressed={showResolved}
            onClick={() => setShowResolved((v) => !v)}
          >
            {showResolved ? "Hide resolved" : "Show resolved"}
          </button>
        )}
      </div>
      {visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="flex flex-col gap-2" role="list">
          {visible.map((thread) => (
            <CommentThreadCard
              key={thread.id}
              thread={thread}
              active={thread.id === activeThreadId}
              editor={editor}
              store={store}
              author={author}
              formatTime={formatTime}
            />
          ))}
        </ul>
      )}
    </aside>
  );
};

interface CommentThreadCardProps {
  thread: CommentThread;
  active: boolean;
  editor: Editor | null;
  store: CommentStore | null;
  author: ReviewAuthor;
  formatTime: (timestamp: number) => string;
}

const CommentThreadCard: React.FC<CommentThreadCardProps> = ({
  thread,
  active,
  editor,
  store,
  author,
  formatTime,
}) => {
  const [draft, setDraft] = useState("");
  const isDraft = thread.body === "";
  const quote = thread.anchor?.quote ?? thread.lastQuote ?? "";
  const live = editor && !editor.isDestroyed ? editor : null;

  const focus = () => {
    if (!active) {
      if (live && !thread.orphaned) live.commands.focusComment(thread.id);
      else store?.setActiveThread(thread.id);
    }
  };
  const remove = () => {
    if (live) live.commands.deleteComment(thread.id);
    else store?.deleteThread(thread.id);
  };
  const setResolved = (resolved: boolean) => {
    if (live) live.commands.resolveComment(thread.id, resolved);
    else store?.resolveThread(thread.id, resolved, author);
  };
  const submit = () => {
    const body = draft.trim();
    if (!body || !store) return;
    if (isDraft) store.editComment(thread.id, body);
    else store.addReply(thread.id, { body, author });
    setDraft("");
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <li
      className={`flex flex-col gap-2 rounded-md border bg-background p-3 cursor-pointer ${
        active ? "border-primary ring-1 ring-primary" : "border-border"
      } ${thread.resolved ? "opacity-70" : ""}`}
      data-thread-id={thread.id}
      data-active={active || undefined}
      aria-current={active || undefined}
      tabIndex={0}
      onClick={focus}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          focus();
        }
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{thread.author.name}</span>
        <span className="text-xs text-muted-foreground">{formatTime(thread.createdAt)}</span>
      </div>
      {quote && (
        <blockquote className="border-l-2 border-border pl-2 text-xs text-muted-foreground line-clamp-2">
          {quote}
        </blockquote>
      )}
      {thread.orphaned && (
        <span className="text-xs text-destructive">The commented text was deleted.</span>
      )}
      {thread.resolved && <span className="text-xs text-muted-foreground">Resolved</span>}
      {!isDraft && <p className="whitespace-pre-wrap break-words">{thread.body}</p>}
      {thread.replies.length > 0 && (
        <ul className="flex flex-col gap-2 border-l border-border pl-3" role="list">
          {thread.replies.map((reply) => (
            <li key={reply.id} className="flex flex-col gap-0.5" data-reply-id={reply.id}>
              <span className="text-xs">
                <span className="font-medium">{reply.author.name}</span>{" "}
                <span className="text-muted-foreground">{formatTime(reply.createdAt)}</span>
              </span>
              <p className="whitespace-pre-wrap break-words">{reply.body}</p>
            </li>
          ))}
        </ul>
      )}
      {(active || isDraft) && !thread.resolved && (
        <div className="flex flex-col gap-1" onClick={stop}>
          <textarea
            className={textareaClass}
            rows={2}
            value={draft}
            aria-label={isDraft ? "Comment" : "Reply"}
            placeholder={isDraft ? "Add a comment…" : "Reply…"}
            autoFocus={isDraft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex justify-end gap-1">
            {isDraft && (
              <button type="button" className={buttonClass} onClick={remove}>
                Cancel
              </button>
            )}
            <button
              type="button"
              className={primaryButtonClass}
              disabled={!draft.trim()}
              onClick={submit}
            >
              {isDraft ? "Comment" : "Reply"}
            </button>
          </div>
        </div>
      )}
      {!isDraft && (
        <div className="flex justify-end gap-1" onClick={stop}>
          <button type="button" className={buttonClass} onClick={() => setResolved(!thread.resolved)}>
            {thread.resolved ? "Reopen" : "Resolve"}
          </button>
          <button
            type="button"
            className={`${buttonClass} hover:text-destructive`}
            onClick={remove}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
};
