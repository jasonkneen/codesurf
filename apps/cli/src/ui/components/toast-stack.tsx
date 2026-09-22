import type { HostToast } from "../../core/plugins";
import type { Theme } from "../theme";

export function ToastStack({
  t,
  width,
  toasts,
}: {
  t: Theme;
  width: number;
  toasts: Array<HostToast & { id: number }>;
}) {
  if (toasts.length === 0) return null;
  return (
    <box
      position="absolute"
      right={2}
      top={1}
      width={Math.min(60, Math.max(20, width - 4))}
      zIndex={600}
      flexDirection="column"
      gap={1}
      shouldFill={false}
    >
      {toasts.map((toast) => {
        const accent = toast.style === "failure" ? "#ff6b6b" : toast.style === "success" ? "#22c55e" : t.accent;
        const icon = toast.style === "failure" ? "✗" : toast.style === "success" ? "✓" : "•";
        return (
          <box
            key={toast.id}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={t.queueBg}
            flexDirection="column"
            flexShrink={0}
          >
            <text wrapMode="none">
              <span style={{ fg: accent }}>{`${icon} `}</span>
              <span style={{ fg: t.text }}>{toast.title}</span>
            </text>
            {toast.message ? (
              <text wrapMode="none">
                <span style={{ fg: t.textMuted }}>{toast.message}</span>
              </text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}
