import { useRef, useState, type ReactNode } from 'react';
import { CAPTION_LIMITS } from '@shared/captions';
import { CONTRACT_GENERATED, CONTRACT_OPENAPI_VERSION } from '../contract';
import { useSignFlow } from '../app/useSignFlow';
import { SpeechSettings } from '../components/SpeechSettings';
import { SETTINGS_LIMITS } from '../state/session';
import { SHORTCUTS } from '../app/shortcuts';
import { Button, formatPercent, Icon, Kbd, RangeField, SelectField, StatusPill, Switch, type IconName } from '../ui';

const SECTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: 'camera', label: 'Camera', icon: 'camera' },
  { id: 'recognition', label: 'Recognition', icon: 'sparkle' },
  { id: 'speech', label: 'Speech', icon: 'speaker' },
  { id: 'captions', label: 'Captions', icon: 'captions' },
  { id: 'notes', label: 'Notes', icon: 'notes' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard' },
  { id: 'about', label: 'About', icon: 'info' },
];

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} className="settings-section" aria-labelledby={`settings-${id}-title`}>
      <header className="settings-section-head">
        <h3 id={`settings-${id}-title`}>{title}</h3>
        <p>{description}</p>
      </header>
      <div className="settings-card">{children}</div>
    </section>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value">{children}</span>
    </div>
  );
}

