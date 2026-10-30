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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{message?.title}</DialogTitle>
          <DialogDescription>{message?.description}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-60 overflow-y-auto space-y-2 rounded-lg bg-muted p-3 text-sm">
          {message?.details.map((detail, index) => <li key={index}>{detail}</li>)}
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" autoFocus onClick={() => finish(false)}>돌아가기</Button>
          <Button type="button" onClick={() => finish(true)}>{message?.confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { confirm, confirmationDialog };
}
