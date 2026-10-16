import { useEffect } from "react";

const SUBMIT_ON_ENTER = [
  "S-SEARCH-FIELD", "S-TEXT-FIELD", "S-EMAIL-FIELD", "S-NUMBER-FIELD", "S-MONEY-FIELD", "S-URL-FIELD",
];

/**
 * Polaris fields render their input in a shadow root, so Enter doesn't submit
 * the form natively (e.g. the search boxes). Do it here (Rails layout script).
 */
export function SubmitOnEnter() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (!target || !SUBMIT_ON_ENTER.includes(target.tagName)) return;
      const form = target.closest("form");
      if (!form) return;
      event.preventDefault();
      form.requestSubmit();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return null;
}
