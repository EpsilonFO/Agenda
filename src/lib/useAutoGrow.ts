"use client";

import { useEffect, type RefObject } from "react";

/**
 * Fait grandir un `<textarea rows={1}>` avec son contenu, jusqu'au `max-height`
 * posé en CSS (au-delà, il défile). Sans ça, un message de trois lignes se
 * lit à travers une fente d'une ligne — illisible dès qu'on dépasse une phrase.
 *
 * Recalculé à chaque changement de valeur : `height: auto` d'abord pour que le
 * textarea puisse aussi RÉTRÉCIR quand on efface.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement>, value: string): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}
