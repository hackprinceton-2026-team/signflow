import { useRef, useState, type ReactNode } from 'react';
import { CAPTION_LIMITS } from '@shared/captions';
import { CONTRACT_GENERATED, CONTRACT_OPENAPI_VERSION } from '../contract';
import { useSignFlow } from '../app/useSignFlow';
import { SpeechSettings, type CloudSpeechStatus } from '../components/SpeechSettings';
import { SETTINGS_LIMITS } from '../state/session';
import { SHORTCUTS } from '../app/shortcuts';
import type { BackendHealth } from '../hooks/useBackendHealth';
import { Button, formatPercent, Icon, Kbd, RangeField, Segmented, SelectField, StatusPill, Switch, type IconName, type StatusTone } from '../ui';

const SECTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: 'camera', label: 'Camera', icon: 'camera' },
  { id: 'connection', label: 'Connection', icon: 'cloud' },
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

const BACKEND_STATUS: Record<BackendHealth['status'], { label: string; tone: StatusTone }> = {
  disabled: { label: 'Not used in demo mode', tone: 'neutral' },
  checking: { label: 'Checking…', tone: 'warning' },
  online: { label: 'Online', tone: 'success' },
  degraded: { label: 'Translation not configured', tone: 'warning' },
  offline: { label: 'Offline', tone: 'danger' },
};

function BackendStatus({ health, baseUrl, cloudVoice }: { health: BackendHealth; baseUrl: string; cloudVoice: boolean }) {
  const s = BACKEND_STATUS[health.status];
  const speechMissing = cloudVoice && health.health?.speech === 'not_configured';
  return (
    <div className="backend-status" data-testid="backend-status">
      <div className="setting-line">
        <span className="setting-line-text">
          <span className="setting-line-label">SignFlow backend</span>
          <StatusPill tone={s.tone} pulse={health.status === 'checking'}>
            {s.label}
          </StatusPill>
        </span>
        <Button size="sm" icon="retry" onClick={() => void health.check()}>
          Check again
        </Button>
      </div>
      <p className="subtle mono backend-url">{baseUrl}</p>
      {health.status === 'offline' && (
        <p className="backend-hint">
          {health.error} Start it with <code>cd backend &amp;&amp; uvicorn main:app</code>.
        </p>
      )}
      {health.status === 'degraded' && (
        <p className="backend-hint">
          The backend is running, but translation needs a Gemini key: add <code>GOOGLE_API_KEY</code> to{' '}
          <code>backend/.env</code> and restart it.
        </p>
      )}
      {speechMissing && (
        <p className="backend-hint">The cloud voice needs AWS credentials on the backend; the system voice is used instead.</p>
      )}
      {health.health && health.status === 'online' && (
        <p className="subtle">
          {health.health.model} · API v{health.health.version} · speech{' '}
          {health.health.speech === 'ready' ? `ready (Polly ${health.health.speech_engine})` : 'not configured'}
        </p>
      )}
    </div>
  );
}

