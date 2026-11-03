"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

type Confirmation = { title: string; description: string; details: string[]; confirmLabel: string };

export function useConfirmation() {
  const [message, setMessage] = useState<Confirmation | null>(null);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);
  const confirm = useCallback((next: Confirmation) => {
    if (resolver.current) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      resolver.current = resolve;
      setMessage(next);
    });
  }, []);
  const finish = (confirmed: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setMessage(null);
    resolve?.(confirmed);
  };
  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);

  const confirmationDialog = (
    <Dialog open={!!message} onOpenChange={open => { if (!open) finish(false); }}>
      <DialogContent className="min-w-0 grid-cols-[minmax(0,1fr)] max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="min-w-0 break-words pr-8">{message?.title}</DialogTitle>
          <DialogDescription className="min-w-0 break-words">{message?.description}</DialogDescription>
        </DialogHeader>
        <ul className="min-w-0 max-h-60 overflow-y-auto space-y-2 rounded-lg bg-muted p-3 text-sm [overflow-wrap:anywhere]">
          {message?.details.map((detail, index) => <li key={index} className="min-w-0">{detail}</li>)}
        </ul>
        <DialogFooter className="grid min-w-0 grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)]">
          <Button type="button" variant="outline" className="min-h-11" autoFocus onClick={() => finish(false)}>돌아가기</Button>
          <Button type="button" className="h-auto min-h-11 min-w-0 w-full whitespace-normal py-2 [overflow-wrap:anywhere]" onClick={() => finish(true)}>{message?.confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { confirm, confirmationDialog };
}
