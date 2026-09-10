interface Props {
  onContinue: () => void;
  onCancel: () => void;
}

export function PublicProxyWarningDialog({ onContinue, onCancel }: Props): JSX.Element {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="public-proxy-warning-title">
      <div className="modal">
        <h2 id="public-proxy-warning-title">Public proxies are untrusted</h2>
        <p>They may be slow, unstable, monitored, or malicious.</p>
        <p>Do not use untrusted proxies for sensitive accounts or private information.</p>
        <p>
          A proxy does not guarantee anonymity or security. Traffic may be observable by the proxy operator. You can
          disable public providers at any time and use only imported or private proxies.
        </p>
        <div className="modal__actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="btn-primary" onClick={onContinue}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