function cloudSpeechStatus(health: BackendHealth): CloudSpeechStatus {
  if (health.status === 'offline') return 'offline';
  return health.health?.speech ?? 'unknown';
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
  const {
    camera,
    cameraOn,
    mirrored,
    setMirrored,
    session,
    speech,
    captions,
    notes,
    captureToNotes,
    setCaptureToNotes,
    updateSettings,
    info,
    connection,
    updateConnection,
    live,
    backend,
    deviceEngine,
    setDeviceEngine,
    kokoro,
    recognition,
    recognizerSettings,
    updateRecognizerSettings,
    aslAvailable,
  } = useSignFlow();
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
          {recognition.external ? (
            <p className="backend-hint" data-testid="camera-external-note">
              The SignFlow ASL recognizer uses the camera itself (its own window shows the preview), so SignFlow doesn&apos;t
              open it while that recognizer is selected: one camera session, one camera permission.
            </p>
          ) : (
          <>
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
          </>
          )}
        </Section>

        <Section
          id="connection"
          title="Connection"
          description="Demo runs entirely on this device. Live uses the SignFlow backend for AI translation."
        >
          <Segmented
            label="Mode"
            value={connection.mode}
            options={[
              { value: 'demo', label: 'Demo' },
              { value: 'live', label: 'Live (SignFlow AI)' },
            ]}
            onChange={(mode) => updateConnection({ mode })}
          />
          <p className="subtle">
            {live
              ? 'English drafts come from the SignFlow backend (Gemini). Signs still come from the demo recognizer until the ML model is connected.'
              : 'Mock recognizer and translator: no network, no AI service. Good for trying the app.'}
          </p>
          {live && <BackendStatus health={backend.health} baseUrl={backend.client.baseUrl} cloudVoice={connection.voice === 'cloud'} />}
          <Segmented
            label="Translation context"
            value={connection.context}
            disabled={!live}
            options={[
              { value: 'chat', label: 'Everyday' },
              { value: 'medical', label: 'Medical' },
              { value: 'emergency', label: 'Emergency' },
            ]}
            onChange={(context) => updateConnection({ context })}
          />
          <Segmented
            label="Voice"
            value={connection.voice}
            disabled={!live}
            options={[
              { value: 'system', label: 'System voice' },
              { value: 'cloud', label: 'Cloud voice' },
            ]}
            onChange={(voice) => updateConnection({ voice })}
          />
          <p className="subtle">
            The cloud voice (Amazon Polly Generative, through the backend) falls back to the on-device voice (system or
            Kokoro, chosen under Speech) if it&apos;s unavailable. Either way, only text you confirm is spoken.
          </p>
        </Section>

        <Section id="recognition" title="Recognition" description="How signs become a draft.">
          {aslAvailable && (
            <>
              <Segmented
                label="Sign recognizer"
                value={recognizerSettings.source}
                options={[
                  { value: 'demo', label: 'Demo (simulated)' },
                  { value: 'asl', label: 'SignFlow ASL model (local)' },
                ]}
                onChange={(source) => updateRecognizerSettings({ source })}
              />
              {recognizerSettings.source === 'asl' ? (
                <div className="recognizer-help" data-testid="asl-help">
                  <p className="subtle">
                    Isolated ASL signs from Umar&apos;s recognizer (MediaPipe + a small classifier), running as a separate local
                    app that owns the camera. Start it first: <code>python src/live.py --keyword</code> in <code>ml/</code> (see{' '}
                    <code>docs/asl-recognizer.md</code>). SignFlow connects to it on this device only (
                    <code>ws://127.0.0.1:8765</code>).
                  </p>
                  <p className="subtle">
                    With <code>--keyword</code> it recognizes 116 signs (listed in <code>ml/models/vocab_116.json</code>) and
                    sends its top five guesses for each one. Without it, it runs the smaller 14-sign model: BATHROOM, DOCTOR,
                    DRINK, FOOD, HELP, HUNGRY, NO, PLEASE, READY, SORRY, STOP, THANK-YOU, THIRSTY and YES. Anything else comes
                    out as the closest known sign, or nothing. Confidence is the model&apos;s estimate, not a guarantee; you
                    always review the English before it&apos;s spoken.
                  </p>
                  <Switch
                    checked={recognizerSettings.allowKeyword}
                    onChange={(allowKeyword) => updateRecognizerSettings({ allowKeyword })}
                    label="Allow the 116-sign keyword model"
                    description="On by default (start the recognizer with --keyword). On unseen signers its top sign is right about 75% of the time and the right sign is in its top five about 91% of the time; unknown gestures still come out as a sign. Signs it isn't confident about are shown with their alternatives but never used. Turn this off to accept only the 14-sign model."
                  />
                </div>
              ) : (
                <p className="subtle">
                  The demo recognizer plays scripted signs while the camera runs; it doesn&apos;t read your signing.
                </p>
              )}
            </>
          )}
          <RangeField
            label="Minimum confidence"
            value={settings.minConfidence}
            min={SETTINGS_LIMITS.minConfidence[0]}
            max={SETTINGS_LIMITS.minConfidence[1]}
            step={0.05}
            format={formatPercent}
            description={`Signs below this are shown in Workspace but left out of the sentence.${
              session.recognizerSimulated ? ' The demo recognizer’s confidence is simulated.' : ''
            }`}
            onChange={(minConfidence) => updateSettings({ minConfidence })}
          />
          <RangeField
            label="Pause before translating"
            value={settings.pauseMs}
            min={SETTINGS_LIMITS.pauseMs[0]}
            max={SETTINGS_LIMITS.pauseMs[1]}
            step={100}
            format={(ms) => `${(ms / 1000).toFixed(1)} s`}
            description={
              recognition.external
                ? 'With the ASL model, a draft starts when the recognizer reports the end of the sentence (hands down for 1.5 s).'
                : 'How long to wait after the last sign before drafting English.'
            }
            onChange={(pauseMs) => updateSettings({ pauseMs })}
          />
          <InfoRow label="Recognizer">
            {session.recognizerName}{' '}
            <span className="tag" data-testid="recognizer-tag">
              {session.recognizerSimulated ? 'simulated signs' : 'model'}
            </span>
          </InfoRow>
          <InfoRow label="Translator">
            {session.translatorName}{' '}
            <span className="tag" data-testid="translator-tag">
              {session.translatorSource === 'ai' ? 'Gemini' : 'demo rules'}
            </span>
          </InfoRow>
        </Section>

        <Section id="speech" title="Speech" description="Voice for confirmed text.">
          <SpeechSettings
            speech={speech}
            autoSpeak={settings.autoSpeak}
            onAutoSpeakChange={(autoSpeak) => updateSettings({ autoSpeak })}
            cloudVoice={live && connection.voice === 'cloud'}
            cloudStatus={cloudSpeechStatus(backend.health)}
            platform={info?.platform}
            engine={deviceEngine}
            onEngineChange={setDeviceEngine}
            kokoro={kokoro.available ? kokoro : undefined}
          />
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
          <InfoRow label="Adapters">
            {live ? 'Live: SignFlow AI translation · demo recognizer' : 'Demo: mock recognizer and translator'}
          </InfoRow>
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
              <Icon name="shield" size={15} /> The Kokoro voice runs entirely on this device; its engine is blocked from the network.
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
