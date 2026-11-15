import { useEffect } from 'react';
import type { Notice } from '../app/useSignFlow';
import { Icon } from '../ui';

/** Non-blocking notices, such as the cloud voice falling back to the system voice. */
export function NoticeToast({ notice, onDone }: { notice: Notice | null; onDone: () => void }) {
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(onDone, 5000);
    return () => clearTimeout(t);
  }, [notice, onDone]);

  return (
    <div className="notice-region" role="status" aria-live="polite">
      {notice && (
        <div key={notice.id} className="toast toast-notice" data-testid="notice-toast">
          <span className="toast-icon is-warning">
            <Icon name="info" size={15} />
          </span>
          <span className="toast-text">{notice.message}</span>
        </div>
      )}
    </div>
  );
}
