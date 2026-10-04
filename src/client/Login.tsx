import { useState } from 'react';
import { passwordProblem, passwordRules, type AuthUser } from '../shared/auth';
import { api } from './api';
import { Mascot } from './Mascot';

export function LoginScreen({
  onSignedIn,
  notice,
}: {
  onSignedIn: (user: AuthUser) => void;
  notice?: string;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <main className="unlock">
      <Mascot />
      <h1>Your own little corner.</h1>
      <p>{notice ?? 'Sign in to OpenDots.'}</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const { user } = await api<{ user: AuthUser }>(
              '/auth/login',
              'POST',
              { username, password },
            );
            setPassword('');
            onSignedIn(user);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Sign-in failed.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          aria-label="Username"
          placeholder="Username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <input
          type="password"
          aria-label="Password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button className="primary" disabled={busy}>
          Sign in
        </button>
      </form>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}

export function ChangePasswordScreen({
  username,
  forced,
  onChanged,
  onCancel,
}: {
  username: string;
  forced: boolean;
  onChanged: (user: AuthUser) => void;
  onCancel: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <main className="unlock">
      <Mascot />
      <h1>{forced ? 'Choose a new password' : 'Change password'}</h1>
      <p>
        {forced
          ? 'You are using the initial password. Choose a new one to continue.'
          : `Signed in as ${username}.`}{' '}
        {passwordRules}
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const problem =
            next !== confirm
              ? 'The new passwords do not match.'
              : passwordProblem(next, username);
          if (problem) return setError(problem);
          setBusy(true);
          setError('');
          try {
            const { user } = await api<{ user: AuthUser }>(
              '/auth/password',
              'POST',
              { currentPassword: current, newPassword: next },
            );
            onChanged(user);
          } catch (err) {
            setError(
              err instanceof Error ? err.message : 'Could not change password.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          type="hidden"
          autoComplete="username"
          value={username}
          readOnly
        />
        <input
          type="password"
          aria-label="Current password"
          placeholder="Current password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
        <input
          type="password"
          aria-label="New password"
          placeholder="New password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
        <input
          type="password"
          aria-label="Confirm new password"
          placeholder="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        <button className="primary" disabled={busy}>
          Save password
        </button>
        <button type="button" onClick={onCancel}>
          {forced ? 'Sign out' : 'Cancel'}
        </button>
      </form>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
