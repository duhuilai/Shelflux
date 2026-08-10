// 通用右键菜单（支持级联子菜单）
import { useEffect, useRef, useState, useCallback } from "react";

export interface ContextMenuItem {
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  /** 子菜单项（悬停时向右展开） */
  submenu?: ContextMenuItem[];
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<number | null>(null);

  // 调整位置防止超出视口
  useEffect(() => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let nx = x;
      let ny = y;
      if (x + rect.width > vw) nx = vw - rect.width - 4;
      if (y + rect.height > vh) ny = vh - rect.height - 4;
      ref.current.style.left = `${Math.max(4, nx)}px`;
      ref.current.style.top = `${Math.max(4, ny)}px`;
    }
  }, [x, y]);

  // 点击外部关闭
  useEffect(() => {
    const close = () => onClose();
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [onClose]);

  const handleItemMouseEnter = useCallback((index: number) => {
    const item = items[index];
    if (item.submenu && item.submenu.length > 0) {
      setActiveSubmenu(index);
    } else {
      setActiveSubmenu(null);
    }
  }, [items]);

  const handleItemClick = useCallback((item: ContextMenuItem) => {
    if (item.disabled || item.divider) return;
    if (item.onClick) {
      item.onClick();
      onClose();
    }
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) =>
        item.divider ? (
          <div className="context-menu-divider" key={`d-${i}`} />
        ) : (
          <div
            key={i}
            className={`context-menu-item ${item.danger ? "danger" : ""} ${
              item.disabled ? "disabled" : ""
            } ${item.submenu ? "has-submenu" : ""} ${
              activeSubmenu === i ? "submenu-active" : ""
            }`}
            onClick={() => handleItemClick(item)}
            onMouseEnter={() => handleItemMouseEnter(i)}
          >
            {item.icon && <span className="context-menu-icon">{item.icon}</span>}
            <span className="context-menu-label">{item.label}</span>
            {item.submenu && (
              <>
                <span className="context-menu-arrow">▸</span>
                {/* 子菜单面板 */}
                {activeSubmenu === i && (
                  <div
                    className="context-submenu"
                    onMouseEnter={() => setActiveSubmenu(i)}
                  >
                    {item.submenu?.map((subItem, j) =>
                      subItem.divider ? (
                        <div className="context-menu-divider" key={`sd-${j}`} />
                      ) : (
                        <div
                          key={j}
                          className={`context-menu-item ${subItem.danger ? "danger" : ""} ${
                            subItem.disabled ? "disabled" : ""
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!subItem.disabled && subItem.onClick) {
                              subItem.onClick();
                              onClose();
                            }
                          }}
                        >
                          {subItem.icon && <span className="context-menu-icon">{subItem.icon}</span>}
                          <span>{subItem.label}</span>
                        </div>
                      )
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}
