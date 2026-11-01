import type { ReactNode } from "react";

/** Tooltips with more than a line of text. An element with
 * `data-tip-rich="<key>"` shows the element registered under that key; its
 * `data-tip` stays as the plain text (and is what makes it hoverable). */
export const richTips = new Map<string, ReactNode>();

export function registerRichTip(key: string, content: ReactNode): () => void {
  richTips.set(key, content);
  return () => {
    if (richTips.get(key) === content) richTips.delete(key);
  };
}
