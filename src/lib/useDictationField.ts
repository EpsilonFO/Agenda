"use client";

import { Dispatch, SetStateAction, useCallback, useRef, useState } from "react";

/**
 * Colle la dictée en direct sur un champ texte contrôlé.
 *
 * Le texte provisoire n'est jamais écrit dans l'état du champ : il est
 * seulement affiché à la suite via `preview()`. Quand le moteur fige un
 * segment, celui-ci est ajouté pour de bon. Résultat : les mots apparaissent
 * au fil de la parole, et un envoi ne part jamais avec du provisoire à moitié
 * reconnu (on valide le reste à l'arrêt du micro).
 *
 * Usage :
 *   const mic = useDictationField(chat.setInput);
 *   <MicButton onText={mic.onText} onInterim={mic.onInterim} />
 *   <textarea value={mic.preview(chat.input)}
 *             onChange={(e) => mic.onChange(e.target.value)} />
 */
export function useDictationField(setInput: Dispatch<SetStateAction<string>>) {
  const [interim, setInterim] = useState("");
  // Le provisoire déjà absorbé par une frappe manuelle ne doit pas être
  // ré-ajouté quand le moteur le fige juste après.
  const absorbedRef = useRef(false);

  const onInterim = useCallback((text: string) => {
    absorbedRef.current = false;
    setInterim(text);
  }, []);

  const onText = useCallback(
    (text: string) => {
      setInterim("");
      if (absorbedRef.current) {
        absorbedRef.current = false;
        return;
      }
      setInput((prev) => (prev ? `${prev} ${text}` : text));
    },
    [setInput]
  );

  /** Valeur à afficher : le champ, suivi du texte encore provisoire. */
  const preview = useCallback(
    (value: string) =>
      interim ? (value ? `${value} ${interim}` : interim) : value,
    [interim]
  );

  /**
   * Texte visible, à envoyer tel quel : le champ plus le provisoire, qui est
   * alors consommé (le moteur peut encore le figer après coup, on l'ignorera).
   */
  const flush = useCallback(
    (value: string) => {
      if (!interim) return value;
      absorbedRef.current = true;
      setInterim("");
      return value ? `${value} ${interim}` : interim;
    },
    [interim]
  );

  /** À brancher sur onChange : la frappe englobe le provisoire affiché. */
  const onChange = useCallback(
    (value: string) => {
      setInterim((current) => {
        if (current) absorbedRef.current = true;
        return "";
      });
      setInput(value);
    },
    [setInput]
  );

  return {
    onText,
    onInterim,
    onChange,
    preview,
    flush,
    dictating: interim.length > 0,
  };
}
