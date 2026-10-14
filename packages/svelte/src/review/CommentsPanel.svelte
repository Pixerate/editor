<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import {
    formatReviewTime,
    getCommentAuthor,
    type CommentStore,
    type CommentThread,
    type ReviewAuthor,
  } from "@pixerate/editor";
  import { createComments, type SvelteComments } from "./review.svelte.js";

  interface Props {
    editor?: Editor | null;
    /** Defaults to the store of the editor's `Comments` extension. */
    store?: CommentStore;
    /** Author of replies. Defaults to the `Comments` extension's author. */
    author?: ReviewAuthor;
    /** Initially show resolved threads. */
    showResolved?: boolean;
    class?: string;
    formatTime?: (timestamp: number) => string;
    emptyMessage?: string;
  }

  let {
    editor = null,
    store: storeProp = undefined,
    author: authorProp = undefined,
    showResolved: showResolvedInitial = false,
    class: className = "flex flex-col gap-2 text-sm text-foreground",
    formatTime = (t: number) => formatReviewTime(t),
    emptyMessage = "No comments yet. Select text and add a comment.",
  }: Props = $props();

  const buttonClass =
    "rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50";
  const primaryButtonClass =
    "rounded px-2 py-1 text-xs bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50";
  const textareaClass =
    "w-full resize-y rounded-md border border-input bg-background p-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary";

  // svelte-ignore state_referenced_locally
  let showResolved = $state(showResolvedInitial);
  let drafts = $state<Record<string, string>>({});
  let comments = $state.raw<SvelteComments>(createComments(null));

  $effect(() => {
    const c = createComments(storeProp ?? editor);
    comments = c;
    return () => c.destroy();
  });

  let author = $derived(
    authorProp ?? getCommentAuthor(editor) ?? { id: "anonymous", name: "Anonymous" },
  );
  let threads = $derived(comments.threads);
  let visible = $derived(threads.filter((t) => showResolved || !t.resolved));
  let resolvedCount = $derived(threads.filter((t) => t.resolved).length);

  const live = () => (editor && !editor.isDestroyed ? editor : null);

  function focus(thread: CommentThread) {
    if (thread.id === comments.activeThreadId) return;
    const e = live();
    if (e && !thread.orphaned) e.commands.focusComment(thread.id);
    else comments.store?.setActiveThread(thread.id);
  }

  function remove(thread: CommentThread) {
    const e = live();
    if (e) e.commands.deleteComment(thread.id);
    else comments.store?.deleteThread(thread.id);
  }

  function setResolved(thread: CommentThread, resolved: boolean) {
    const e = live();
    if (e) e.commands.resolveComment(thread.id, resolved);
    else comments.store?.resolveThread(thread.id, resolved, author);
  }

  function submit(thread: CommentThread) {
    const body = (drafts[thread.id] ?? "").trim();
    const store = comments.store;
    if (!body || !store) return;
    if (thread.body === "") store.editComment(thread.id, body);
    else store.addReply(thread.id, { body, author });
    drafts[thread.id] = "";
  }

  function onCardKeydown(event: KeyboardEvent, thread: CommentThread) {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      focus(thread);
    }
  }

  function onTextareaKeydown(event: KeyboardEvent, thread: CommentThread) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit(thread);
    }
  }
</script>

<aside class={className} aria-label="Comments">
  <div class="flex items-center justify-between gap-2">
    <span class="text-xs font-medium text-muted-foreground">
      {threads.length - resolvedCount} open{resolvedCount > 0 ? ` · ${resolvedCount} resolved` : ""}
    </span>
    {#if resolvedCount > 0}
      <button
        type="button"
        class={buttonClass}
        aria-pressed={showResolved}
        onclick={() => (showResolved = !showResolved)}
      >
        {showResolved ? "Hide resolved" : "Show resolved"}
      </button>
    {/if}
  </div>
  {#if visible.length === 0}
    <p class="text-xs text-muted-foreground">{emptyMessage}</p>
  {:else}
    <ul class="flex flex-col gap-2" role="list">
      {#each visible as thread (thread.id)}
        {@const active = thread.id === comments.activeThreadId}
        {@const isDraft = thread.body === ""}
        {@const quote = thread.anchor?.quote ?? thread.lastQuote ?? ""}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <li
          class={`flex flex-col gap-2 rounded-md border bg-background p-3 cursor-pointer ${
            active ? "border-primary ring-1 ring-primary" : "border-border"
          } ${thread.resolved ? "opacity-70" : ""}`}
          data-thread-id={thread.id}
          data-active={active || undefined}
          aria-current={active || undefined}
          tabindex="0"
          onclick={() => focus(thread)}
          onkeydown={(e) => onCardKeydown(e, thread)}
        >
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-medium">{thread.author.name}</span>
            <span class="text-xs text-muted-foreground">{formatTime(thread.createdAt)}</span>
          </div>
          {#if quote}
            <blockquote class="border-l-2 border-border pl-2 text-xs text-muted-foreground line-clamp-2">
              {quote}
            </blockquote>
          {/if}
          {#if thread.orphaned}
            <span class="text-xs text-destructive">The commented text was deleted.</span>
          {/if}
          {#if thread.resolved}
            <span class="text-xs text-muted-foreground">Resolved</span>
          {/if}
          {#if !isDraft}
            <p class="whitespace-pre-wrap break-words">{thread.body}</p>
          {/if}
          {#if thread.replies.length > 0}
            <ul class="flex flex-col gap-2 border-l border-border pl-3" role="list">
              {#each thread.replies as reply (reply.id)}
                <li class="flex flex-col gap-0.5" data-reply-id={reply.id}>
                  <span class="text-xs">
                    <span class="font-medium">{reply.author.name}</span>
                    <span class="text-muted-foreground">{formatTime(reply.createdAt)}</span>
                  </span>
                  <p class="whitespace-pre-wrap break-words">{reply.body}</p>
                </li>
              {/each}
            </ul>
          {/if}
          {#if (active || isDraft) && !thread.resolved}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="flex flex-col gap-1" onclick={(e) => e.stopPropagation()}>
              <!-- svelte-ignore a11y_autofocus -->
              <textarea
                class={textareaClass}
                rows="2"
                aria-label={isDraft ? "Comment" : "Reply"}
                placeholder={isDraft ? "Add a comment…" : "Reply…"}
                autofocus={isDraft}
                value={drafts[thread.id] ?? ""}
                oninput={(e) => (drafts[thread.id] = e.currentTarget.value)}
                onkeydown={(e) => onTextareaKeydown(e, thread)}
              ></textarea>
              <div class="flex justify-end gap-1">
                {#if isDraft}
                  <button type="button" class={buttonClass} onclick={() => remove(thread)}>
                    Cancel
                  </button>
                {/if}
                <button
                  type="button"
                  class={primaryButtonClass}
                  disabled={!(drafts[thread.id] ?? "").trim()}
                  onclick={() => submit(thread)}
                >
                  {isDraft ? "Comment" : "Reply"}
                </button>
              </div>
            </div>
          {/if}
          {#if !isDraft}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="flex justify-end gap-1" onclick={(e) => e.stopPropagation()}>
              <button
                type="button"
                class={buttonClass}
                onclick={() => setResolved(thread, !thread.resolved)}
              >
                {thread.resolved ? "Reopen" : "Resolve"}
              </button>
              <button
                type="button"
                class={`${buttonClass} hover:text-destructive`}
                onclick={() => remove(thread)}
              >
                Delete
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</aside>