export function SettingsScreen() {
  const { camera, cameraOn, mirrored, setMirrored, session, speech, captions, notes, captureToNotes, setCaptureToNotes, updateSettings, info } =
    useSignFlow();
  const { settings } = session.state;
  const contentRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(SECTIONS[0]!.id);

  // Highlight the section whose heading is nearest the top of the scroll pane.
  const onScroll = () => {
    const pane = contentRef.current;
    if (!pane) return;
    const top = pane.getBoundingClientRect().top + 96;
    let current = SECTIONS[0]!.id;
    for (const s of SECTIONS) {
      const el = document.getElementById(`settings-${s.id}`);
      if (el && el.getBoundingClientRect().top <= top) current = s.id;
    }
    if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1]!.id;
    setActive(current);
  };

  const jump = (id: string) => {
    setActive(id);
    const el = document.getElementById(`settings-${id}`);
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    el?.querySelector<HTMLElement>('button, select, input')?.focus({ preventScroll: true });
  };

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`settings-nav-item ${active === s.id ? 'is-active' : ''}`}
            aria-current={active === s.id ? 'location' : undefined}
            onClick={() => jump(s.id)}
          >
            <Icon name={s.icon} size={16} />
            {s.label}
          </button>
        ))}
      </nav>

      <div className="settings-content" ref={contentRef} onScroll={onScroll}>
        <Section id="camera" title="Camera" description="Choose a camera and how the preview looks.">
          <div className="setting-line">
            <span className="setting-line-text">
              <span className="setting-line-label">Status</span>
              <StatusPill tone={cameraOn ? 'live' : 'neutral'} pulse={cameraOn}>
                {cameraOn ? 'Camera on' : camera.status === 'error' ? 'Unavailable' : 'Camera off'}
              </StatusPill>
            </span>
            {cameraOn ? (
              <Button icon="cameraOff" onClick={camera.stop}>
                Stop camera
              </Button>
            ) : (
              <Button variant="primary" icon="camera" onClick={() => void camera.start()}>
                Start camera
              </Button>
            )}
          </div>
          {camera.devices.length > 0 ? (
            <SelectField
              label="Camera device"
              value={camera.deviceId ?? camera.devices[0]?.deviceId ?? ''}
              options={camera.devices.map((d) => ({ value: d.deviceId, label: d.label }))}
              onChange={camera.selectDevice}
            />
          ) : (
            <p className="subtle">No cameras listed yet. Start the camera once to grant access.</p>
          )}
          <Switch checked={mirrored} onChange={setMirrored} label="Mirror preview" description="Show yourself as in a mirror. Recognition is unaffected." />
        </Section>

        <Section id="recognition" title="Recognition" description="How signs become a draft.">
          <RangeField
            label="Minimum confidence"
            value={settings.minConfidence}
            min={SETTINGS_LIMITS.minConfidence[0]}
            max={SETTINGS_LIMITS.minConfidence[1]}
            step={0.05}
            format={formatPercent}
            description="Signs below this are shown in Workspace but left out of the sentence."
            onChange={(minConfidence) => updateSettings({ minConfidence })}
          />
          <RangeField
            label="Pause before translating"
            value={settings.pauseMs}
            min={SETTINGS_LIMITS.pauseMs[0]}
            max={SETTINGS_LIMITS.pauseMs[1]}
            step={100}
            format={(ms) => `${(ms / 1000).toFixed(1)} s`}
            description="How long to wait after the last sign before drafting English."
            onChange={(pauseMs) => updateSettings({ pauseMs })}
          />
          <InfoRow label="Recognizer">
            {session.recognizerName} <span className="tag">demo</span>
          </InfoRow>
          <InfoRow label="Translator">
            {session.translatorName} <span className="tag">demo</span>
          </InfoRow>
        </Section>

        <Section id="speech" title="Speech" description="Voice for confirmed text.">
          <SpeechSettings speech={speech} autoSpeak={settings.autoSpeak} onAutoSpeakChange={(autoSpeak) => updateSettings({ autoSpeak })} />
        </Section>

        <Section id="captions" title="Floating captions" description="An always-on-top caption bar for calls and presentations.">
          <Switch
            checked={captions.visible}
            onChange={() => void captions.toggle()}
            label="Show floating captions"
            description="Stays above other apps, including full-screen video calls."
          />
          <div className="settings-grid-2">
            <RangeField
              label="Text size"
              value={captions.settings.fontSize}
              min={CAPTION_LIMITS.fontSize[0]}
              max={CAPTION_LIMITS.fontSize[1]}
              step={2}
              format={(v) => `${v}px`}
              onChange={(fontSize) => captions.update({ fontSize })}
            />
            <RangeField
              label="Background"
              value={captions.settings.opacity}
              min={CAPTION_LIMITS.opacity[0]}
              max={CAPTION_LIMITS.opacity[1]}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(opacity) => captions.update({ opacity })}
            />
          </div>
          <SelectField
            label="Lines on screen"
            value={captions.settings.maxLines}
            options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: `${n} line${n > 1 ? 's' : ''}` }))}
            onChange={(maxLines) => captions.update({ maxLines })}
          />
          <Switch
            checked={captions.settings.showLive}
            onChange={(showLive) => captions.update({ showLive })}
            label="Show in-progress text"
            description="Display the pending draft or current signs below confirmed lines."
          />
        </Section>

        <Section id="notes" title="Notes" description="Capture confirmed sentences into notes.">
          <Switch
            checked={captureToNotes}
            onChange={setCaptureToNotes}
            label="Capture confirmed sentences"
            description="Every Confirm or Speak also adds the sentence to the open note."
          />
          <Switch checked={notes.state.timestamps} onChange={notes.setTimestamps} label="Timestamps" description="Prefix captured lines with the time." />
        </Section>

        <Section id="shortcuts" title="Keyboard shortcuts" description="Everything on the Live screen works from the keyboard.">
          {(['Draft', 'Navigate', 'View'] as const).map((group) => (
            <div key={group} className="shortcut-group">
              <h4 className="eyebrow">{group}</h4>
              <dl className="shortcut-list">
                {SHORTCUTS.filter((sc) => sc.group === group).map((sc) => (
                  <div key={sc.id} className="shortcut-row">
                    <dt>{sc.label}</dt>
                    <dd>
                      <Kbd combo={sc.combo} />
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </Section>

        <Section id="about" title="About" description="Versions, data, and privacy.">
          <InfoRow label="App">
            <span data-testid="app-info">
              {info ? `${info.name} v${info.version} · Electron ${info.electron} · ${info.platform}` : 'Loading…'}
            </span>
          </InfoRow>
          <InfoRow label="Adapters">Mock ML and backend (demo mode)</InfoRow>
          <InfoRow label="Backend contract">
            {CONTRACT_GENERATED ? `Official schema (OpenAPI ${CONTRACT_OPENAPI_VERSION ?? ''})` : 'Waiting for the official backend schema'}
          </InfoRow>
          <ul className="privacy-list">
            <li>
              <Icon name="shield" size={15} /> Nothing is spoken or saved until you confirm it. Captions show unconfirmed text only if “Show in-progress text” is on.
            </li>
            <li>
              <Icon name="shield" size={15} /> Notes and settings are stored only on this device.
            </li>
            <li>
              <Icon name="shield" size={15} /> The app runs sandboxed, with camera access only.
            </li>
          </ul>
        </Section>
      </div>
    </div>
  );
}
