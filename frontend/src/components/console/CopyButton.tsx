import { useState } from "react";
import { Icon } from "../Icon";

export default function CopyButton({ text, label = "Copy", compact = false }: { text: string; label?: string; compact?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`copy-button${compact ? " is-compact" : ""}`}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          },
          () => setDone(false),
        );
      }}
      aria-label={text.length > 64 ? label : `${label}: ${text}`}
      title={label}
    >
      <Icon name={done ? "check" : "copy"} size={13} />
      {!compact && <span>{done ? "Copied" : label}</span>}
    </button>
  );
}

export function CodeBox({ code, copy = true }: { code: string; copy?: boolean }) {
  return (
    <div className="code-box">
      <pre className="code" tabIndex={0}>{code}</pre>
      {copy && <CopyButton text={code} />}
    </div>
  );
}
