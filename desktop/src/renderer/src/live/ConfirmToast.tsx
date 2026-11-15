import { useEffect } from 'react';
import type { ConfirmFeedback } from '../app/useSignFlow';
import { Icon } from '../ui';

/** Brief confirmation of what just happened to the confirmed text. */
export function ConfirmToast({ feedback, onDone }: { feedback: ConfirmFeedback | null; onDone: () => void }) {
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [feedback, onDone]);

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {feedback && (
        <div key={feedback.id} className="toast" data-testid="confirm-toast">
          <span className={`toast-icon ${feedback.spoken ? 'is-spoken' : ''}`}>
            <Icon name={feedback.spoken ? 'speaker' : 'check'} size={15} />
          </span>
          <span className="toast-text">
            <strong>{feedback.spoken ? 'Spoken' : 'Confirmed'}</strong>
            {feedback.noted && <span className="toast-sub"> · saved to notes</span>}
          </span>
        </div>
      )}
    </div>
  );
}
