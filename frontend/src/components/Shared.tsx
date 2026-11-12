import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { BRAND } from "../config/brand";

export function Brand({ onClick, label = BRAND.short }: { onClick?: () => void; label?: string }) {
  return (
    <a
      className="brand"
      href="/"
      onClick={(event) => {
        if (onClick) {
          event.preventDefault();
          onClick();
          return;
        }
        if (location.pathname === "/") {
          event.preventDefault();
          history.replaceState(null, "", "/");
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      }}
      aria-label={`${BRAND.name} home`}
    >
      <Icon name="chip" size={29} />
      <span>
        {label}
        <span className="brand-period">.</span>
      </span>
    </a>
  );
}

export function Cursor() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      el.style.transform = `translate3d(${e.clientX}px,${e.clientY}px,0)`;
      el.classList.toggle(
        "cursor-over-control",
        Boolean(
          (e.target as Element).closest("button,a,input,textarea,select"),
        ),
      );
      el.classList.add("cursor-visible");
    };
    const leave = () => ref.current?.classList.remove("cursor-visible");
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.removeEventListener("pointerleave", leave);
    };
  }, []);
  return (
    <div ref={ref} className="custom-cursor" aria-hidden="true">
      <i />
      <span />
    </div>
  );
}

export function Sheet({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null,
      element = ref.current;
    element?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      // A business dialog can open over Saved. Let the top native dialog own
      // Escape and focus trapping; keep the saved list and its scroll position.
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && element) {
        const nodes = [
            ...element.querySelectorAll<HTMLElement>(
              'button,a[href],input,select,textarea,[tabindex="0"]',
            ),
          ].filter((x) => !x.hasAttribute("disabled")),
          first = nodes[0],
          last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        className="side-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-heading"
      >
        <header>
          <h2 id="sheet-heading">{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close panel"
          >
            <Icon name="close" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
