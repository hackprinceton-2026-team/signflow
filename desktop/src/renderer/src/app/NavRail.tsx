import { Icon } from '../ui';
import { shortcutLabel } from '../ui/Kbd';
import { PRIMARY_SCREENS, SCREENS, type ScreenId } from './screens';

function RailItem({ id, active, onSelect }: { id: ScreenId; active: boolean; onSelect: (id: ScreenId) => void }) {
  const meta = SCREENS[id];
  return (
    <button
      type="button"
      className={`rail-item ${active ? 'is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      title={`${meta.label} (${shortcutLabel(meta.shortcut)})`}
      onClick={() => onSelect(id)}
    >
      <span className="rail-item-icon">
        <Icon name={meta.icon} size={20} />
      </span>
      <span className="rail-item-label">{meta.label}</span>
    </button>
  );
}

export function NavRail({ screen, onSelect }: { screen: ScreenId; onSelect: (id: ScreenId) => void }) {
  return (
    <nav className="rail" aria-label="Main">
      <div className="rail-brand">
        <span className="brand-mark" aria-hidden="true">
          <Icon name="hand" size={20} strokeWidth={1.9} />
        </span>
        <h1 className="sr-only">SignFlow</h1>
      </div>
      <ul className="rail-list">
        {PRIMARY_SCREENS.map((id) => (
          <li key={id}>
            <RailItem id={id} active={screen === id} onSelect={onSelect} />
          </li>
        ))}
      </ul>
      <div className="rail-bottom">
        <RailItem id="settings" active={screen === 'settings'} onSelect={onSelect} />
      </div>
    </nav>
  );
}
