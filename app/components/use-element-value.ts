import { useEffect, useRef, useState } from "react";

/**
 * The live value of a Polaris field (e.g. an s-select), for showing fields
 * that depend on it. React 18 doesn't wire onChange for custom elements, so
 * this listens for the element's own change/input events.
 */
export function useElementValue<T extends HTMLElement & { value?: unknown }>(initial: string) {
  const ref = useRef<T>(null);
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setValue(String(element.value ?? ""));
    element.addEventListener("change", update);
    element.addEventListener("input", update);
    return () => {
      element.removeEventListener("change", update);
      element.removeEventListener("input", update);
    };
  }, []);
  return [ref, value] as const;
}
