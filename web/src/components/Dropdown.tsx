import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from './ui';

export interface DropdownOption {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
}

export function Dropdown({
  value,
  options,
  onChange,
  placeholder,
  icon,
  className,
  align = 'left',
  ariaLabel,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: ReactNode;
  icon?: ReactNode;
  className?: string;
  align?: 'left' | 'right';
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex(o => o.value === value)));
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, options, value]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return setOpen(false);
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      return setOpen(true);
    }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (options[active]) pick(options[active].value); }
  };

  return (
    <div ref={rootRef} className={cx('dropdown', open && 'is-open', className)} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(v => !v)}
      >
        {icon && <span className="dropdown-icon">{icon}</span>}
        <span className="dropdown-value">{current?.label ?? placeholder}</span>
        <ChevronDown size={13} className="dropdown-caret" aria-hidden="true" />
      </button>
      {open && (
        <ul className={cx('dropdown-menu', align === 'right' && 'align-right')} role="listbox">
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={cx(o.value === value && 'selected', i === active && 'active')}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o.value)}
            >
              <span className="dropdown-check">{o.value === value && <Check size={13} strokeWidth={2.5} />}</span>
              <span className="flex-1">{o.label}</span>
              {o.hint != null && <span className="dropdown-hint">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
