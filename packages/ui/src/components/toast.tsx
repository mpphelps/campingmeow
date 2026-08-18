import * as React from "react";
import { Toast as ToastPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";

import { cn } from "@campingmeow/ui/lib/utils";

export type ToastVariant = "default" | "destructive";

export interface ToastMessage {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

// Tiny module-level store so any component (or an ErrorBoundary) can raise a
// toast without threading context through the tree.
let toasts: ToastMessage[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function emit() {
  for (const listener of listeners) listener();
}

export function toast(input: { title: string; description?: string; variant?: ToastVariant }) {
  const message: ToastMessage = {
    id: nextId++,
    title: input.title,
    description: input.description,
    variant: input.variant ?? "default",
  };
  toasts = [...toasts, message];
  emit();
  return message.id;
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: ToastMessage[] = [];

export function Toaster() {
  const messages = React.useSyncExternalStore(
    subscribe,
    () => toasts,
    () => EMPTY,
  );

  return (
    <ToastPrimitive.Provider swipeDirection="right" duration={6000}>
      {messages.map((message) => (
        <ToastPrimitive.Root
          key={message.id}
          data-slot="toast"
          onOpenChange={(open) => {
            if (!open) dismiss(message.id);
          }}
          className={cn(
            "flex items-start gap-3 rounded-lg border bg-background p-4 shadow-lg data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:animate-in data-[state=open]:slide-in-from-right",
            message.variant === "destructive" && "border-destructive/50 bg-destructive/5",
          )}
        >
          <div className="flex-1">
            <ToastPrimitive.Title
              className={cn("text-sm font-medium", message.variant === "destructive" && "text-destructive")}
            >
              {message.title}
            </ToastPrimitive.Title>
            {message.description && (
              <ToastPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                {message.description}
              </ToastPrimitive.Description>
            )}
          </div>
          <ToastPrimitive.Close aria-label="Dismiss" className="text-muted-foreground hover:text-foreground">
            <XIcon className="size-4" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4 sm:max-w-sm" />
    </ToastPrimitive.Provider>
  );
}
