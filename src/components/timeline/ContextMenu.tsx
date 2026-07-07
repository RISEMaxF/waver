import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface MenuState {
  x: number; // viewport coords (clientX/Y from the contextmenu event)
  y: number;
  items: (MenuItem | "sep")[];
}

/** Lightweight right-click menu (QoL: context menus). Fixed-positioned at the
 *  pointer, clamped to the viewport; closes on outside click, Escape, or item pick.
 *  Escape is captured so the app keymap doesn't also react. */
export function ContextMenu({
  menu,
  onClose,
}: {
  menu: MenuState;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  // Clamp inside the viewport after first paint.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth)
      el.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`;
    if (r.bottom > window.innerHeight)
      el.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
  }, [menu]);

  return (
    <div
      className="ctx-menu"
      role="menu"
      ref={ref}
      style={{ left: menu.x, top: menu.y }}
    >
      {menu.items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`ctx-item${it.danger ? " danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            <span className="ctx-label">{it.label}</span>
            {it.shortcut && <kbd className="ctx-kbd">{it.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
